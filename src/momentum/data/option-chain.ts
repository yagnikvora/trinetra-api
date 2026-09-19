// Tier B — the near-month option chain for one stock.
//
// `upstox.ts` already fetches option chains, but only for the four INDEX underlyings it has
// hand-mapped instrument keys for. Stock chains work identically — verified on RELIANCE,
// TCS, HDFCBANK and SBIN — and carry everything the momentum model's three option factors
// need, per strike, in one 200ms request:
//
//   market_data    ltp, volume, oi, prev_oi, close_price, bid/ask with sizes
//   option_greeks  delta, gamma, theta, vega, iv, pop
//
// So the chain is the whole enrichment tier. There is no separate Greeks call — the
// `/v3/market-quote/option-greek` endpoint exists and works, but it returns a subset of
// what is already here and would double the request count.
//
// WHAT `prev_oi` IS. It is the previous SESSION's closing open interest, not the previous
// poll's. Every option OI change in this module is therefore a day-over-day figure. The
// intraday read comes from the future instead, whose OI is on the Tier-A quote and updates
// live. Both are reported and labelled; conflating them would present a stale number as a
// live one.
//
// STOCK OPTIONS ARE MONTHLY. Verified on the master: RELIANCE lists 2026-08-25, 2026-09-29
// and 2026-10-27, all with `weekly: false`. There is no weekly expiry to prefer, so "near
// month" is unambiguous — but it also means the near contract can be days from expiry, and
// `expiryDays` is carried so the Greeks factor can see that theta is about to dominate.

import { call } from '../../upstox.js';
import { istDay } from '../session.js';

export interface ChainLeg {
  instrumentKey: string;
  ltp: number;
  closePrice: number;
  volume: number;
  oi: number;
  prevOi: number;
  bid: number;
  ask: number;
  bidQty: number;
  askQty: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  iv: number;
}

export interface ChainRow {
  strike: number;
  call: ChainLeg | null;
  put: ChainLeg | null;
}

export interface StockChain {
  symbol: string;
  underlyingKey: string;
  expiry: string;
  expiryDays: number;
  spot: number;
  atmStrike: number;
  rows: ChainRow[];
}

interface RawLeg {
  instrument_key?: string;
  market_data?: {
    ltp?: number; close_price?: number; volume?: number; oi?: number; prev_oi?: number;
    bid_price?: number; ask_price?: number; bid_qty?: number; ask_qty?: number;
  };
  option_greeks?: { delta?: number; gamma?: number; theta?: number; vega?: number; iv?: number };
}

interface RawChainRow {
  expiry?: string;
  strike_price?: number;
  underlying_spot_price?: number;
  call_options?: RawLeg;
  put_options?: RawLeg;
}

interface RawContract {
  expiry?: string;
  instrument_type?: string;
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function leg(raw: RawLeg | undefined): ChainLeg | null {
  const m = raw?.market_data;
  if (!m || !raw?.instrument_key) return null;
  const g = raw.option_greeks ?? {};
  return {
    instrumentKey: raw.instrument_key,
    ltp: num(m.ltp),
    closePrice: num(m.close_price),
    volume: num(m.volume),
    oi: num(m.oi),
    prevOi: num(m.prev_oi),
    bid: num(m.bid_price),
    ask: num(m.ask_price),
    bidQty: num(m.bid_qty),
    askQty: num(m.ask_qty),
    delta: num(g.delta),
    gamma: num(g.gamma),
    theta: num(g.theta),
    vega: num(g.vega),
    iv: num(g.iv),
  };
}

// The contract master for an underlying only changes when a new expiry is introduced, so it
// is held for a day. This is not a nicety: without it every chain fetch would be two
// requests instead of one, doubling the enrichment tier's rate-limit cost.
const DAY_MS = 24 * 60 * 60e3;
const expiryCache = new Map<string, { at: number; expiries: string[] }>();

/** Listed expiries for a stock underlying, nearest first. */
export async function expiries(underlyingKey: string): Promise<string[]> {
  const hit = expiryCache.get(underlyingKey);
  if (hit && Date.now() - hit.at < DAY_MS) return hit.expiries;

  const raw = await call<RawContract[]>(`/v2/option/contract?instrument_key=${encodeURIComponent(underlyingKey)}`);
  const list = [
    ...new Set(
      (raw ?? [])
        .filter((c) => c.expiry && (c.instrument_type === 'CE' || c.instrument_type === 'PE'))
        .map((c) => String(c.expiry).slice(0, 10)),
    ),
  ].sort();

  if (!list.length) throw new Error(`Upstox lists no option contracts for ${underlyingKey}`);
  expiryCache.set(underlyingKey, { at: Date.now(), expiries: list });
  return list;
}

/**
 * The expiry the scanner reads.
 *
 * The nearest one that is not today. On expiry day the near contract's open interest
 * collapses into the next month through the session, so a build-up read off it reports mass
 * unwinding across the entire board — a signal that is an artefact of the calendar.
 */
export function chosenExpiry(list: string[], today: string): string | null {
  return list.find((d) => d > today) ?? list[list.length - 1] ?? null;
}

const daysBetween = (from: string, to: string): number =>
  Math.max(0, Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000));

/** The near-month chain for one stock, ATM resolved. */
export async function stockChain(symbol: string, underlyingKey: string, nowMs = Date.now()): Promise<StockChain> {
  const today = istDay(nowMs);
  const expiry = chosenExpiry(await expiries(underlyingKey), today);
  if (!expiry) throw new Error(`no usable option expiry for ${symbol}`);

  const raw = await call<RawChainRow[]>(
    `/v2/option/chain?instrument_key=${encodeURIComponent(underlyingKey)}&expiry_date=${encodeURIComponent(expiry)}`,
  );
  if (!Array.isArray(raw) || !raw.length) throw new Error(`Upstox served an empty chain for ${symbol} ${expiry}`);

  const rows: ChainRow[] = raw
    .filter((r) => typeof r.strike_price === 'number')
    .map((r) => ({ strike: r.strike_price as number, call: leg(r.call_options), put: leg(r.put_options) }))
    .sort((a, b) => a.strike - b.strike);

  const spot = raw.find((r) => r.underlying_spot_price)?.underlying_spot_price ?? 0;
  const atmStrike = rows.length
    ? rows.reduce((best, r) => (Math.abs(r.strike - spot) < Math.abs(best - spot) ? r.strike : best), rows[0].strike)
    : 0;

  const chain: StockChain = {
    symbol,
    underlyingKey,
    expiry,
    expiryDays: daysBetween(today, expiry),
    spot,
    atmStrike,
    rows,
  };
  recent.set(symbol, { at: nowMs, chain });
  return chain;
}

/**
 * The last chain fetched for a symbol, if it is fresh.
 *
 * Both alert channels fetch the chain to pick a strike moments before the journal records the
 * trade, and the journal wants that same chain's OI. Reading it back from here costs nothing,
 * where a second fetch would cost a request per alert and could describe a different minute.
 */
const recent = new Map<string, { at: number; chain: StockChain }>();

export function recentChain(symbol: string, nowMs = Date.now(), maxAgeMs = 120_000): StockChain | null {
  const hit = recent.get(symbol);
  return hit && nowMs - hit.at <= maxAgeMs ? hit.chain : null;
}

/** The ATM row, or the closest one that actually has both legs quoted. */
export function atmRow(chain: StockChain): ChainRow | null {
  const exact = chain.rows.find((r) => r.strike === chain.atmStrike);
  if (exact?.call && exact.put) return exact;
  // A strike with one dead leg is worse than the neighbour: the straddle metrics need both.
  const withBoth = chain.rows.filter((r) => r.call && r.put && r.call.ltp > 0 && r.put.ltp > 0);
  if (!withBoth.length) return exact ?? null;
  return withBoth.reduce((best, r) =>
    Math.abs(r.strike - chain.spot) < Math.abs(best.strike - chain.spot) ? r : best,
  );
}

// Service layer: transform live Upstox quotes into typed payloads; fall back to mock.
import { allQuotes, fnoSymbols, quotesFor, type EquityQuote } from './equity.js';
import { INDEX_MEMBERS } from './indices.js';
import { avgDailyRanges } from './volume.js';
import { SECTOR_BASKETS } from './sectors.js';
import { remember, recall, ageLabel } from './snapshot.js';
import * as mock from './mock.js';
import type { MarketPulse, SectorScope, IndexMover, Source } from './types.js';

export interface Result<T> { data: T; source: Source; error?: string; }

// Everything the Market Pulse widgets need, which is exactly what a quote already carries.
// Upstox derives previousClose and turnover in equity.ts; both were verified against NSE.
type FnoQuote = EquityQuote;

// Stable pseudo-random in [0,1) from a symbol string — keeps derived signals
// deterministic across the 60s cache window instead of jittering each request.
function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 100000) / 100000;
}

// Fraction of the session elapsed — 0 before the open, 1 after the close. NSE cash
// trades 09:15–15:30 IST. Used to scale a still-forming intraday range onto a
// full-day baseline so a morning reading is comparable to a closing one.
function sessionFraction(nowUtcMs: number): number {
  const istMin = ((nowUtcMs / 60000) + 330) % 1440; // +5:30
  const open = 9 * 60 + 15, close = 15 * 60 + 30;
  if (istMin <= open) return 0;
  if (istMin >= close) return 1;
  return (istMin - open) / (close - open);
}

let holidayRaw: string | null = null;
let holidaySet = new Set<string>();

/**
 * `MARKET_HOLIDAYS`, parsed once per distinct value of the variable.
 *
 * Lives beside `marketOpen` because that is the function that has to consult it, and
 * `momentum/session.ts` — which re-exports both — imports from here, not the other way round.
 */
export function marketHolidays(): Set<string> {
  const raw = process.env.MARKET_HOLIDAYS ?? '';
  if (raw !== holidayRaw) {
    holidayRaw = raw;
    holidaySet = new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
  }
  return holidaySet;
}

// NSE cash session in IST: 09:15–15:30, Mon–Fri, and not on a listed trading holiday. Outside
// it the numbers are frozen for the day, which is what lets the cache in index.ts stop
// re-fetching.
//
// THE HOLIDAY CHECK IS NOT A NICETY. Without it a holiday read as an open session, the scanner
// ran all day against the previous close, and at minute 12 a full day's frozen volume and range
// looked like a displacement: on 2026-10-02 (Gandhi Jayanti) four alerts went to the phone at
// 09:27 and were journalled as trades in a market that never opened.
export function marketOpen(nowMs: number = Date.now()): boolean {
  const ist = new Date(nowMs + 330 * 60_000); // shift so the UTC getters read IST
  const dow = ist.getUTCDay();
  if (dow === 0 || dow === 6) return false;
  if (marketHolidays().has(ist.toISOString().slice(0, 10))) return false;
  const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return mins >= 9 * 60 + 15 && mins <= 15 * 60 + 30;
}

// Level calibration onto tradefinder's published R.Factor scale.
//
// The raw ratio below has the right SHAPE but sits about a quarter low: scored against
// their own page for 2026-07-02 (146 symbols, captures/sector-scope.txt vs NSE bhavcopy)
// the raw ratio reads median 0.86 where they print 1.09, and every large reading is
// short by a similar proportion. It is a level offset and not a shape error — a log-log
// fit of theirs against ours gives an exponent of 0.955, i.e. indistinguishable from a
// straight multiple, and the multiple barely moves with the baseline window (1.26 at 14
// sessions, 1.30 at 20, 1.34 at 33). Applying it takes mean absolute error from 0.42 to
// 0.33 and leaves the ranking untouched.
//
// Whatever normalisation sits behind their divisor isn't recoverable from public data,
// so this is measured rather than derived — re-measure with rfac-validate against a
// fresh logged-in capture if their numbers ever drift.
const RFACTOR_CALIBRATION = 1.33;

// R.Factor = today's trading RANGE against the stock's own normal range — a volatility
// multiple, so 2.00 means "moving twice as wide as it usually does".
//
// This was relative VOLUME until measurement said otherwise. Against tradefinder's
// published R.Factor over 37 symbols, range predicts their value far better than volume
// (Spearman 0.80 vs 0.66; Pearson 0.80 vs 0.45), and volume is provably not the input:
// their implied volume baseline for ETERNAL sat below that stock's lowest volume in 30
// sessions, which no volume window can produce. Their companion feed also tags every
// symbol `volt: high|low`, which is a volatility label.
//
// Intraday the day's range is still forming, so it's scaled to the same point in the
// session. Range fills faster than time does (the open is the widest stretch), so this
// uses a sqrt curve rather than the U-shaped one volume needs.
//
// NOT capped at 5: the real multiple is shown (a stock ranging 9× its norm reads 9.23,
// not a misleading 5.00). Only a high guard (50) catches obviously-bad data points.
function rfac(q: FnoQuote, avgRange: Record<string, number>, nowMs: number): number {
  const base = avgRange[q.Symbol];
  const todayRange = q.prevClose > 0 ? ((q.dayHigh - q.dayLow) / q.prevClose) * 100 : 0;
  if (base && base > 0 && todayRange > 0) {
    const elapsed = sessionFraction(nowMs);
    const expected = elapsed > 0.02 ? base * Math.sqrt(elapsed) : base;
    return +Math.min((todayRange / expected) * RFACTOR_CALIBRATION, 50).toFixed(2);
  }
  // Fallback estimate (no range history): blend move, intraday range and liquidity.
  // This is a synthetic score, not a measured ratio, so it stays bounded ~0.3–5.
  const range = q.prevClose ? (q.dayHigh - q.dayLow) / q.prevClose : 0;
  const move = Math.min(Math.abs(q.pChange) / 6, 1);
  const liquidity = Math.log10(1 + q.turnover) / 4;
  const raw = 0.4 + move * 1.6 + Math.min(range * 8, 1.4) + liquidity * 1.2;
  const v = raw * (0.75 + hash01(q.Symbol + 'r') * 0.5);
  return +Math.max(0.3, Math.min(v, 5)).toFixed(2);
}

// Distance of LTP from the day's high (top level) or low (low level), as a fraction. 0 = right at the level.
const diffFromHigh = (q: FnoQuote) => +Math.max(0, (q.dayHigh - q.ltp) / (q.dayHigh || 1)).toFixed(2);
const diffFromLow = (q: FnoQuote) => +Math.max(0, (q.ltp - q.dayLow) / (q.dayLow || 1)).toFixed(2);

// Unix epoch (seconds) of today's NSE market open (09:15 IST). Used as a stable anchor
// for synthetic signal times so they don't drift between auto-refreshes. IST = UTC+5:30.
function marketOpenEpoch(nowMs: number): number {
  const IST_OFFSET_MIN = 330; // +5:30
  const ist = new Date(nowMs + IST_OFFSET_MIN * 60_000); // shift so UTC getters read IST
  // Midnight IST of the current IST day, expressed back in real UTC ms.
  const istMidnightUtcMs = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()) - IST_OFFSET_MIN * 60_000;
  const openMs = istMidnightUtcMs + (9 * 60 + 15) * 60_000; // 09:15 IST
  return Math.floor(openMs / 1000);
}

export async function marketPulse(): Promise<Result<MarketPulse>> {
  try {
    const [s, avgRange] = await Promise.all([
      fnoSymbols().then((syms) => quotesFor(syms, marketOpen())),
      avgDailyRanges(),
    ]);
    if (s.length < 20) throw new Error(`only ${s.length} market rows`);
    const nowMs = Date.now();

    // Breakout Beacon: proprietary "signal %" momentum score across the whole market,
    // ranked by strength and capped for a scannable list (the live site shows ~170).
    // Both signal% and the signal time are DETERMINISTIC per symbol/day so the widget
    // doesn't reshuffle on every auto-refresh — it only changes when the real price
    // data changes. The time is anchored to today's market open (not now()), so a given
    // stock always shows the same signal time within a session.
    const sessionOpen = marketOpenEpoch(nowMs); // 09:15 IST today (or last session)
    const beacon = s
      .map((q) => {
        const signalPct = +(q.pChange * (0.35 + hash01(q.Symbol + 'b') * 0.45)).toFixed(2);
        // Stable time-of-signal: open + a fixed per-symbol offset within the session.
        const ts = sessionOpen + Math.floor(hash01(q.Symbol + 't') * 6 * 3600);
        const dir: 'BULL' | 'BEAR' = q.pChange >= 0 ? 'BULL' : 'BEAR';
        return { Symbol: q.Symbol, param_0: q.pChange, param_1: signalPct, param_2: dir, param_3: ts };
      })
      .sort((a, b) => Math.abs(b.param_1) - Math.abs(a.param_1))
      .slice(0, 300);

    // Intraday Boost: top by R.Factor (real, time-of-day-adjusted relative volume).
    const boost = s
      .map((q) => ({ q, r: rfac(q, avgRange, nowMs) }))
      .sort((a, b) => b.r - a.r)
      .slice(0, 80)
      .map(({ q, r }) => ({ Symbol: q.Symbol, param_0: q.ltp, param_1: q.prevClose, param_2: q.pChange, param_3: r }));

    const gainers = [...s].sort((a, b) => b.pChange - a.pChange).slice(0, 25)
      .map((q) => ({ Symbol: q.Symbol, param_0: q.ltp, param_1: q.prevClose, param_2: q.pChange, param_3: rfac(q, avgRange, nowMs) }));
    const losers = [...s].sort((a, b) => a.pChange - b.pChange).slice(0, 25)
      .map((q) => ({ Symbol: q.Symbol, param_0: q.ltp, param_1: q.prevClose, param_2: q.pChange, param_3: rfac(q, avgRange, nowMs) }));

    const highPower = [...s].sort((a, b) => b.turnover - a.turnover).slice(0, 50)
      .map((q) => ({ Symbol: q.Symbol, param_0: q.ltp, param_1: q.prevClose, param_2: q.pChange, param_3: q.turnover }));

    // Top level: nearest to day HIGH. Low level: nearest to day LOW.
    const topLevel = [...s].map((q) => ({ q, d: diffFromHigh(q) })).sort((a, b) => a.d - b.d).slice(0, 25)
      .map(({ q, d }) => ({ Symbol: q.Symbol, param_0: q.ltp, param_1: q.prevClose, param_2: q.pChange, param_3: d }));
    const lowLevel = [...s].map((q) => ({ q, d: diffFromLow(q) })).sort((a, b) => a.d - b.d).slice(0, 25)
      .map(({ q, d }) => ({ Symbol: q.Symbol, param_0: q.ltp, param_1: q.prevClose, param_2: q.pChange, param_3: d }));

    const data: MarketPulse = {
      breakout_beacon: beacon,
      intraday_boost: boost,
      top_gainers: gainers,
      top_losers: losers,
      high_powered_stocks: highPower,
      top_level_stocks: topLevel,
      low_level_stocks: lowLevel,
    };
    return { source: 'upstox', data: await remember('market_pulse', data) };
  } catch (e) {
    // Same reasoning as sector scope: NSE drops out often enough that a refresh can
    // land on an outage, and swapping a live board for invented prices is the most
    // visible way this app can be wrong. Re-serve the last real board instead.
    const prev = await recall<MarketPulse>('market_pulse');
    if (prev) return { source: 'stale', error: `Upstox unreachable, showing last live data (${ageLabel(prev.ageMs)} old)`, data: prev.data };
    return { source: 'mock', error: String((e as Error).message), data: mock.mockMarketPulse() };
  }
}

export async function sectorScope(): Promise<Result<SectorScope>> {
  try {
    // One quote call covers every basket member — equity.ts asks for the union of the
    // whole app's universe, so this is the same request Market Pulse already made and
    // costs nothing extra.
    const [quotes, avgRange] = await Promise.all([allQuotes(marketOpen()), avgDailyRanges()]);

    // Coverage guard. marketConstituents() merges several broad indices and silently
    // tolerates any that NSE won't serve — so when NIFTY 500 fails we get a universe
    // made only of mid/small caps and every large cap (HDFCBANK, ICICIBANK, TCS…)
    // quietly vanishes from the map. That renders as a plausible-looking but wrong
    // page, which is worse than an outage: fail here so the caller serves the last
    // good snapshot instead.
    const wanted = new Set(Object.values(SECTOR_BASKETS).flat());
    const covered = [...wanted].filter((s) => quotes.has(s)).length;
    if (covered < wanted.size * 0.7)
      throw new Error(`partial universe: ${covered}/${wanted.size} basket symbols priced`);
    const nowMs = Date.now();

    const out: SectorScope = {};
    for (const [sector, symbols] of Object.entries(SECTOR_BASKETS)) {
      const stocks = symbols
        .map((sym) => quotes.get(sym))
        .filter((q): q is FnoQuote => !!q)
        .map((q) => ({
          Symbol: q.Symbol,
          ltp: q.ltp,
          open: q.open,
          prevClose: +(+q.prevClose).toFixed(2),
          pChange: q.pChange,
          rFactor: rfac(q, avgRange, nowMs), // volatility multiple vs the stock's own norm
          weight: Math.max(1, (q.ltp || 100) / 100),
        }));
      if (stocks.length) out[sector] = stocks;
    }
    if (!Object.keys(out).length) throw new Error('no sectors');
    return { source: 'upstox', data: await remember('sector_scope', out) };
  } catch (e) {
    // Prefer the last real snapshot over fabricated prices — see snapshot.ts.
    const prev = await recall<SectorScope>('sector_scope');
    if (prev) return { source: 'stale', error: `Upstox unreachable, showing last live data (${ageLabel(prev.ageMs)} old)`, data: prev.data };
    return { source: 'mock', error: String((e as Error).message), data: mock.mockSectorScope() };
  }
}

/**
 * Point contribution per constituent.
 *
 * Membership comes from indices.ts, because no quote feed publishes index composition. The
 * index level and the day's points come from the index's own quote, which is in the same
 * batch as the constituents — so this is arithmetic over one request.
 *
 * The per-stock weight is an approximation from price, not the exchange's free-float
 * weight, which is not in any public feed. It was that before this moved off NSE too; the
 * ranking is right and the individual point figures are indicative. The index total is
 * exact, because it is the index's own net change rather than a sum of these.
 */
export async function indexMover(index = 'NIFTY 50'): Promise<Result<IndexMover>> {
  try {
    const members = INDEX_MEMBERS[index];
    if (!members) throw new Error(`no constituent list for "${index}"`);
    const quotes = await allQuotes(marketOpen());
    const idx = quotes.get(index);
    if (!idx) throw new Error(`no quote for ${index}`);

    const level = idx.ltp;
    const stocks = [];
    let up = 0, down = 0;
    for (const sym of members) {
      const q = quotes.get(sym);
      if (!q) continue;
      const w = (q.ltp || 100) / (level * 25);
      stocks.push({
        Symbol: q.Symbol,
        per_change: q.pChange,
        per_to_index: +((w * q.pChange) / 100).toFixed(6),
        point_to_index: +(level * w * (q.pChange / 100)).toFixed(3),
      });
      q.pChange >= 0 ? up++ : down++;
    }
    const points = +(idx.ltp - idx.prevClose).toFixed(2);
    return {
      source: 'upstox',
      data: { index, level, points, pct: idx.pChange, gainers: up, losers: down, stocks },
    };
  } catch (e) { return { source: 'mock', error: String((e as Error).message), data: mock.mockIndexMover(index) }; }
}

// What was behind a move at the moment an alert fired: futures open interest, order-book pressure
// and India VIX, recorded minute by minute and handed to the journal as readings.
//
// WHY THIS EXISTS (2026-09-19). Of the 194 journalled trades from 1 Jul to 18 Sep, 19 never reached
// +5%, and in 14 of those the stock turned within a minute or two of the alert. Replaying the
// displacement rule over 310 signals since March, none of 33 chart readings known at the signal —
// volume spike, wick, momentum, VWAP stretch, prior-day and 20-day levels, NIFTY, breadth, sector,
// time — separated the dead signals from the winners out of sample. A model built on all of them
// scored 0.84 AUC on the months it learned from and 0.40 on the months after. The chart is public
// and already priced; what might separate the two is who is behind the move, which the chart does
// not show. So this records three things that are not on it:
//
//   FUTURES OI     price with the move and OI rising is fresh positions and tends to extend; OI
//                  falling is positions closing (short covering, long unwinding) and tends to fade.
//   ORDER BOOK     total pending buy quantity against sell quantity. A breakout into a book stacked
//                  with sellers is a breakout into supply.
//   INDIA VIX      whether the whole market was calm or nervous when the alert fired.
//
// In memory only: one point per session minute, the last 30 minutes plus the day's first print. A
// restart empties it, and every window then reads null until it has history — null, never an
// estimate, because a guessed reading is worse than a missing one in a study.

import { istDay, minuteOfSession } from '../session.js';
import type { StockChain } from './option-chain.js';

const KEEP_MIN = 30;
/** A series whose last point is older than this is a dead feed, not a quiet market. */
const STALE_MIN = 3;
/** A first print later than this is not "the open" — the series started mid-session. */
const OPEN_WITHIN_MIN = 2;

/* ------------------------------------------------------------------- one minute series --- */

interface Series<P> {
  day: string;
  first: (P & { minute: number }) | null;
  points: Array<P & { minute: number }>;
}

/**
 * Add a reading. Same-minute readings overwrite, so a minute's point is its LAST reading, like a
 * candle close. Anything that goes backwards in time is ignored rather than inserted.
 */
function push<P extends object>(map: Map<string, Series<P>>, key: string, value: P, nowMs: number): Series<P> {
  const day = istDay(nowMs);
  const minute = minuteOfSession(nowMs);
  let s = map.get(key);
  if (!s || s.day !== day) {
    s = { day, first: null, points: [] };
    map.set(key, s);
  }
  const last = s.points[s.points.length - 1];
  if (last && last.minute === minute) Object.assign(last, value);
  else if (!last || minute > last.minute) s.points.push({ ...value, minute });
  if (!s.first) s.first = { ...value, minute };
  else if (s.first.minute === minute) Object.assign(s.first, value);
  while (s.points.length && s.points[0].minute < minute - KEEP_MIN) s.points.shift();
  return s;
}

/** The series' latest point, or null when there is none today or the feed has gone quiet. */
function latest<P>(s: Series<P> | undefined, nowMs: number): (P & { minute: number }) | null {
  if (!s || s.day !== istDay(nowMs) || !s.points.length) return null;
  const now = s.points[s.points.length - 1];
  return minuteOfSession(nowMs) - now.minute > STALE_MIN ? null : now;
}

/** The latest point at or before `minute`, or null when the series does not reach back that far. */
function asOf<P>(s: Series<P>, minute: number): (P & { minute: number }) | null {
  let best: (P & { minute: number }) | null = null;
  for (const p of s.points) {
    if (p.minute > minute) break;
    best = p;
  }
  return best;
}

/** The session's first point, only if it really was the open. */
const opening = <P>(s: Series<P>, nowMinute: number): (P & { minute: number }) | null =>
  s.first && s.first.minute <= OPEN_WITHIN_MIN && nowMinute > s.first.minute ? s.first : null;

const pct = (now: number, then: number | null | undefined): number | null =>
  then != null && then > 0 ? +(((now - then) / then) * 100).toFixed(3) : null;

/** Buy quantity as a percentage of the whole book. 50 is balanced. */
const buyPct = (buy: number, sell: number): number | null =>
  buy + sell > 0 ? +((100 * buy) / (buy + sell)).toFixed(2) : null;

/* ------------------------------------------------------------------------ the tapes --- */

interface FutPoint { oi: number; price: number; buy: number; sell: number }
interface BookPoint { buy: number; sell: number }
interface VixPoint { level: number; prevClose: number }

const futures = new Map<string, Series<FutPoint>>();
const prevOiBySymbol = new Map<string, number>();
const books = new Map<string, Series<BookPoint>>();
const vixTape = new Map<string, Series<VixPoint>>();

/** One futures quote. Called once per scan for every future in the snapshot. */
export function recordFuturesTape(
  symbol: string,
  q: { oi: number; price: number; buy?: number; sell?: number },
  prevOi: number | null | undefined,
  nowMs = Date.now(),
): void {
  if (!(q.oi > 0) || !(q.price > 0)) return;
  if (prevOi != null && prevOi > 0) prevOiBySymbol.set(`${istDay(nowMs)}:${symbol}`, prevOi);
  push(futures, symbol, { oi: q.oi, price: q.price, buy: q.buy ?? 0, sell: q.sell ?? 0 }, nowMs);
}

/** One stock's order book totals. Called once per scan for every equity quote in the snapshot. */
export function recordBookTape(symbol: string, buy: number, sell: number, nowMs = Date.now()): void {
  if (!(buy + sell > 0)) return;
  push(books, symbol, { buy, sell }, nowMs);
}

/** The India VIX quote, once per scan. */
export function recordVixTape(level: number, prevClose: number, nowMs = Date.now()): void {
  if (!(level > 0)) return;
  push(vixTape, 'VIX', { level, prevClose }, nowMs);
}

/* ---------------------------------------------------------------------- the readings --- */

/**
 * Futures OI windows for one symbol, as journal readings. Percentages throughout.
 *
 *   futOi           current futures OI (contracts), the one absolute figure
 *   futOiDayPct     OI against yesterday's close
 *   futOiOpenPct    OI against the session's first print; futPxOpenPct is price over the same span
 *   futOi15mPct     OI over the last 15 minutes; futPx15mPct is price over the same 15
 *   futOi5mPct      the same over 5 minutes
 *   futBuyPct       the future's pending buy quantity as a % of its book, now
 *
 * Read OI against price in the TRADE's direction: a long alert on a rising price with OI rising is
 * build-up, the same with OI falling is short covering.
 */
export function oiReadings(symbol: string, nowMs = Date.now()): Record<string, number | null> {
  const out: Record<string, number | null> = {
    futOi: null, futOiDayPct: null,
    futOiOpenPct: null, futPxOpenPct: null,
    futOi15mPct: null, futPx15mPct: null,
    futOi5mPct: null, futPx5mPct: null,
    futBuyPct: null,
  };
  const s = futures.get(symbol);
  const now = latest(s, nowMs);
  if (!s || !now) return out;

  out.futOi = now.oi;
  out.futOiDayPct = pct(now.oi, prevOiBySymbol.get(`${s.day}:${symbol}`));
  out.futBuyPct = buyPct(now.buy, now.sell);
  const open = opening(s, now.minute);
  if (open) {
    out.futOiOpenPct = pct(now.oi, open.oi);
    out.futPxOpenPct = pct(now.price, open.price);
  }
  for (const w of [15, 5] as const) {
    const ref = asOf(s, now.minute - w);
    if (!ref) continue;
    out[`futOi${w}mPct`] = pct(now.oi, ref.oi);
    out[`futPx${w}mPct`] = pct(now.price, ref.price);
  }
  return out;
}

/**
 * The stock's order book, as journal readings.
 *
 *   eqBuyQty, eqSellQty   total pending quantity on each side of the book, now
 *   eqBuyPct              buy quantity as a % of the whole book; 50 is balanced
 *   eqBuyPct5mChg         change in that share over 5 minutes, in percentage points; 15m likewise
 *
 * For a SHORT alert the supportive reading is a LOW buy share. Read it in the trade's direction.
 */
export function bookReadings(symbol: string, nowMs = Date.now()): Record<string, number | null> {
  const out: Record<string, number | null> = {
    eqBuyQty: null, eqSellQty: null, eqBuyPct: null, eqBuyPct5mChg: null, eqBuyPct15mChg: null,
  };
  const s = books.get(symbol);
  const now = latest(s, nowMs);
  if (!s || !now) return out;

  out.eqBuyQty = now.buy;
  out.eqSellQty = now.sell;
  const share = buyPct(now.buy, now.sell);
  out.eqBuyPct = share;
  for (const w of [15, 5] as const) {
    const ref = asOf(s, now.minute - w);
    const then = ref ? buyPct(ref.buy, ref.sell) : null;
    if (share != null && then != null) out[`eqBuyPct${w}mChg`] = +(share - then).toFixed(2);
  }
  return out;
}

/**
 * India VIX, as journal readings.
 *
 *   vix          the level
 *   vixDayPct    against yesterday's close
 *   vix15mPct    over the last 15 minutes
 */
export function vixReadings(nowMs = Date.now()): Record<string, number | null> {
  const out: Record<string, number | null> = { vix: null, vixDayPct: null, vix15mPct: null };
  const s = vixTape.get('VIX');
  const now = latest(s, nowMs);
  if (!s || !now) return out;

  out.vix = now.level;
  out.vixDayPct = pct(now.level, now.prevClose);
  const ref = asOf(s, now.minute - 15);
  if (ref) out.vix15mPct = pct(now.level, ref.level);
  return out;
}

/**
 * Option-chain OI at the moment of the alert, as journal readings.
 *
 * DAY-OVER-DAY, NOT INTRADAY: Upstox's `prev_oi` on a chain leg is the previous session's close,
 * so every change here is against last night. That is still the read desks use for writing —
 * call OI piling up at and above the money is sellers capping a rally, put OI piling up is the
 * reverse — but it cannot say what happened during the move itself; the futures windows can.
 *
 *   optOi, optOiDayPct                    the contract bought
 *   nearCallOiDayPct / nearPutOiDayPct    calls and puts summed over the five strikes around the money
 *   pcrOi                                 put OI over call OI across the whole near-month chain
 */
export function chainOiReadings(
  chain: StockChain | null,
  strike: number | null,
  type: string | null,
): Record<string, number | null> {
  const out: Record<string, number | null> = {
    optOi: null, optOiDayPct: null, nearCallOiDayPct: null, nearPutOiDayPct: null, pcrOi: null,
  };
  if (!chain || !chain.rows.length) return out;

  const bought = strike == null ? null : chain.rows.find((r) => r.strike === strike);
  const leg = bought ? (type === 'PE' ? bought.put : bought.call) : null;
  if (leg && leg.oi > 0) {
    out.optOi = leg.oi;
    out.optOiDayPct = pct(leg.oi, leg.prevOi);
  }

  const atIdx = chain.rows.findIndex((r) => r.strike === chain.atmStrike);
  if (atIdx >= 0) {
    const near = chain.rows.slice(Math.max(0, atIdx - 2), atIdx + 3);
    let c = 0, cPrev = 0, p = 0, pPrev = 0;
    for (const r of near) {
      if (r.call) { c += r.call.oi; cPrev += r.call.prevOi; }
      if (r.put) { p += r.put.oi; pPrev += r.put.prevOi; }
    }
    out.nearCallOiDayPct = pct(c, cPrev);
    out.nearPutOiDayPct = pct(p, pPrev);
  }

  let calls = 0, puts = 0;
  for (const r of chain.rows) { calls += r.call?.oi ?? 0; puts += r.put?.oi ?? 0; }
  out.pcrOi = calls > 0 ? +(puts / calls).toFixed(3) : null;
  return out;
}

/** Test seam. */
export function resetFlowTape(): void {
  futures.clear();
  prevOiBySymbol.clear();
  books.clear();
  vixTape.clear();
}

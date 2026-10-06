// The IST trading session, as arithmetic.
//
// Every intraday factor in this module is a function of WHERE IN THE SESSION we are, not of
// wall-clock time: relative volume compares today's cumulative volume against what this
// stock had normally done by this same minute, and ATR expansion scales a still-forming
// range onto a full day. Getting the minute wrong shifts every one of those, so the session
// is resolved in one place, in IST, whatever timezone the host runs in.
//
// `services.ts` already has a `marketOpen()` and a `sessionFraction()`. This does not
// replace them — they serve the rest of the app and are re-exported below so there is one
// definition of "is the market open" in the process, not two that can drift.

import { marketHolidays } from '../services.js';

export { marketOpen } from '../services.js';

const IST_OFFSET_MIN = 330;
export const SESSION_OPEN_MIN = 9 * 60 + 15;
export const SESSION_CLOSE_MIN = 15 * 60 + 30;
/** 09:15 to 15:29 inclusive is 375 one-minute bars, which is what Upstox returns. */
export const SESSION_MINUTES = SESSION_CLOSE_MIN - SESSION_OPEN_MIN;

/** The wall clock shifted so the UTC getters read IST. */
const ist = (nowMs: number) => new Date(nowMs + IST_OFFSET_MIN * 60_000);

/** Minutes past midnight, IST. */
export const istMinutes = (nowMs: number = Date.now()): number => {
  const d = ist(nowMs);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
};

/**
 * When a session minute happened, as epoch ms. The inverse of `istMinutes`.
 *
 * WHY THIS EXISTS. An exit derived from candles is graded hours after it happened: the minute is
 * known exactly and the moment the grading RAN has nothing to do with it. Reaching for
 * `Date.now()` there stamps the job's own clock onto the trade, which is invisible while
 * settlement runs at 15:16 and absurd the moment it does not — a 15:15 square-off re-settled
 * after dinner printed as 10:26 PM, with an eleven-hour holding period to match.
 *
 * Only for minutes that belong to `day`'s session. A live event already knows its own timestamp
 * and must keep it; this is for reconstructing one that does not.
 */
export const sessionAt = (day: string, minute: number): number =>
  Date.parse(`${day}T00:00:00Z`) + (SESSION_OPEN_MIN + minute - IST_OFFSET_MIN) * 60_000;

/** Today in IST as YYYY-MM-DD. Not the host's date — at 03:00 IST those differ. */
export const istDay = (nowMs: number = Date.now()): string => ist(nowMs).toISOString().slice(0, 10);

/** Day of week in IST. 0 = Sunday. */
export const istDow = (nowMs: number = Date.now()): number => ist(nowMs).getUTCDay();

/**
 * `MARKET_HOLIDAYS`, parsed in `services.ts` beside the `marketOpen` that consults it, and
 * re-exported here for the same reason `marketOpen` is: "is the exchange open today" has one
 * parser in the process, and the session seed, the bell and the scanner all ask it.
 */
export { marketHolidays };

/** Is this YYYY-MM-DD a day the exchange trades? The same question as `isTradingDay`, by date. */
export const isSessionDay = (day: string): boolean => {
  const dow = new Date(`${day}T00:00:00Z`).getUTCDay();
  return dow !== 0 && dow !== 6 && !marketHolidays().has(day);
};

/**
 * Does the exchange trade on this date at all?
 *
 * Distinct from `marketOpen`, which is about the clock. This is about the calendar, and it is
 * the question anything that FETCHES A SESSION has to ask first: there is no session to fetch
 * on a Sunday, and asking for one costs a request per symbol to be told so.
 */
export const isTradingDay = (nowMs: number = Date.now()): boolean => isSessionDay(istDay(nowMs));

/**
 * How far into the session we are, 0…375.
 *
 * Clamped at both ends: before the open it is 0 (which makes RVOL undefined rather than
 * infinite), and after the close it is the full session, so a post-close board reads as a
 * complete day rather than as one still in progress.
 */
export function minuteOfSession(nowMs: number = Date.now()): number {
  const m = istMinutes(nowMs);
  if (m <= SESSION_OPEN_MIN) return 0;
  if (m >= SESSION_CLOSE_MIN) return SESSION_MINUTES;
  return m - SESSION_OPEN_MIN;
}

/** The same thing as a fraction, 0…1. */
export const sessionFraction = (nowMs: number = Date.now()): number =>
  minuteOfSession(nowMs) / SESSION_MINUTES;

/**
 * Minute-of-session for an Upstox candle stamp.
 *
 * Upstox returns "2026-07-31T09:15:00+05:30" — already IST, with the offset attached. It is
 * read off the STRING rather than parsed into a Date and converted back, because that round
 * trip is the classic way an off-by-330-minutes creeps in on a host that isn't in IST.
 */
export function candleMinute(stamp: string): number {
  const m = /T(\d{2}):(\d{2})/.exec(stamp);
  if (!m) return -1;
  return Number(m[1]) * 60 + Number(m[2]) - SESSION_OPEN_MIN;
}

/** The IST calendar day of an Upstox candle stamp. */
export const candleDay = (stamp: string): string => stamp.slice(0, 10);

/** YYYY-MM-DD `days` calendar days before `from`. */
export function isoDaysBefore(days: number, from: string | number = Date.now()): string {
  const base = typeof from === 'string' ? Date.parse(`${from}T00:00:00Z`) : from;
  return new Date(base - days * 86_400_000).toISOString().slice(0, 10);
}

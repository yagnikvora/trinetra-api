// Which stocks are trading on their quarterly results, and why an alert should say so.
//
// THE FINDING. It is the one split of this app's signals that has survived a time split. Tagged
// from NSE's board-meeting calendar, the 268 journal trades from 1 Jul to 13 Oct 2026 read:
//
//   results meeting today or since the previous session    64 trades   ₹1,38,865   10.7% per rupee
//   everything else                                       204 trades     ₹46,302    1.5% per rupee
//
// July 19.5% against 0.3%. September had no results-day trades at all and made 1.6%. The 33 chart
// readings tried on the same signals held nothing out of sample, because everything on a chart is
// already in the price; a set of quarterly numbers is new information that gets re-priced over the
// whole session. So this is not a gate — a results day and an ordinary one look identical to every
// rule in `alerts/` — it is a label, there so the reader can size the two differently.
//
// THE SOURCE. NSE's event calendar, one request for a date range:
//
//   https://www.nseindia.com/api/event-calendar?index=equities&from_date=DD-MM-YYYY&to_date=DD-MM-YYYY
//
//   [{"symbol":"HCLTECH","purpose":"Financial Results/Dividend","date":"12-Oct-2026", ...}]
//
// It is the date of the BOARD MEETING, which is the day the numbers come out, usually after the
// close. Hence two tags and not one: `previous` means the meeting was on an earlier day and the
// results are public by this morning; `today` means the board meets today and they may not be out
// yet. The range asked for starts at the previous SESSION, so a Saturday meeting tags Monday.
//
// IT FAILS OPEN, like the ban list beside it. The endpoint is unofficial and answers only to a
// browser user-agent. When it cannot be read the alerts go out untagged and the journal records
// the reading as null — "not known", which is a different thing from 0, "not a results day".

import { isSessionDay, istDay } from '../session.js';
import { store, STORE_KEYS } from '../store.js';

export interface ResultsTag {
  /** `previous`: the numbers are already public. `today`: the board meets today. */
  when: 'today' | 'previous';
  /** The board-meeting date, YYYY-MM-DD. */
  date: string;
}

interface Calendar {
  day: string;
  /** Results board-meeting dates by symbol, each within the previous session … `day`. */
  meetings: Record<string, string[]>;
  fetchedAt: number;
}

const TIMEOUT_MS = 6_000;
/** How long to leave NSE alone after a failed fetch. The scan that asks runs every 15 seconds. */
const RETRY_MS = 60_000;

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

let cached: Calendar | null = null;
let inflight: Promise<Calendar | null> | null = null;
let lastAttemptAt = 0;
let lastError: string | null = null;

/** The last day before `day` the exchange traded. */
export function previousSession(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  // Bounded, so a holiday list that somehow named every day cannot spin here.
  for (let i = 0; i < 14; i++) {
    d.setUTCDate(d.getUTCDate() - 1);
    const iso = d.toISOString().slice(0, 10);
    if (isSessionDay(iso)) return iso;
  }
  return d.toISOString().slice(0, 10);
}

const ddmmyyyy = (day: string): string => day.split('-').reverse().join('-');

/** NSE's `12-Oct-2026` as `2026-10-12`, or null when it is not a date in that shape. */
function isoDate(text: unknown): string | null {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(String(text ?? '').trim());
  if (!m) return null;
  const month = MONTHS.indexOf(m[2].toUpperCase()) + 1;
  return month ? `${m[3]}-${String(month).padStart(2, '0')}-${m[1].padStart(2, '0')}` : null;
}

/**
 * Results meetings by symbol from one calendar response, or null when it is not the calendar.
 *
 * Null and an empty record are different answers, as they are for the ban list: an empty record is
 * NSE saying nobody reports in the range, null is an error page and must be retried rather than
 * cached as "no results today".
 *
 * Only `purpose` is read. The free-text description mentions "results" on meetings that are about
 * something else, and 2,819 of the 3,339 rows from June to November 2026 carry it in the purpose.
 */
export function parseCalendar(body: unknown, from: string, to: string): Record<string, string[]> | null {
  if (!Array.isArray(body)) return null;
  const out: Record<string, string[]> = {};
  for (const row of body as Array<Record<string, unknown>>) {
    if (!/financial results/i.test(String(row?.purpose ?? ''))) continue;
    const symbol = String(row?.symbol ?? '').trim().toUpperCase();
    const date = isoDate(row?.date);
    if (!symbol || !date || date < from || date > to) continue;
    if (!(out[symbol] ??= []).includes(date)) out[symbol].push(date);
  }
  return out;
}

/**
 * The tag for one symbol on `day`, from the meetings of the previous session through `day`.
 *
 * `today` wins when a symbol somehow has both, because it is the weaker claim: it says only that
 * the board meets, not that the numbers are out.
 */
export function tagFor(meetings: Record<string, string[]>, symbol: string, day: string): ResultsTag | null {
  const dates = meetings[symbol.toUpperCase()];
  if (!dates?.length) return null;
  if (dates.includes(day)) return { when: 'today', date: day };
  const earlier = dates.filter((d) => d < day).sort();
  return earlier.length ? { when: 'previous', date: earlier[earlier.length - 1] } : null;
}

async function fetchCalendar(day: string, nowMs: number): Promise<Calendar | null> {
  const from = previousSession(day);
  try {
    const res = await fetch(
      `https://www.nseindia.com/api/event-calendar?index=equities&from_date=${ddmmyyyy(from)}&to_date=${ddmmyyyy(day)}`,
      {
        // The API answers 401 or 403 to anything that does not look like a browser.
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );
    if (!res.ok) throw new Error(`NSE event calendar answered ${res.status}`);
    const meetings = parseCalendar(await res.json().catch(() => null), from, day);
    if (!meetings) throw new Error('NSE event calendar did not answer with a list');
    const cal: Calendar = { day, meetings, fetchedAt: nowMs };
    await store.write(STORE_KEYS.resultsCalendar, cal).catch(() => {});
    lastError = null;
    return cal;
  } catch (e) {
    lastError = String((e as Error).message);
    return null;
  }
}

async function calendar(nowMs: number): Promise<Calendar | null> {
  const day = istDay(nowMs);
  if (cached?.day === day) return cached;

  const saved = await store.read<Calendar>(STORE_KEYS.resultsCalendar);
  if (saved?.day === day && saved.meetings && typeof saved.meetings === 'object') {
    cached = saved;
    return saved;
  }

  if (!inflight && nowMs - lastAttemptAt >= RETRY_MS) {
    lastAttemptAt = nowMs;
    inflight = fetchCalendar(day, nowMs).finally(() => { inflight = null; });
  }
  const got = inflight ? await inflight : null;
  if (got?.day === day) cached = got;
  return got?.day === day ? got : null;
}

/**
 * The results tag of each of `symbols` that has one, for the session `nowMs` falls in.
 *
 * Never throws and never waits longer than `TIMEOUT_MS`. One fetch a day when it works; when it
 * does not, null now — "not known" — and another attempt a minute later.
 */
export async function resultsTags(symbols: string[], nowMs = Date.now()): Promise<Map<string, ResultsTag> | null> {
  const cal = await calendar(nowMs).catch(() => null);
  if (!cal) return null;
  const out = new Map<string, ResultsTag>();
  for (const s of symbols) {
    const tag = tagFor(cal.meetings, s, cal.day);
    if (tag) out.set(s, tag);
  }
  return out;
}

/**
 * The two journal readings for one symbol.
 *
 * `resultsDay` is 1 on either tag and `resultsOut` is 1 only when the meeting was on an earlier
 * day. Both are null when the calendar could not be read, so a study never counts a morning NSE
 * was unreachable as a morning with no results.
 */
export async function resultsReadings(
  symbol: string,
  nowMs = Date.now(),
): Promise<{ resultsDay: number | null; resultsOut: number | null }> {
  const tags = await resultsTags([symbol], nowMs);
  if (!tags) return { resultsDay: null, resultsOut: null };
  const tag = tags.get(symbol);
  return { resultsDay: tag ? 1 : 0, resultsOut: tag?.when === 'previous' ? 1 : 0 };
}

/** The line an alert carries for a tagged symbol, unstyled. `12 Oct` rather than the ISO date. */
export function resultsLine(tag: ResultsTag): string {
  const [, m, d] = tag.date.split('-');
  const on = `${Number(d)} ${MONTHS[Number(m) - 1][0]}${MONTHS[Number(m) - 1].slice(1).toLowerCase()}`;
  return tag.when === 'previous'
    ? `RESULTS DAY — board met ${on}, the numbers are out`
    : 'RESULTS TODAY — the board meets today, the numbers may not be out yet';
}

/** Said under the tag, so the label comes with the evidence and its size. */
export const RESULTS_NOTE =
  'Results-day alerts made 10.7% per rupee against 1.5% for the rest (64 of 268 trades, Jul–Oct 2026).';

/** Reported on `/momentum/status`, so a morning running without the calendar can be seen as one. */
export const resultsCalendarStatus = () => ({
  day: cached?.day ?? null,
  symbols: cached ? Object.keys(cached.meetings).length : 0,
  fetchedAt: cached?.fetchedAt ?? null,
  lastError,
});

/** Test seam. */
export const resetResultsCalendar = (cal: Calendar | null = null): void => {
  cached = cal;
  inflight = null;
  lastAttemptAt = 0;
  lastError = null;
};

// NSE's "securities in ban period" list for the session, and why an alert channel has to read it.
//
// THE PROBLEM. A stock whose open interest crosses 95% of its market-wide position limit goes into
// the F&O ban and stays there until it falls back under 80%. Nobody may open a new derivative
// position in it; existing ones may only be closed. The CASH stock trades normally, so every
// reading this scanner takes — price, range, relative volume — looks exactly as it would on any
// other morning, while the option the alert names has no real book behind it.
//
// On 2026-10-13 BANDHANBNK was in the ban, ran +6.7% on 8x volume and cleared every displacement
// gate at 09:30. Its 165 CE was quoted 4.00 bid / 14.99 ask. The journal bought the ask and marked
// the bid fifteen seconds later: −73%, stopped, ₹27,084 booked on a trade no broker would have
// accepted in the first place.
//
// THE SOURCE. NSE publishes one small CSV per trade date, the evening before:
//
//   https://nsearchives.nseindia.com/archives/fo/sec_ban/fo_secban_DDMMYYYY.csv
//
//   Securities in Ban For Trade Date 13-OCT-2026:
//   1,AMBUJACEM
//   2,BANDHANBNK
//
// The DATED file is used rather than `content/fo/fo_secban.csv`, because that one rolls over to the
// next session in the evening and a process restarted at 20:00 would read tomorrow's list as
// today's. The header line is checked against the day asked for regardless: a date NSE has no file
// for answers 200 with an HTML page, and that must not parse as "nothing is banned".
//
// IT FAILS OPEN. If the file cannot be fetched the answer is an empty set and the channels carry
// on, because the alternative is a morning with no alerts at all whenever nsearchives is slow. The
// displacement channel's own spread ceiling is the backstop for that morning — a banned contract
// shows up as a book too wide to trade. `foBanStatus()` says which of the two is in force.

import { istDay } from '../session.js';
import { store, STORE_KEYS } from '../store.js';

interface BanList {
  day: string;
  symbols: string[];
  fetchedAt: number;
}

const TIMEOUT_MS = 6_000;
/** How long to leave NSE alone after a failed fetch. The scan that asks runs every 15 seconds. */
const RETRY_MS = 60_000;

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

let cached: BanList | null = null;
let inflight: Promise<BanList | null> | null = null;
let lastAttemptAt = 0;
let lastError: string | null = null;

const url = (day: string): string => {
  const [y, m, d] = day.split('-');
  return `https://nsearchives.nseindia.com/archives/fo/sec_ban/fo_secban_${d}${m}${y}.csv`;
};

/**
 * The symbols in one ban file, or null when the text is not the file for `day`.
 *
 * Null and an empty array are different answers and the caller treats them differently: an empty
 * array is NSE saying nothing is banned, null is "this is not the list" and must be retried.
 */
export function parseBanFile(text: string, day: string): string[] | null {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const head = /Trade Date\s+(\d{1,2})-([A-Za-z]{3})-(\d{4})/.exec(lines[0] ?? '');
  if (!head) return null;
  const month = MONTHS.indexOf(head[2].toUpperCase()) + 1;
  if (!month) return null;
  const stated = `${head[3]}-${String(month).padStart(2, '0')}-${head[1].padStart(2, '0')}`;
  if (stated !== day) return null;

  const out: string[] = [];
  for (const line of lines.slice(1)) {
    const row = /^\d+\s*,\s*([A-Z0-9&_-]+)\s*$/i.exec(line);
    if (row) out.push(row[1].toUpperCase());
  }
  return out;
}

async function fetchList(day: string, nowMs: number): Promise<BanList | null> {
  try {
    const res = await fetch(url(day), {
      // nsearchives drops a request that does not look like a browser without answering it.
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
        Accept: 'text/csv,text/plain,*/*',
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`NSE ban list answered ${res.status}`);
    const symbols = parseBanFile(await res.text(), day);
    if (!symbols) throw new Error(`NSE has no ban list for ${day} yet`);
    const list: BanList = { day, symbols, fetchedAt: nowMs };
    await store.write(STORE_KEYS.foBan, list).catch(() => {});
    lastError = null;
    return list;
  } catch (e) {
    lastError = String((e as Error).message);
    return null;
  }
}

/**
 * The symbols banned from new F&O positions in the session `nowMs` falls in.
 *
 * Never throws and never waits longer than `TIMEOUT_MS`. One fetch a day when it works; when it
 * does not, an empty set now and another attempt a minute later.
 */
export async function foBan(nowMs = Date.now()): Promise<Set<string>> {
  const day = istDay(nowMs);
  if (cached?.day === day) return new Set(cached.symbols);

  const saved = await store.read<BanList>(STORE_KEYS.foBan);
  if (saved?.day === day && Array.isArray(saved.symbols)) {
    cached = saved;
    return new Set(saved.symbols);
  }

  if (!inflight && nowMs - lastAttemptAt >= RETRY_MS) {
    lastAttemptAt = nowMs;
    inflight = fetchList(day, nowMs).finally(() => { inflight = null; });
  }
  const got = inflight ? await inflight : null;
  if (got?.day === day) {
    cached = got;
    return new Set(got.symbols);
  }
  return new Set();
}

/** Reported on `/momentum/status`, so a morning running without the list can be seen as one. */
export const foBanStatus = () => ({
  day: cached?.day ?? null,
  symbols: cached?.symbols ?? [],
  fetchedAt: cached?.fetchedAt ?? null,
  lastError,
});

/** Test seam. */
export const resetFoBan = (list: BanList | null = null): void => {
  cached = list;
  inflight = null;
  lastAttemptAt = 0;
  lastError = null;
};

// Whether the overnight news on a stock is good or bad for it, read by a language model.
//
// WHAT IT IS FOR. `results-calendar.ts` says a stock is trading on news. It cannot say which way
// the news points, and neither source it could ask can either: NSE's filings and Upstox's
// `/v2/news` both carry a line of text and a timestamp and no judgement. So both are handed to
// Gemini, which answers positive, negative or neutral per stock with a reason in a dozen words.
//
// TWO SOURCES, AND NSE IS THE FIRST. Measured on the seven F&O results of 7–13 Oct 2026: NSE shows
// a company's filing 0–2 seconds after it is submitted, for every company. Upstox's article came
// 56–97 minutes later and for two of the seven never came. But the NSE line for a set of results
// says only that results were submitted — the numbers are in an attached PDF, which the free model
// tier could not be made to read (150 s timeouts, and the PDF itself took 15–30 s to download). The
// Upstox headline is where "net profit jumps 170%" is written out. So the filing says THAT
// something happened, promptly and reliably, and the headline, when there is one, says how good.
//
// IT IS A READING, NOT A GATE, and not yet a tested one. The price has usually moved on the news
// before any alert fires, so the label is expected to agree with the direction the alert already
// has more often than it predicts it. It is on the message so a reader can see when the two
// DISAGREE, and in the journal's readings so that can be measured before anything is built on it.
//
// WHY IT IS SWEPT IN ADVANCE AND NEVER ASKED AT ALERT TIME. Measured on the free tier the evening
// this was written (2026-10-13): three stocks' headlines took 75 seconds on one model, timed out
// at 20 seconds on three others, and the rest answered 503 "high demand". The answers were right
// and the latency is unusable on a path where a minute is the edge. So the whole universe is
// labelled by a background sweep from 08:45 and re-swept every half hour until the trend-day
// window has passed, and the alert only ever does a lookup. A stock whose news the sweep has not
// got to reads as null — "not known" — and the alert goes out without the line.
//
// WHAT A SWEEP COSTS. One NSE request for every filing since the last close, one Upstox request
// per ten symbols (about 21), then Gemini only for symbols whose set of fresh items CHANGED since the last sweep, eight to a request. On an
// ordinary morning that is four or five model calls, and a re-sweep that finds nothing new makes
// none.
//
// "FRESH" is since the previous session's close. Yesterday morning's headline has had a full
// session to be priced and says nothing about today.

import { createHash } from 'node:crypto';

import { call, tokenSet } from '../../upstox.js';
import { isSessionDay, istDay, istMinutes, sessionAt, SESSION_CLOSE_MIN, SESSION_OPEN_MIN } from '../session.js';
import { store, STORE_KEYS } from '../store.js';
import { previousSession, resultsTags } from './results-calendar.js';
import { universe } from './universe.js';

export type NewsLabel = 'positive' | 'negative' | 'neutral';

export interface NewsRead {
  /** `none` when the sweep found no fresh headline on the stock at all. */
  label: NewsLabel | 'none';
  /** The model's reason, a dozen words at most. Empty on `none`. */
  reason: string;
  /** How many fresh items — NSE filings and Upstox headlines together — the label was read from. */
  headlines: number;
  /** How many of those were NSE filings. Absent on a read made before filings were a source. */
  filings?: number;
}

interface Stored {
  /**
   * Null while the headlines are known and the model has not answered for them yet — a batch that
   * failed, or one still in flight. Kept apart from `neutral` so a failed batch never reads as
   * "the news says nothing".
   */
  label: NewsLabel | null;
  reason: string;
  headlines: number;
  filings?: number;
  /** Hash of the items the label was read from, so an unchanged set is not asked again. */
  sig: string;
}

interface Sweep {
  day: string;
  sweptAt: number;
  /** Only symbols with at least one fresh headline. Absent means none was found. */
  reads: Record<string, Stored>;
}

interface NewsItem { heading?: string; summary?: string; published_time?: number }

/** One row of NSE's `api/corporate-announcements`, trimmed to what is read. */
export interface Filing { symbol?: string; desc?: string; attchmntText?: string; an_dt?: string }

/** What the model is shown for one stock. */
export interface NewsBatchItem { symbol: string; headlines: string[]; filings?: string[] }

/** Upstox takes thirty keys a request; ten keeps one busy stock from crowding out nine quiet ones. */
const KEYS_PER_REQUEST = 10;
/** Small on purpose: twenty-five to a request timed out at 90 seconds on the free tier, seven took 50. */
const SYMBOLS_PER_PROMPT = 8;
const HEADLINES_PER_SYMBOL = 5;
/**
 * More room on a stock trading on its results, so the results story itself is not pushed out by
 * five newer market wraps that merely name the stock — HCLTECH's own results headline was, on the
 * morning after it reported.
 */
const HEADLINES_ON_RESULTS = 8;
const FILINGS_PER_SYMBOL = 5;
const NSE_TIMEOUT_MS = 20_000;
/**
 * Filing categories that are paperwork. 440 of the 1,104 filings of 12–13 Oct 2026 were one
 * depository certificate; showing the model those costs tokens and teaches it nothing.
 */
const ROUTINE = new RegExp([
  'certificate under sebi', 'newspaper publication', 'analysts?/institutional', 'investor presentation',
  'shareholders? meeting', 'record date', 'esop', 'trading window', 'structural digital database',
  'loss of share certificate', 'duplicate share', 'book closure', 'postal ballot', 'scrutinizer',
  'spurt in volume', 'price movement', 'board meeting intimation', 'change in registered office',
  'copy of annual report', 'monitoring agency', 'statement of deviation', 'link of recording',
  // FEDERALBNK on 2026-10-19 was read "neutral — routine earnings call audio recording and stock
  // option allotment" from exactly these two.
  'audio', 'recording of', 'conference call', 'stock option', 'esos',
].join('|'), 'i');
/** Generous, because nothing waits on it — see the note at the top. */
const MODEL_TIMEOUT_MS = 90_000;
/** First sweep of the day, minutes after midnight IST. 08:45. */
const FIRST_SWEEP_MIN = 8 * 60 + 45;
/** No sweep after this. 10:45 — the trend-day channel has confirmed what it is going to by then. */
const LAST_SWEEP_MIN = 10 * 60 + 45;
const RESWEEP_MS = 30 * 60_000;
/** After a sweep that could not finish, try again sooner than the half hour. */
const RETRY_MS = 5 * 60_000;

const apiKey = (): string => (process.env.GEMINI_API_KEY ?? '').trim();

/** On by default once a key is present. `NEWS_SENTIMENT=off` switches it off without removing the key. */
export const enabled = (): boolean =>
  apiKey().length > 0 && (process.env.NEWS_SENTIMENT ?? '').trim().toLowerCase() !== 'off';

/**
 * The models to ask, in order. The `-latest` aliases rather than pinned versions: Google retires
 * pinned free-tier models outright (`gemini-2.5-flash-lite` answered 404 "no longer available" on
 * the day this was written) and the task is easy enough that any Flash model does it.
 */
const models = (): string[] => {
  const named = (process.env.NEWS_SENTIMENT_MODEL ?? '').trim();
  return [...new Set([named || 'gemini-flash-latest', 'gemini-flash-lite-latest'])];
};

let cached: Sweep | null = null;
let inflight: Promise<number> | null = null;
let lastAttemptAt = 0;
let lastError: string | null = null;
let lastModel: string | null = null;

/* ---------------------------------------------------------------------- pure pieces --- */

/**
 * The headlines on one stock worth reading: published inside the window, newest first, capped.
 *
 * Deduplicated on the heading, because a wire story is often carried twice a few minutes apart.
 */
export function freshHeadlines(items: NewsItem[], fromMs: number, toMs: number, max = HEADLINES_PER_SYMBOL): string[] {
  const seen = new Set<string>();
  return [...items]
    .filter((n) => typeof n.published_time === 'number' && n.published_time >= fromMs && n.published_time <= toMs)
    .sort((a, b) => (b.published_time ?? 0) - (a.published_time ?? 0))
    .map((n) => String(n.heading ?? '').replace(/\s+/g, ' ').trim())
    .filter((h) => h.length > 0 && !seen.has(h) && !!seen.add(h))
    .slice(0, max);
}

const NSE_MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** NSE's `12-Oct-2026 17:08:46`, which is IST, as epoch ms. Null when it is not in that shape. */
function nseTime(text: unknown): number | null {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4}) (\d{2}):(\d{2}):(\d{2})$/.exec(String(text ?? '').trim());
  if (!m) return null;
  const month = NSE_MONTHS.indexOf(m[2].toLowerCase());
  if (month < 0) return null;
  return Date.UTC(+m[3], month, +m[1], +m[4], +m[5], +m[6]) - 330 * 60_000;
}

/**
 * The filings worth reading, by symbol: inside the window, not paperwork, newest first, capped.
 *
 * Each becomes "Category: what the company said", with the "X Limited has informed the Exchange
 * about" preamble every filing opens with cut off — it is forty characters that say nothing.
 */
export function freshFilings(rows: Filing[], symbols: Set<string>, fromMs: number, toMs: number): Map<string, string[]> {
  const out = new Map<string, Array<{ at: number; text: string }>>();
  for (const r of rows) {
    const symbol = String(r?.symbol ?? '').trim().toUpperCase();
    const at = nseTime(r?.an_dt);
    const desc = String(r?.desc ?? '').replace(/\s+/g, ' ').trim();
    if (!symbols.has(symbol) || at === null || at < fromMs || at > toMs || !desc) continue;
    const said = String(r?.attchmntText ?? '').replace(/\s+/g, ' ').trim()
      .replace(/^.{0,80}? has (?:informed|submitted to) the Exchange,?\s*(?:about|regarding|that)?\s*/i, '');
    if (ROUTINE.test(desc) || ROUTINE.test(said)) continue;
    const text = `${desc}${said && said.toLowerCase() !== desc.toLowerCase() ? `: ${said}` : ''}`.slice(0, 320);
    const list = out.get(symbol) ?? out.set(symbol, []).get(symbol)!;
    if (!list.some((x) => x.text === text)) list.push({ at, text });
  }
  return new Map([...out].map(([s, list]) =>
    [s, list.sort((a, b) => b.at - a.at).slice(0, FILINGS_PER_SYMBOL).map((x) => x.text)]));
}

export const signature = (headlines: string[]): string =>
  createHash('sha1').update(headlines.join('\n')).digest('hex').slice(0, 12);

const INSTRUCTION =
  'You label Indian stock-market news for an intraday trader. For each stock, judge only the items ' +
  'listed under it. Lines marked [NSE filing] are the company\'s own disclosures to the exchange and are ' +
  'the authoritative source; lines marked [News] are press headlines. A filing that only says results ' +
  'or a press release were submitted, with no figures, tells you nothing by itself — use a [News] line ' +
  'for the figures if there is one, otherwise answer neutral. Label "positive" or "negative" only when the news is specifically about that company ' +
  'and is clearly good or bad for its share price today; otherwise "neutral". A general market report, a ' +
  'sector round-up or a "stocks to watch" list that merely names the stock is neutral. Judge the event, ' +
  'not the share price: a headline that only reports the stock rose or fell is neutral, and so is a ' +
  'dividend record date or other routine notice. Results, guidance, orders, deals, regulatory action and ' +
  'rating changes are the kind of event that counts. Answer for every ' +
  'stock listed, using its symbol exactly as given. reason: at most 12 words, plain English.';

export function buildPrompt(batch: NewsBatchItem[]): string {
  return batch.map((b) => [
    b.symbol,
    ...(b.filings ?? []).map((f) => `- [NSE filing] ${f}`),
    ...b.headlines.map((h) => `- [News] ${h}`),
  ].join('\n')).join('\n\n');
}

/**
 * The model's answer as labels by symbol, keeping only symbols that were asked about.
 *
 * Anything malformed is dropped rather than guessed at: a symbol missing from the result stays
 * unlabelled and is asked again on the next sweep.
 */
export function parseLabels(text: string, asked: string[]): Map<string, { label: NewsLabel; reason: string }> {
  const out = new Map<string, { label: NewsLabel; reason: string }>();
  let rows: unknown;
  try { rows = JSON.parse(text); } catch { return out; }
  if (!Array.isArray(rows)) return out;
  const want = new Set(asked);
  for (const r of rows as Array<Record<string, unknown>>) {
    const symbol = String(r?.symbol ?? '').trim().toUpperCase();
    const label = String(r?.label ?? '').trim().toLowerCase();
    if (!want.has(symbol) || (label !== 'positive' && label !== 'negative' && label !== 'neutral')) continue;
    out.set(symbol, { label, reason: String(r?.reason ?? '').replace(/\s+/g, ' ').trim().slice(0, 120) });
  }
  return out;
}

/** The journal readings for one lookup. Both null when the stock's news has not been read. */
export function newsReadings(
  read: NewsRead | null,
): { newsSentiment: number | null; newsCount: number | null; newsFilings: number | null } {
  if (!read) return { newsSentiment: null, newsCount: null, newsFilings: null };
  return {
    newsSentiment: read.label === 'positive' ? 1 : read.label === 'negative' ? -1 : 0,
    newsCount: read.headlines,
    newsFilings: read.filings ?? 0,
  };
}

/**
 * The line an alert carries, unstyled, or null when there is nothing worth a line.
 *
 * Only a positive or negative read is shown. "Neutral" on every ordinary alert would be a line
 * that is always there and never read, which is how the one that matters gets skipped.
 */
export function newsLine(read: NewsRead | null | undefined, direction: 1 | -1): string | null {
  if (!read || (read.label !== 'positive' && read.label !== 'negative')) return null;
  const against = (read.label === 'positive') !== (direction === 1);
  return `NEWS ${read.label.toUpperCase()}${read.reason ? ` — ${read.reason}` : ''}${against ? ' · AGAINST this trade' : ''}`;
}

/* -------------------------------------------------------------------------- the sweep --- */

/**
 * Ask the model about a batch of stocks. Exported for the tools that label a past day; the live
 * path reaches it only through `sweep`.
 */
export async function askModel(batch: NewsBatchItem[]): Promise<Map<string, { label: NewsLabel; reason: string }>> {
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: INSTRUCTION }] },
    contents: [{ role: 'user', parts: [{ text: buildPrompt(batch) }] }],
    generationConfig: {
      temperature: 0,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            symbol: { type: 'STRING' },
            label: { type: 'STRING', enum: ['positive', 'negative', 'neutral'] },
            reason: { type: 'STRING' },
          },
          required: ['symbol', 'label', 'reason'],
        },
      },
    },
  });

  let failure = 'no model answered';
  for (const model of models()) {
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        // The key goes in a header, never the URL, so it cannot end up in a log line or an error.
        headers: { 'x-goog-api-key': apiKey(), 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
      });
      if (!res.ok) { failure = `Gemini ${model} answered ${res.status}`; continue; }
      const json = (await res.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
      const text = (json.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('');
      const labels = parseLabels(text, batch.map((b) => b.symbol));
      if (!labels.size) { failure = `Gemini ${model} answered with nothing usable`; continue; }
      lastModel = model;
      return labels;
    } catch (e) {
      failure = `Gemini ${model}: ${String((e as Error).message)}`;
    }
  }
  throw new Error(failure);
}

const ddmmyyyy = (day: string): string => day.split('-').reverse().join('-');

/** Every equity filing NSE holds for a date range. One request; about 800 KB for two days. */
export async function nseFilings(from: string, to: string): Promise<Filing[]> {
  const res = await fetch(
    `https://www.nseindia.com/api/corporate-announcements?index=equities&from_date=${ddmmyyyy(from)}&to_date=${ddmmyyyy(to)}`,
    {
      // The API answers 401 or 403 to anything that does not look like a browser.
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(NSE_TIMEOUT_MS),
    },
  );
  if (!res.ok) throw new Error(`answered ${res.status}`);
  const body = await res.json().catch(() => null);
  if (!Array.isArray(body)) throw new Error('did not answer with a list');
  return body as Filing[];
}

async function load(day: string): Promise<Sweep | null> {
  if (cached?.day === day) return cached;
  const saved = await store.read<Sweep>(STORE_KEYS.newsSentiment);
  if (saved?.day === day && saved.reads && typeof saved.reads === 'object') cached = saved;
  return cached?.day === day ? cached : null;
}

async function sweep(nowMs: number): Promise<number> {
  const day = istDay(nowMs);
  const prior = await load(day);
  const fromMs = sessionAt(previousSession(day), SESSION_CLOSE_MIN - SESSION_OPEN_MIN);
  const members = (await universe(nowMs)).members;

  // A STOCK ON ITS RESULTS IS READ FROM THE START OF THE PREVIOUS SESSION, not from its close.
  // FEDERALBNK filed its results at midday on Friday 16 Oct 2026; on Monday the window opened at
  // Friday's close, the results filing fell outside it, and the read was "neutral" on a stock that
  // was trading on nothing else. Only results stocks get the longer window: for the rest, news from
  // yesterday morning has had a full session to be priced.
  const tagged = new Set((await resultsTags(members.map((m) => m.symbol), nowMs).catch(() => null))?.keys() ?? []);
  const resultsFromMs = sessionAt(previousSession(day), -SESSION_OPEN_MIN);
  const fromFor = (symbol: string): number => (tagged.has(symbol) ? resultsFromMs : fromMs);

  // NSE first: one request for every company's filings since the last close. When it cannot be
  // read the sweep carries on with headlines alone, and says so in `lastError`.
  let filings = new Map<string, string[]>();
  let nseError: string | null = null;
  try {
    const all = await nseFilings(previousSession(day), day);
    const symbols = new Set(members.map((m) => m.symbol));
    filings = freshFilings(all, new Set([...symbols].filter((s) => !tagged.has(s))), fromMs, nowMs);
    for (const [s, f] of freshFilings(all, new Set([...tagged].filter((s) => symbols.has(s))), resultsFromMs, nowMs)) filings.set(s, f);
  } catch (e) {
    nseError = `NSE filings: ${String((e as Error).message)}`;
  }

  // Then headlines, for everything.
  const reads: Record<string, Stored> = { ...(prior?.reads ?? {}) };
  /** Symbols whose set of fresh items changed, and so need the model. */
  const pending = new Map<string, NewsBatchItem>();
  const consider = (symbol: string, headlines: string[]): void => {
    const filed = filings.get(symbol) ?? [];
    if (!headlines.length && !filed.length) { delete reads[symbol]; return; }
    const sig = signature([...filed.map((f) => `F ${f}`), ...headlines]);
    if (reads[symbol]?.sig === sig && reads[symbol].label !== null) return;
    reads[symbol] = { label: null, reason: '', headlines: headlines.length + filed.length, filings: filed.length, sig };
    pending.set(symbol, { symbol, headlines, filings: filed });
  };
  let fetchFailed = 0;
  for (let i = 0; i < members.length; i += KEYS_PER_REQUEST) {
    const chunk = members.slice(i, i + KEYS_PER_REQUEST);
    try {
      const data = await call<Record<string, NewsItem[]>>(
        `/v2/news?category=instrument_keys&instrument_keys=${encodeURIComponent(chunk.map((m) => m.equityKey).join(','))}&page_size=100`,
      );
      for (const m of chunk) {
        consider(m.symbol, freshHeadlines(
          data[m.equityKey] ?? [], fromFor(m.symbol), nowMs, tagged.has(m.symbol) ? HEADLINES_ON_RESULTS : HEADLINES_PER_SYMBOL,
        ));
      }
    } catch (e) {
      // "No data" is Upstox's answer when none of the ten has any news, not a failure: those ten
      // are judged on their filings alone, which is exactly the case the filings are there for.
      if (/returned no data/.test(String((e as Error).message))) { for (const m of chunk) consider(m.symbol, []); }
      // A request that really failed leaves its ten as they were, except where a filing is waiting.
      else { fetchFailed++; for (const m of chunk) if (filings.has(m.symbol) && !reads[m.symbol]) consider(m.symbol, []); }
    }
  }

  // Then the model, only for what changed.
  const todo = [...pending.values()];
  let labelled = 0;
  let modelError: string | null = null;
  for (let i = 0; i < todo.length; i += SYMBOLS_PER_PROMPT) {
    const batch = todo.slice(i, i + SYMBOLS_PER_PROMPT);
    try {
      for (const [symbol, r] of await askModel(batch)) {
        reads[symbol] = { ...reads[symbol], label: r.label, reason: r.reason };
        labelled++;
      }
    } catch (e) {
      modelError = String((e as Error).message);
    }
    // Saved after every batch, so an alert that fires mid-sweep sees what is already known.
    cached = { day, sweptAt: nowMs, reads };
    await store.write(STORE_KEYS.newsSentiment, cached).catch(() => {});
  }
  cached = { day, sweptAt: nowMs, reads };
  await store.write(STORE_KEYS.newsSentiment, cached).catch(() => {});

  lastError = modelError ?? nseError ?? (fetchFailed ? `${fetchFailed} Upstox news request(s) failed` : null);
  return labelled;
}

/**
 * Run a sweep now. One at a time; a second caller gets the first one's promise.
 *
 * Never throws. Resolves to how many symbols were newly labelled.
 */
export function sweepNews(nowMs = Date.now()): Promise<number> {
  if (!enabled() || !tokenSet()) return Promise.resolve(0);
  if (!inflight) {
    lastAttemptAt = nowMs;
    inflight = sweep(nowMs)
      .catch((e) => { lastError = String((e as Error).message); return 0; })
      .finally(() => { inflight = null; });
  }
  return inflight;
}

/**
 * Whether a sweep is due, on the scheduler's five-minute tick.
 *
 * Trading days only, from 08:45 to 10:45: once as soon as the window opens, then every half hour,
 * and sooner than that after a sweep that left something unlabelled.
 */
export async function newsSweepDue(nowMs = Date.now()): Promise<boolean> {
  if (!enabled() || inflight) return false;
  const day = istDay(nowMs);
  const minute = istMinutes(nowMs);
  if (!isSessionDay(day) || minute < FIRST_SWEEP_MIN || minute > LAST_SWEEP_MIN) return false;
  const have = await load(day);
  if (!have) return nowMs - lastAttemptAt >= RETRY_MS;
  const unfinished = Object.values(have.reads).some((r) => r.label === null);
  return nowMs - Math.max(have.sweptAt, lastAttemptAt) >= (unfinished || lastError ? RETRY_MS : RESWEEP_MS);
}

/**
 * What the last sweep read on one stock. A lookup: never asks the model, never waits on it.
 *
 * Null when there has been no sweep today or the stock's headlines are still unlabelled.
 */
export async function newsRead(symbol: string, nowMs = Date.now()): Promise<NewsRead | null> {
  if (!enabled()) return null;
  const have = await load(istDay(nowMs)).catch(() => null);
  if (!have) return null;
  const r = have.reads[symbol];
  if (!r) return { label: 'none', reason: '', headlines: 0 };
  return r.label === null ? null : { label: r.label, reason: r.reason, headlines: r.headlines, filings: r.filings ?? 0 };
}

/** `newsRead` for several symbols. Symbols with nothing known are simply absent. */
export async function newsReads(symbols: string[], nowMs = Date.now()): Promise<Map<string, NewsRead>> {
  const out = new Map<string, NewsRead>();
  for (const s of symbols) {
    const r = await newsRead(s, nowMs);
    if (r) out.set(s, r);
  }
  return out;
}

/** Reported on `/momentum/status`, so a morning with no labels can be told from a quiet one. */
export const newsSentimentStatus = () => {
  const reads = Object.values(cached?.reads ?? {});
  return {
    enabled: enabled(),
    day: cached?.day ?? null,
    sweptAt: cached?.sweptAt ?? null,
    sweeping: inflight !== null,
    withNews: reads.length,
    positive: reads.filter((r) => r.label === 'positive').length,
    negative: reads.filter((r) => r.label === 'negative').length,
    unlabelled: reads.filter((r) => r.label === null).length,
    model: lastModel,
    lastError,
  };
};

/** Test seam. */
export const resetNewsSentiment = (state: Sweep | null = null): void => {
  cached = state;
  inflight = null;
  lastAttemptAt = 0;
  lastError = null;
  lastModel = null;
};

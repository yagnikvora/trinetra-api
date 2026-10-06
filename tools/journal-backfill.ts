// Reconstruct the trade journal from real market data.
//
//   npx tsx tools/journal-backfill.ts                    the whole resolvable window
//   npx tsx tools/journal-backfill.ts --from 2026-08-10  a slice of it
//   npx tsx tools/journal-backfill.ts --dry              print, write nothing
//   npx tsx tools/journal-backfill.ts --clear            remove every backfilled row
//
// WHAT IS REAL HERE AND WHAT IS NOT — read this before quoting any number the page shows.
//
//   REAL. Which signals fired: the shipped `selectDisplacement` is imported and walked minute by
//   minute over cached 1-minute bars, so it is the same selector the live scan uses rather than a
//   reimplementation. The option prices: each contract's OWN 1-minute candles, fetched from
//   Upstox for the session in question. The grading: the journal's own `gradePath`, unchanged, at
//   the configured +80/−50 and the 15:15 square-off.
//
//   NOT REAL. The ENTRY IS A TRADED PRICE, NOT THE ASK. A live entry pays the offer; a candle only
//   records what traded. Every backfilled entry is therefore cheaper than the live one would have
//   been, by something like half the spread — the research budgeted 2.5% each way for this, and on
//   these names it is the single largest optimism in the exercise. `spreadPctAtEntry` is left null
//   rather than guessed, so the page shows a gap instead of a number nobody measured.
//
//   NOT REAL. THE STRIKE IS THE NEAREST ONE TO SPOT. The live picker walks a ladder and chooses on
//   delta, spread and liquidity, none of which is available historically. Usually the same
//   contract; not always.
//
// WHY ONLY DISPLACEMENT, when the journal has three channels. Trend-day confirmation is gated on
// `TREND_DAY_ALERT_MIN_CONVICTION`, and conviction replayed from 1-minute bars reads about 8-12
// points HIGH because minute sampling inflates measured session efficiency. Against a floor of 82
// that bias does not blur the edges, it changes which days alert at all — so a replayed trend-day
// journal would be a record of a rule nobody runs. Ignition is switched off in `.env` and is
// anti-predictive at its top end by its own research. Displacement is the one channel whose
// replay path is verified, so it is the only one backfilled.
//
// WHY THE WINDOW STOPS WHERE IT DOES. A signal is priced in the expiry that was nearest AFTER it,
// and option instrument keys cannot be recovered once a series expires — see
// `tools/option-keys-capture.ts`. Sessions before the July expiry are therefore unreachable, not
// merely inconvenient. Run the capture tool monthly and the reachable window grows instead.

import '../src/env.js';

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { sessionCandles } from '../src/upstox.js';
import { expiredSession, PlanRequiredError } from '../src/momentum/data/expired-candles.js';
import { istDay } from '../src/momentum/session.js';
import { rule, selectDisplacement, type DisplacementCandidate, type DisplacementInput } from '../src/momentum/alerts/displacement.js';
import { dayEndOf, gradePath, journalConfig, journalRepository, SHADOW } from '../src/momentum/journal/journal.js';
import { FileJournalRepository } from '../src/momentum/journal/repository.js';
import { closePool, databaseUrl, getPool } from '../src/momentum/journal/postgres.js';
import { universe } from '../src/momentum/data/universe.js';
import type { JournalShadow, JournalTrade } from '../src/momentum/journal/types.js';
import type { MomentumQuote } from '../src/momentum/data/quotes.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const KEYS_DIR = path.join(here, '..', '.cache', 'option-keys');

/**
 * How a backfilled row is recognised, forever.
 *
 * It lives in `readings` rather than in `note` because `JournalPatch` accepts only entry premium,
 * exit premium, lots, note and reset — so a note marker is wiped the moment someone uses the fill
 * editor on the row, which is exactly how a marker failed once already. `readings` is not
 * reachable from any edit path.
 */
const BACKFILL_FLAG = 'backfill';
const isBackfilled = (t: JournalTrade): boolean => t.readings?.[BACKFILL_FLAG] === 1;

/** Upstox concurrency that measured clean in the ladder fetcher. */
const BATCH = 8;

/* ------------------------------------------------------------------------- lab types --- */

interface LabSession {
  close: Float64Array; high: Float64Array; low: Float64Array;
  vol: Float64Array; vwap: Float64Array; cumVol: Float64Array;
  dayHigh: Float64Array; dayLow: Float64Array;
  open: number; orHigh: number; orLow: number; bars: number;
}
interface LabReading {
  symbol: string; day: string; s: LabSession;
  atr: number; prev: { close: number }; profile: Float64Array; medTurnoverCr: number;
}
interface Lab { byDay: Map<string, Map<string, LabReading>>; days: string[] }

/* --------------------------------------------------------------------------- helpers --- */

const clock = (m: number): string => {
  const t = 555 + m;
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
};

/** Epoch ms for a minute of an IST session. 0 = 09:15 IST. */
const atOf = (day: string, minute: number): number =>
  Date.parse(`${day}T00:00:00Z`) + (9 * 60 + 15 + minute - 330) * 60_000;

const round = (n: number, dp = 2): number => +n.toFixed(dp);

interface KeyMap {
  expiry: string;
  capturedOn: string;
  symbols: Record<string, { spot: number; strikes: Record<string, { ce: string | null; pe: string | null }> }>;
}

/** Every captured series, newest expiry last. */
async function loadKeyMaps(): Promise<KeyMap[]> {
  const files = await fs.readdir(KEYS_DIR).catch(() => [] as string[]);
  const maps: KeyMap[] = [];
  for (const f of files.filter((x) => x.endsWith('.json')).sort()) {
    try { maps.push(JSON.parse(await fs.readFile(path.join(KEYS_DIR, f), 'utf8')) as KeyMap); } catch { /* skip */ }
  }
  return maps;
}

/**
 * The first day a series is the NEAR month — the previous monthly expiry.
 *
 * NSE stock options expire on the last Tuesday of the month (verified against the live master on
 * 2026-08-24: 2026-08-25, 2026-09-29 and 2026-10-27 are all Tuesdays), so the series before this
 * one ended on the last Tuesday of the previous calendar month.
 *
 * This bound is not decoration. Without it, a captured August map is the "nearest expiry after"
 * every July day too, and a 13 July signal gets priced in a six-week contract when the live
 * scanner would have bought a two-week July one — different premium, different decay, different
 * answer. The first run of this tool did exactly that across 17 July sessions.
 *
 * CAVEAT: when an expiry Tuesday is a trading holiday, NSE moves that expiry earlier, which shifts
 * this boundary by a day or two. It can therefore misplace a session sitting exactly on the
 * boundary; it cannot misplace anything further in.
 */
function seriesStart(expiry: string): string {
  const e = new Date(`${expiry}T00:00:00Z`);
  const weekday = e.getUTCDay();
  const y = e.getUTCFullYear(), m = e.getUTCMonth();
  // Walk back from the last day of the previous month to that same weekday.
  const lastOfPrev = new Date(Date.UTC(y, m, 0));
  const back = (lastOfPrev.getUTCDay() - weekday + 7) % 7;
  lastOfPrev.setUTCDate(lastOfPrev.getUTCDate() - back);
  return lastOfPrev.toISOString().slice(0, 10);
}

/**
 * The contract a signal on `day` would have been written in.
 *
 * Nearest captured expiry after the day, exactly as `chosenExpiry` resolves live — but only if the
 * day also falls inside that series' near-month life. A day earlier than that belonged to a series
 * that has since expired and cannot be priced at all.
 */
function pickSeries(maps: KeyMap[], day: string): KeyMap | null {
  const s = maps.find((m) => m.expiry > day);
  return s && day >= seriesStart(s.expiry) ? s : null;
}

/** Nearest listed strike to spot, and its leg. */
function resolveContract(
  series: KeyMap, symbol: string, spot: number, direction: 1 | -1,
): { strike: number; type: 'CE' | 'PE'; instrumentKey: string } | null {
  const sym = series.symbols[symbol];
  if (!sym) return null;
  const type: 'CE' | 'PE' = direction === 1 ? 'CE' : 'PE';
  let best: { strike: number; key: string } | null = null;
  for (const [raw, legs] of Object.entries(sym.strikes)) {
    const key = type === 'CE' ? legs.ce : legs.pe;
    if (!key) continue;
    const strike = Number(raw);
    if (!Number.isFinite(strike)) continue;
    if (!best || Math.abs(strike - spot) < Math.abs(best.strike - spot)) best = { strike, key };
  }
  return best ? { strike: best.strike, type, instrumentKey: best.key } : null;
}

/* ------------------------------------------------------------------------- the replay --- */

/** Walk one session through the shipped selector and return what it announced. */
function replayDay(lab: Lab, day: string, uni: Awaited<ReturnType<typeof universe>>): DisplacementCandidate[] {
  const readings = lab.byDay.get(day);
  if (!readings) return [];
  const r = rule();
  const announced = new Set<string>();
  const fired: DisplacementCandidate[] = [];

  for (let minute = r.fromMinute; minute <= r.toMinute && announced.size < r.maxPerDay; minute++) {
    const inputs: DisplacementInput[] = [];
    for (const [symbol, d] of readings) {
      const ltp = d.s.close[minute];
      if (!Number.isFinite(ltp) || !ltp) continue;
      const member = uni.bySymbol.get(symbol);
      const cumVol = d.s.cumVol[minute];
      const expected = minute < d.profile.length ? d.profile[minute] : 0;
      const vwap = d.s.vwap[minute];

      const quote = {
        symbol,
        instrumentKey: member?.equityKey ?? '',
        ltp,
        prevClose: d.prev.close,
        netChange: 0,
        changePct: d.prev.close ? ((ltp - d.prev.close) / d.prev.close) * 100 : 0,
        open: d.s.open,
        high: d.s.dayHigh[minute],
        low: d.s.dayLow[minute],
        volume: cumVol,
        vwap,
        turnoverCr: (vwap * cumVol) / 1e7,
        openInterest: 0, oiDayHigh: 0, oiDayLow: 0,
        totalBuyQty: 0, totalSellQty: 0,
        bid: 0, ask: 0, bidQty: 0, askQty: 0, bidOrders: 0, askOrders: 0,
        depthCr: 0, hasBook: false, at: 0,
      } as unknown as MomentumQuote;

      inputs.push({
        symbol,
        equityKey: member?.equityKey ?? '',
        quote,
        atr: d.atr,
        avgDailyValueCr: d.medTurnoverCr,
        rvol: expected > 0 ? cumVol / expected : null,
        lotSize: member?.future?.lotSize ?? null,
      });
    }

    for (const c of selectDisplacement(inputs, announced, minute, r).slice(0, r.maxPerDay - announced.size)) {
      announced.add(c.symbol);
      fired.push(c);
    }
  }
  return fired;
}

/* -------------------------------------------------------------------------- the money --- */

type OptionBar = { minute: number; high: number; low: number; close: number; open: number };

/**
 * The contract's own session, as minute-of-session bars.
 *
 * Via `sessionCandles` rather than `candles`, because today is served ONLY by the intraday
 * endpoint and past days only by the historical one — and asking the wrong one answers 200 with an
 * empty array, which reads as "the contract never traded" rather than "wrong endpoint". That is
 * exactly how the first run of this tool priced nothing at all for the current session.
 */
async function optionSession(instrumentKey: string, day: string, expiry?: string): Promise<OptionBar[]> {
  const raw = await sessionCandles(instrumentKey, day, istDay(Date.now()), 'minutes', 1).catch(() => []);
  if (raw.length) {
    return raw
      .map((c) => ({
        minute: Math.round((c[0] * 1000 - atOf(day, 0)) / 60_000),
        open: c[1], high: c[2], low: c[3], close: c[4],
      }))
      .filter((b) => b.minute >= 0 && b.minute < 375)
      .sort((a, b) => a.minute - b.minute);
  }
  // Series already expired: the live endpoint refuses the key outright, and the only remaining
  // source is the expired-instruments API. Without this every session older than the current
  // month prices nothing — 192 signals, 192 "without candles", which is how this was found.
  if (!expiry) return [];
  const bars = await expiredSession(instrumentKey, expiry, day);
  return bars.map((b) => ({ minute: b.minute, open: b.open, high: b.high, low: b.low, close: b.close }));
}

/* ---------------------------------------------------------------------------- writing --- */

async function removeBackfilled(): Promise<void> {
  const repo = new FileJournalRepository();
  const all = await repo.range('2026-01-01', '2027-12-31');
  const drop = all.filter(isBackfilled);
  console.log(`\n  ${drop.length} backfilled rows on local disk`);

  if (drop.length) {
    // The repository has no delete, so the month documents are rewritten directly — the same
    // files it writes, minus these ids.
    const CACHE = path.join(here, '..', '.cache', 'momentum');
    const months = new Set(drop.map((t) => t.day.slice(0, 7)));
    for (const month of months) {
      const file = path.join(CACHE, `journal_${month}.json`);
      const doc = JSON.parse(await fs.readFile(file, 'utf8')) as { month: string; trades: JournalTrade[] };
      const before = doc.trades.length;
      doc.trades = doc.trades.filter((t) => !isBackfilled(t));
      if (doc.trades.length === 0) {
        await fs.unlink(file).catch(() => {});
        console.log(`  journal_${month}.json — ${before} rows removed, file deleted`);
      } else {
        await fs.writeFile(file, JSON.stringify(doc), 'utf8');
        console.log(`  journal_${month}.json — ${before - doc.trades.length} removed, ${doc.trades.length} kept`);
      }
    }
  }

  if (!databaseUrl()) { console.log('  no DATABASE_URL — disk was the only copy\n'); return; }
  try {
    const res = await getPool().query(
      `DELETE FROM momentum_journal WHERE (trade->'readings'->>'${BACKFILL_FLAG}') = '1'`,
    );
    console.log(`  deleted ${res.rowCount ?? 0} backfilled rows from Neon\n`);
  } catch (e) {
    console.error(`  COULD NOT REACH NEON — ${(e as Error).message}\n`);
  } finally {
    await closePool();
  }
}

/* ---------------------------------------------------------------------- cap compare --- */

/**
 * What each `DISPLACEMENT_MAX_PER_DAY` setting would have produced, on one replay.
 *
 * The cap does not RANK — `selectDisplacement` fills it in arrival order and stops. So the trades
 * a cap of 2 takes are exactly the first two a cap of 4 took, and the three settings are nested
 * rather than independent. That is why this needs one replay and one pricing pass instead of
 * three: re-running would spend triple the Upstox quota to rediscover a subset it already holds.
 *
 * It also means the comparison is honest in a specific way — a lower cap is not "the same
 * strategy with better picks", it is "the same strategy that goes home earlier".
 */
function compareCaps(rows: JournalTrade[], caps: number[]): void {
  const byDay = new Map<string, JournalTrade[]>();
  for (const t of rows) {
    const a = byDay.get(t.day) ?? [];
    a.push(t);
    byDay.set(t.day, a);
  }
  // ACCEPTANCE ORDER, which is not arrival order. `selectDisplacement` returns each minute's
  // qualifying candidates sorted by RVOL DESCENDING and the caller slices the cap off the front,
  // so within one minute the cap keeps the heaviest-volume names — and four signals landing in the
  // same minute is the normal case, not the exception. Sorting by symbol here instead (the first
  // cut of this function) silently compared a different set of trades than the rule would take,
  // and reported a cap-3 net that the real cap-3 run did not reproduce.
  for (const a of byDay.values()) {
    a.sort((x, y) => x.entry.minute - y.entry.minute
      || (Number(y.readings?.rvol ?? 0) - Number(x.readings?.rvol ?? 0)));
  }
  const days = [...byDay.keys()].sort();

  const inr = (n: number): string => (n < 0 ? '-Rs ' : 'Rs ') + Math.round(Math.abs(n)).toLocaleString('en-IN');
  const cfg = journalConfig();

  console.log('\n  === DISPLACEMENT_MAX_PER_DAY compared, on the same replayed sessions ===\n');
  console.log('  cap  trades  win%      net      peak/day   worst day    max DD   ret/peak  cap@15%');
  console.log('  ' + '-'.repeat(88));

  for (const cap of caps) {
    const taken = days.flatMap((d) => byDay.get(d)!.slice(0, cap));
    const done = taken.filter((t) => t.netPnl !== null);
    const wins = done.filter((t) => (t.netPnl ?? 0) > 0).length;
    const net = done.reduce((a, t) => a + (t.netPnl ?? 0), 0);

    const dayUse = days.map((d) => byDay.get(d)!.slice(0, cap).reduce((a, t) => a + (t.amountUsed ?? 0), 0));
    const dayNet = days.map((d) => byDay.get(d)!.slice(0, cap).reduce((a, t) => a + (t.netPnl ?? 0), 0));
    const peak = Math.max(0, ...dayUse);
    const worstDay = Math.min(0, ...dayNet);

    let eq = 0, high = 0, maxDD = 0;
    for (const n of dayNet) { eq += n; if (eq > high) high = eq; if (high - eq > maxDD) maxDD = high - eq; }

    // The tail this sizing has to survive: every position of a full day stopping out together,
    // which is the 0-for-4 morning the channel's own research records twice in 35 sessions.
    const biggest = [...taken].sort((a, b) => (b.amountUsed ?? 0) - (a.amountUsed ?? 0)).slice(0, cap);
    const worstCaseDay = biggest.reduce((a, t) => a + (t.amountUsed ?? 0), 0) * cfg.slPct + cap * cfg.chargePerLot;

    console.log(
      `  ${String(cap).padStart(2)}  ${String(taken.length).padStart(6)}  ` +
      `${(done.length ? (100 * wins) / done.length : 0).toFixed(1).padStart(5)}  ` +
      `${inr(net).padStart(10)}  ${inr(peak).padStart(10)}  ${inr(worstDay).padStart(10)}  ` +
      `${inr(-maxDD).padStart(10)}  ${(peak ? (100 * net) / peak : 0).toFixed(1).padStart(6)}%  ` +
      `${inr(worstCaseDay / 0.15).padStart(11)}`,
    );
  }
  console.log('  ' + '-'.repeat(88));
  console.log('  peak/day = most premium open at once — the working capital floor.');
  console.log('  cap@15%  = capital at which the cap\'s worst-case all-stop day costs 15% of the account.');
  console.log('  ret/peak = net over the whole window against that peak deployment. NOT annualised.\n');
}

/* ------------------------------------------------------------------ square-off compare --- */

/** One trade reduced to what a re-grade needs: the path, what was paid, and the size. */
interface Priced {
  day: string;
  symbol: string;
  bars: OptionBar[];
  paid: number;
  entryMinute: number;
  size: number;
}

/**
 * What a different `JOURNAL_SQUARE_OFF_MIN` would have done to the same trades.
 *
 * The cutoff cannot change WHICH signals fire — every entry is inside the 09:27-10:00 window and
 * decided long before any of these times — so this is a pure re-grade of one fixed set of trades
 * against one fixed set of candles. That makes it a far cleaner comparison than the per-day cap,
 * where the alternatives take different trades entirely.
 *
 * A position that already hit its target or its stop is untouched by a later cutoff. Only two
 * groups move: trades still open at the earlier time, which get its price instead of the later
 * one, and trades that would have reached a level BETWEEN the two times, which the earlier cutoff
 * closes before they get there.
 */
function compareSquareOff(priced: Priced[], cutoffs: number[]): void {
  const cfg = journalConfig();
  const inr = (n: number): string => (n < 0 ? '-Rs ' : 'Rs ') + Math.round(Math.abs(n)).toLocaleString('en-IN');

  const at = (cutoff: number) => priced.map((p) => {
    const g = gradePath(p.bars, p.paid, p.entryMinute, cfg.tpPct, cfg.slPct, cutoff);
    const gross = (p.paid * (1 + g.pct) - p.paid) * p.size;
    return { net: gross - cfg.chargePerLot * cfg.lots, out: g.out, sym: p.symbol, day: p.day };
  });

  const base = at(cfg.squareOffMin);
  const baseNet = base.reduce((a, x) => a + x.net, 0);

  console.log('\n  === SQUARE-OFF TIME compared, same trades and same candles ===\n');
  console.log('  time    minute  target  stop  squared      net       vs 15:15   win%');
  console.log('  ' + '-'.repeat(74));

  for (const cutoff of cutoffs) {
    const r = at(cutoff);
    const net = r.reduce((a, x) => a + x.net, 0);
    const wins = r.filter((x) => x.net > 0).length;
    console.log(
      `  ${clock(cutoff)}   ${String(cutoff).padStart(5)}  ` +
      `${String(r.filter((x) => x.out === 'target').length).padStart(6)}  ` +
      `${String(r.filter((x) => x.out === 'stop').length).padStart(4)}  ` +
      `${String(r.filter((x) => x.out === 'close').length).padStart(7)}  ` +
      `${inr(net).padStart(11)}  ${(cutoff === cfg.squareOffMin ? '—' : inr(net - baseNet)).padStart(11)}  ` +
      `${((100 * wins) / r.length).toFixed(1).padStart(5)}`,
    );
  }
  console.log('  ' + '-'.repeat(74));

  // Which trades actually move, so the difference is attributable rather than just a total.
  const early = cutoffs.filter((c) => c !== cfg.squareOffMin).sort((a, b) => a - b)[0];
  if (early === undefined) return;
  const alt = at(early);
  const moved = base
    .map((b, i) => ({ sym: b.sym, day: b.day, was: b.net, now: alt[i].net, wasOut: b.out, nowOut: alt[i].out }))
    .filter((x) => Math.abs(x.now - x.was) > 1)
    .sort((a, b) => (b.now - b.was) - (a.now - a.was));

  console.log(`\n  ${moved.length} of ${priced.length} trades change between ${clock(early)} and ${clock(cfg.squareOffMin)}.`);
  if (moved.length) {
    console.log(`\n  biggest improvements from squaring off at ${clock(early)}:`);
    for (const m of moved.slice(0, 5)) {
      console.log(`    ${m.day}  ${m.sym.padEnd(12)} ${inr(m.was).padStart(10)} (${m.wasOut}) -> ${inr(m.now).padStart(10)} (${m.nowOut})`);
    }
    console.log(`\n  biggest costs:`);
    for (const m of moved.slice(-5).reverse()) {
      console.log(`    ${m.day}  ${m.sym.padEnd(12)} ${inr(m.was).padStart(10)} (${m.wasOut}) -> ${inr(m.now).padStart(10)} (${m.nowOut})`);
    }
  }
  console.log();
}

/* ------------------------------------------------------------------------------ main --- */

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--clear')) { await removeBackfilled(); return; }
  const comparing = argv.includes('--compare');
  const squaringOff = argv.includes('--squareoff');
  // Replayed at the widest cap so the narrower ones can be sliced out of the same result.
  if (comparing) process.env.DISPLACEMENT_MAX_PER_DAY = '4';

  const dry = argv.includes('--dry');
  const arg = (name: string): string | null => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] ?? null : null;
  };

  const cfg = journalConfig();
  const maps = await loadKeyMaps();
  if (!maps.length) {
    console.error('\n  No captured option keys in .cache/option-keys/.');
    console.error('  Run: npx tsx tools/option-keys-capture.ts   (before the series expires)\n');
    process.exit(1);
  }

  // @ts-expect-error — lab.mjs is the research harness, plain ESM with no type declarations.
  const { loadUniverse } = await import('../research/lab.mjs');
  const lab = loadUniverse({ minPriorSessions: 8 }) as Lab;
  const uni = await universe();

  // Only sessions that both replay AND have a captured series that was genuinely the near month.
  const earliest = maps.map((m) => m.expiry).sort()[0];
  let days = lab.days.filter((d) => !!pickSeries(maps, d));
  const dropped = lab.days.length - days.length;
  const from = arg('--from'), to = arg('--to');
  if (from) days = days.filter((d) => d >= from);
  if (to) days = days.filter((d) => d <= to);

  console.log(`\n  Journal backfill — displacement channel, real option candles`);
  console.log(`  captured series: ${maps.map((m) => m.expiry).join(', ')}`);
  console.log(`  near-month life: ${maps.map((m) => `${seriesStart(m.expiry)}..${m.expiry}`).join(', ')}`);
  console.log(`  replayable and priceable: ${days.length} sessions` + (days.length ? ` (${days[0]} -> ${days[days.length - 1]})` : ''));
  if (dropped) console.log(`  ${dropped} cached sessions skipped — their near month has expired and cannot be priced`);
  console.log(`  exits +${100 * cfg.tpPct}% / −${100 * cfg.slPct}%, square-off ${clock(cfg.squareOffMin)}, ₹${cfg.chargePerLot}/lot\n`);
  if (!days.length) {
    console.error(`  Nothing to do. The earliest captured expiry is ${earliest}, so sessions before it cannot be priced.\n`);
    process.exit(1);
  }

  // 1. Replay every session first — offline, no quota.
  const signals: Array<{ day: string; c: DisplacementCandidate }> = [];
  for (const day of days) {
    const fired = replayDay(lab, day, uni);
    for (const c of fired) signals.push({ day, c });
    console.log(`  ${day}  ${String(fired.length).padStart(2)} signal${fired.length === 1 ? ' ' : 's'}  ${fired.map((f) => f.symbol).join(' ')}`);
  }
  console.log(`\n  ${signals.length} signals over ${days.length} sessions (${(signals.length / days.length).toFixed(1)}/day)\n`);

  // 2. Price each one against its contract's real candles.
  const rows: JournalTrade[] = [];
  // The candle path of every priced trade, kept so `--squareoff` can re-grade without spending a
  // second round of Upstox requests to fetch the identical bars again.
  const priced: Priced[] = [];
  let noContract = 0, noCandles = 0;

  for (let i = 0; i < signals.length; i += BATCH) {
    const built = await Promise.all(signals.slice(i, i + BATCH).map(async ({ day, c }) => {
      const series = pickSeries(maps, day);
      if (!series) return null;
      const con = resolveContract(series, c.symbol, c.entry, c.direction);
      if (!con) { noContract++; return null; }

      const bars = await optionSession(con.instrumentKey, day, series.expiry).catch((e) => {
        if (e instanceof PlanRequiredError) throw e;   // no point grinding through 200 more
        return [] as OptionBar[];
      });
      const at = bars.find((b) => b.minute === c.minute) ?? bars.find((b) => b.minute >= c.minute);
      if (!bars.length || !at || !(at.close > 0)) { noCandles++; return null; }

      // The alert fires on the minute's close, so that is the bar the entry is taken on.
      const paid = round(at.close);
      const lotSize = c.lotSize ?? uni.bySymbol.get(c.symbol)?.future?.lotSize ?? 0;
      const size = lotSize * cfg.lots;

      const g = gradePath(bars, paid, at.minute, cfg.tpPct, cfg.slPct, cfg.squareOffMin);
      const exitPremium = round(paid * (1 + g.pct));
      const amountUsed = size > 0 ? round(paid * size) : null;
      const grossPnl = amountUsed === null ? null : round((exitPremium - paid) * size);
      const charges = grossPnl === null ? null : round(cfg.chargePerLot * cfg.lots);
      const netPnl = grossPnl === null ? null : round(grossPnl - (charges ?? 0));

      const shadow: JournalShadow[] = SHADOW.map((s) => {
        const w = gradePath(bars, paid, at.minute, s.tp, s.sl, cfg.squareOffMin);
        return { name: s.name, pct: round(w.pct, 4), out: w.out, minute: w.minute };
      });

      priced.push({ day, symbol: c.symbol, bars, paid, entryMinute: at.minute, size });

      const entryAt = atOf(day, at.minute);
      const t: JournalTrade = {
        id: `${day}:displacement:${c.symbol}`,
        day,
        channel: 'displacement',
        symbol: c.symbol,
        direction: c.direction,
        contract: {
          label: `${con.strike} ${con.type}`,
          strike: con.strike,
          type: con.type,
          instrumentKey: con.instrumentKey,
          expiry: series.expiry,
          lotSize,
        },
        lots: cfg.lots,
        entry: { at: entryAt, minute: at.minute, premium: paid, spot: round(c.entry), source: 'auto' },
        exit: {
          at: atOf(day, g.minute), minute: g.minute, premium: exitPremium, spot: null,
          source: 'auto', reason: g.out === 'close' ? 'square-off' : g.out,
        },
        mark: null,
        mfePct: round(g.mfe, 4),
        maePct: round(g.mae, 4),
        mfeMinute: g.mfeMinute,
        maeMinute: g.maeMinute,
        // Deliberately null: candles carry no book, and a guessed spread is worse than a gap.
        spreadPctAtEntry: null,
        // The hold-to-close counterfactual, from the same bars the grade came from.
        dayEnd: dayEndOf(bars, paid, at.minute, size, cfg.lots, cfg.squareOffMin),
        amountUsed, grossPnl, charges, netPnl,
        netPct: netPnl === null || !amountUsed ? null : round(netPnl / amountUsed, 4),
        shadow,
        readings: {
          [BACKFILL_FLAG]: 1,
          rvol: round(c.rvol), rangeAtr: round(c.rangeAtr), moveAtr: round(c.moveAtr),
          offExtremeAtr: round(c.offExtremeAtr), atr: round(c.atr),
          turnoverCr: round(c.turnoverCr, 1), changePct: round(c.changePct),
        },
        note: 'BACKFILL — replayed signal, real option candles. Entry is a traded price, not the ask.',
        status: 'closed',
        settled: true,
        edited: false,
        updatedAt: Date.now(),
      };
      return t;
    }));
    for (const t of built) if (t) rows.push(t);
    process.stdout.write(`\r  pricing ${Math.min(i + BATCH, signals.length)}/${signals.length}  priced ${rows.length}   `);
  }

  console.log(`\n\n  ${rows.length} priced · ${noContract} without a listed strike · ${noCandles} without candles\n`);

  // `--list` prints each trade, for reading a single missed session without writing it.
  if (argv.includes('--list')) {
    for (const t of [...rows].sort((a, b) => a.entry.at - b.entry.at))
      console.log(
        `  ${t.day}  ${clock(t.entry.minute)}  ${t.symbol.padEnd(12)} ${String(t.contract?.label).padEnd(10)} ` +
        `in ${String(t.entry.premium).padStart(7)}  out ${String(t.exit?.premium).padStart(7)} ` +
        `${clock(t.exit?.minute ?? 0)} ${String(t.exit?.reason).padEnd(10)} ` +
        `used ${String(t.amountUsed).padStart(8)}  net ${String(t.netPnl).padStart(9)}  ` +
        `(${(100 * (t.netPct ?? 0)).toFixed(1)}%)  peak ${(100 * (t.mfePct ?? 0)).toFixed(0)}% low ${(100 * (t.maePct ?? 0)).toFixed(0)}%`,
      );
    console.log('');
  }

  const done = rows.filter((t) => t.netPnl !== null);
  const wins = done.filter((t) => (t.netPnl ?? 0) > 0).length;
  const used = done.reduce((a, t) => a + (t.amountUsed ?? 0), 0);
  const net = done.reduce((a, t) => a + (t.netPnl ?? 0), 0);
  const byOut = rows.reduce<Record<string, number>>((a, t) => {
    const k = t.exit?.reason ?? 'open';
    a[k] = (a[k] ?? 0) + 1;
    return a;
  }, {});

  console.log(`  outcomes      ${Object.entries(byOut).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
  console.log(`  win rate      ${done.length ? ((100 * wins) / done.length).toFixed(1) : '—'}%  (${wins}W / ${done.length - wins}L of ${done.length} priced)`);
  console.log(`  deployed      Rs ${used.toFixed(0)}`);
  console.log(`  net           ${net < 0 ? '-' : '+'}Rs ${Math.abs(net).toFixed(0)}  (${used ? ((100 * net) / used).toFixed(2) : '0'}% on capital used)`);
  console.log(`  vs control    the -7.4% buy-and-hold floor is what this has to beat\n`);

  if (comparing) { compareCaps(rows, [4, 3, 2]); return; }
  if (squaringOff) {
    // Default sweep is 13:00, 14:00, 14:30, 15:00 and the configured 15:15, as minutes from the
    // 09:15 open. `--squareoff 285,360` narrows it, which also focuses the per-trade movers list.
    const asked = (arg('--squareoff') ?? '').split(',').map((x) => Number(x.trim())).filter((x) => Number.isFinite(x) && x > 0);
    compareSquareOff(priced, asked.length ? asked : [225, 285, 315, 345, journalConfig().squareOffMin]);
    return;
  }
  if (dry) { console.log('  --dry, nothing written.\n'); return; }

  // Through `journalRepository()` rather than straight to disk, so a configured Neon gets these in
  // the same pass. Writing local-only would leave them invisible on any other machine until the
  // API next restarted and `journalBoot` happened to push them — which is a confusing way for a
  // shared record to fill up, and impossible to verify at the moment of writing.
  const repo = journalRepository();
  await repo.save(rows);
  await repo.flush().catch(() => {});
  const sync = await repo.status();
  console.log(`  written to .cache/momentum/journal_*.json`);
  console.log(`  store: ${sync.mode} · remote ${sync.remote}` + (sync.pending ? ` · ${sync.pending} still queued` : ' · nothing queued'));
  if (sync.lastError) console.log(`  last store error: ${sync.lastError}`);
  console.log(`  remove with: npx tsx tools/journal-backfill.ts --clear\n`);
  await closePool();
}

main().catch((e) => { console.error(e); process.exit(1); });

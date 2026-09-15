// npm run replay-trend -- BOSCHLTD NHPC SONACOMS [--day 2026-08-05]
//
// Replay a finished session through the conviction and timing layers, minute by minute, and
// print what the scanner WOULD have said at every point of it.
//
// WHY THIS EXISTS. The rest of this module can only be observed live, one cycle at a time,
// during the five and a half hours a week when it matters. That is a terrible way to find out
// whether a change to a scoring curve helps: by the time the answer arrives the market has
// moved on, nobody can re-run the same day, and the only evidence available is a memory of
// what the board looked like. This tool makes a session repeatable. Point it at the stocks
// that trended and read off, at 09:45 / 10:30 / 11:15, what the model thought at the time.
//
// WHAT IT PROVES, AND WHAT IT DOES NOT
//
// It proves the shape logic: whether a genuinely one-sided day is classified as one, when the
// phase machine promotes it, how many re-entry triggers fire and where. Those are all pure
// functions of the price and volume path, and the path is exactly what a 1-minute candle
// series is.
//
// It does NOT prove the option side. There is no historical option chain here, so no strike is
// picked and no premium is quoted — the plan prints in the underlying only. A replayed entry
// that looks good in the stock can still be untradable in the contract, and only the live
// board knows that.
//
// THREE APPROXIMATIONS, stated rather than buried:
//
//   VWAP      rebuilt as Σ(typical × volume) ÷ Σvolume with typical = (h+l+c)/3. Upstox's live
//             `average_price` is the exact traded VWAP; this is the standard reconstruction of
//             it and drifts by single-digit basis points on liquid names. Every VWAP-derived
//             reading here — adherence, crossings, slope — inherits that.
//
//   SAMPLING  one reading per minute, against fifteen seconds live. So the pulse windows hold
//             a quarter of the readings they normally would, and `travelled` (the denominator
//             of session efficiency) is understated because intra-minute reversals are
//             invisible. Session efficiency therefore reads HIGH here relative to live. The
//             replay's job is to compare stocks against each other on the same footing, not to
//             reproduce a live number to the decimal.
//
//   NO BOOK   historical candles carry no depth, so liquidity is unscored and every gate that
//             depends on it is skipped rather than failed.

import '../src/env.js';

import { configRepository } from '../src/momentum/config/config.repository.js';
import { buildBaseline, ensureBaseline, getBaseline, type SymbolBaseline } from '../src/momentum/data/baseline.js';
import { historical, inBatches, todaySession, type Candle } from '../src/momentum/data/candles.js';
import { universe } from '../src/momentum/data/universe.js';
// The candle-to-quote reconstruction now lives in the runtime, because the boot-time session
// seed does the same thing for the same reason. Imported rather than duplicated so a change to
// how a replayed session is built can never make the tool disagree with the live board.
import { replayQuotes } from '../src/momentum/data/session-seed.js';
import { computePulse, pulseFactor } from '../src/momentum/services/pulse.service.js';
import { computeConviction, convictionFactor } from '../src/momentum/services/conviction.service.js';
import { buildSignal } from '../src/momentum/engine/signal.service.js';
// The live alert's own gate, imported rather than re-described — see `ignitionFeed`.
import { ENTRY_STATES, minEntryQuality } from '../src/momentum/alerts/ignition.js';
import { minConviction } from '../src/momentum/alerts/trend-day.js';
import { ensureAlertOverrides } from '../src/momentum/alerts/settings.js';
import { observe, type SessionState } from '../src/momentum/data/session-state.js';
import { isoDaysBefore, istDay, minuteOfSession } from '../src/momentum/session.js';
import type { ConvictionReading, MomentumConfig, MomentumSignal } from '../src/momentum/types.js';
import { tokenSet } from '../src/upstox.js';
import { discordConfigured, sendDiscord } from '../src/alerts/discord.js';

const hr = (t: string) => console.log(`\n${'─'.repeat(92)}\n${t}\n${'─'.repeat(92)}`);
const pad = (s: string, n: number) => s.padEnd(n).slice(0, n);
const padL = (s: string, n: number) => s.padStart(n);
const clock = (ms: number) => new Date(ms + 330 * 60_000).toISOString().slice(11, 16);

/* ----------------------------------------------------------------------- the replay --- */

interface Snapshot {
  at: number;
  minute: number;
  ltp: number;
  vwap: number;
  conviction: ConvictionReading;
  signal: MomentumSignal;
  pulseScore: number | null;
  trendScore: number | null;
}

interface Entry {
  at: number;
  price: number;
  direction: 1 | -1;
  kind: string;
  state: string;
  entryQuality: number;
  target: number | null;
  stop: number | null;
  /** Filled in afterwards from the rest of the day — this is the whole point of a replay. */
  bestAfterPct: number | null;
  worstAfterPct: number | null;
  closeAfterPct: number | null;
  hitTarget: boolean | null;
  hitStopFirst: boolean | null;
}

function replaySymbol(
  symbol: string,
  candles: Candle[],
  baseline: SymbolBaseline | undefined,
  cfg: MomentumConfig,
): { snapshots: Snapshot[]; entries: Entry[]; closes: Array<{ at: number; ltp: number }> } {
  const day = candles.length ? candles[0].day : istDay();
  const state: SessionState = { day, symbols: {} };
  const prevClose = baseline?.prevClose ?? candles[0]?.open ?? 0;

  const snapshots: Snapshot[] = [];
  const entries: Entry[] = [];
  const closes: Array<{ at: number; ltp: number }> = [];
  const seenTriggers = new Set<number>();

  const p = cfg.thresholds.pulse;
  const conv = cfg.thresholds.conviction;
  const atr = baseline?.atr ?? 0;

  for (const { quote, at } of replayQuotes(symbol, candles, prevClose)) {
    closes.push({ at, ltp: quote.ltp });

    const reversal = atr > 0 ? atr * p.legReversalAtr : quote.ltp * (p.legReversalPctFloor / 100);
    observe(state, quote, cfg.thresholds.trendStructure.openingRangeMinutes, at, reversal, {
      atr,
      vwapSideBufferAtr: conv.vwapSideBufferAtr,
      spineIntervalMin: conv.spineIntervalMin,
    });

    const symState = state.symbols[symbol];
    const pulse = computePulse(quote, symState, baseline, cfg, at);
    const conviction = computeConviction(symState, baseline, cfg, at);

    const pulseScore = pulseFactor(pulse, cfg).score;
    const trendScore = convictionFactor(conviction, cfg).score;

    // The day's direction, which the live engine gets from the full factor vote. Here it is
    // taken from the conviction read when there is one and from the change on the day
    // otherwise — the other eleven factors need a book, a chain and an index this replay does
    // not have, and inventing them would make the output look more authoritative than it is.
    const direction =
      conviction.ready && conviction.direction !== 'Neutral'
        ? conviction.direction
        : quote.changePct > 0.15
          ? 'Bullish'
          : quote.changePct < -0.15
            ? 'Bearish'
            : 'Neutral';

    const signal = buildSignal({
      quote,
      pulse,
      pulseScore,
      symState,
      baseline,
      openingRange: symState?.openingRange ?? null,
      greeks: null,
      chain: null,
      lotSize: null,
      direction,
      conviction,
      // No order book in a candle, so the liquidity gate is given a passing score rather than
      // a zero — failing every replayed entry on missing depth would hide the thing being
      // tested behind a data limitation.
      liquidityScore: 100,
      config: cfg,
      nowMs: at,
    });

    snapshots.push({
      at, minute: minuteOfSession(at), ltp: quote.ltp, vwap: quote.vwap,
      conviction, signal, pulseScore, trendScore,
    });

    // An entry is recorded once per distinct trigger firing, identified by its timestamp.
    if (
      (signal.action === 'Buy Call' || signal.action === 'Buy Put') &&
      signal.trigger &&
      !seenTriggers.has(signal.trigger.at)
    ) {
      seenTriggers.add(signal.trigger.at);
      entries.push({
        at,
        price: quote.ltp,
        direction: signal.action === 'Buy Call' ? 1 : -1,
        kind: signal.entryKind ?? signal.trigger.kind,
        state: signal.state,
        entryQuality: signal.entryQuality,
        target: signal.plan?.target ?? null,
        stop: signal.plan?.stop ?? null,
        bestAfterPct: null, worstAfterPct: null, closeAfterPct: null,
        hitTarget: null, hitStopFirst: null,
      });
    }
  }

  scoreEntries(entries, closes);
  return { snapshots, entries, closes };
}

/**
 * What each entry actually did, from the rest of the session.
 *
 * `hitStopFirst` is the one that matters and is the reason this walks the path forward rather
 * than comparing to the close: an entry that reached its target after first going through its
 * stop is a loss, and a report that only looked at the best price afterwards would score it a
 * win. Resolution is one minute, so a bar that spans both levels is counted as a stop —
 * the pessimistic reading, because within-bar order is unknowable here.
 */
function scoreEntries(entries: Entry[], closes: Array<{ at: number; ltp: number }>): void {
  for (const e of entries) {
    const after = closes.filter((c) => c.at > e.at);
    if (!after.length) continue;

    let best = e.price;
    let worst = e.price;
    let hitTarget = false;
    let hitStop = false;

    for (const c of after) {
      if (e.direction === 1) {
        best = Math.max(best, c.ltp);
        worst = Math.min(worst, c.ltp);
        if (e.stop !== null && c.ltp <= e.stop && !hitTarget) { hitStop = true; break; }
        if (e.target !== null && c.ltp >= e.target) { hitTarget = true; break; }
      } else {
        best = Math.min(best, c.ltp);
        worst = Math.max(worst, c.ltp);
        if (e.stop !== null && c.ltp >= e.stop && !hitTarget) { hitStop = true; break; }
        if (e.target !== null && c.ltp <= e.target) { hitTarget = true; break; }
      }
    }

    const pct = (v: number) => ((v - e.price) / e.price) * 100 * e.direction;
    e.bestAfterPct = +pct(best).toFixed(2);
    e.worstAfterPct = +pct(worst).toFixed(2);
    e.closeAfterPct = +pct(after[after.length - 1].ltp).toFixed(2);
    e.hitTarget = hitTarget;
    e.hitStopFirst = hitStop;
  }
}

/* ------------------------------------------------------------------------ printing --- */

function printSymbol(symbol: string, r: ReturnType<typeof replaySymbol>, cfg: MomentumConfig): void {
  const { snapshots, entries } = r;
  if (!snapshots.length) {
    console.log(`\n${symbol}: no candles for this day`);
    return;
  }

  const last = snapshots[snapshots.length - 1];
  const first = snapshots[0];
  const dayPct = ((last.ltp - first.ltp) / first.ltp) * 100;

  hr(`${symbol}   ${dayPct >= 0 ? '+' : ''}${dayPct.toFixed(2)}% on the day`);

  // The timeline. Every 30 minutes, which is enough to see a phase machine work and few
  // enough lines to read three stocks at once.
  console.log(
    pad('time', 7) + padL('ltp', 10) + padL('conv', 6) + pad('  phase', 12) +
    padL('adh', 6) + padL('xing', 5) + padL('eff', 6) + padL('dip', 6) +
    padL('intra', 7) + padL('true', 6) + padL('gap', 6) + padL('budget', 8) +
    pad('  state', 11) + pad('action', 12) + padL('pulse', 6),
  );

  let lastPrinted = -99;
  for (const s of snapshots) {
    const isMark = s.minute - lastPrinted >= 30;
    if (!isMark) continue;
    lastPrinted = s.minute;

    const c = s.conviction;
    const x = s.signal.extension;
    console.log(
      pad(clock(s.at), 7) +
        padL(s.ltp.toFixed(2), 10) +
        padL(c.ready ? c.score.toFixed(0) : '—', 6) +
        pad('  ' + c.phase, 12) +
        padL(c.vwapAdherence === null ? '—' : (c.vwapAdherence * 100).toFixed(0) + '%', 6) +
        padL(c.vwapCrossings === null ? '—' : String(c.vwapCrossings), 5) +
        padL(c.sessionEfficiency === null ? '—' : c.sessionEfficiency.toFixed(2), 6) +
        padL(c.deepestPullbackAtr === null ? '—' : c.deepestPullbackAtr.toFixed(2), 6) +
        padL(x.atrUsed === null ? '—' : x.atrUsed.toFixed(2), 7) +
        padL(x.trueRangeAtrUsed === null ? '—' : x.trueRangeAtrUsed.toFixed(2), 6) +
        padL(x.gapAtr === null ? '—' : x.gapAtr.toFixed(2), 6) +
        padL(x.atrUsedMax.toFixed(2), 8) +
        pad('  ' + s.signal.state, 11) +
        pad(s.signal.action, 12) +
        padL(s.pulseScore === null ? '—' : s.pulseScore.toFixed(0), 6),
    );
  }

  // THE COMPARISON THAT MATTERS. How much of the session the OLD ceiling would have refused,
  // against how much the conviction-scaled one does.
  const oldMax = cfg.signal.extension.atrUsedMax;
  const measurable = snapshots.filter((s) => s.signal.extension.atrUsed !== null);
  const spentOld = measurable.filter((s) => (s.signal.extension.atrUsed ?? 0) >= oldMax).length;
  const spentNew = measurable.filter((s) => s.signal.extension.extended).length;

  if (measurable.length) {
    console.log(
      `\n  extension ceiling: the old fixed ${oldMax} ATR would have read "spent" for ` +
        `${((spentOld / measurable.length) * 100).toFixed(0)}% of the session ` +
        `(${spentOld}/${measurable.length} minutes); the conviction-scaled budget reads spent for ` +
        `${((spentNew / measurable.length) * 100).toFixed(0)}%.`,
    );
  }

  const confirmedAt = snapshots.find((s) => s.conviction.phase === 'Confirmed');
  const formingAt = snapshots.find((s) => s.conviction.phase === 'Forming');
  console.log(
    `  phase: ${formingAt ? `Forming from ${clock(formingAt.at)}` : 'never Formed'}` +
      `, ${confirmedAt ? `Confirmed from ${clock(confirmedAt.at)}` : 'never Confirmed'}` +
      `, peak conviction ${Math.max(...snapshots.map((s) => s.conviction.score)).toFixed(0)}`,
  );

  // WHY IT SAID NOTHING. Without this a silent stock is indistinguishable from a broken
  // pipeline, and the two want opposite responses — one is the model working and the other is
  // a threshold set somewhere no real stock reaches.
  const counts = new Map<string, number>();
  for (const s of snapshots) {
    for (const b of s.signal.blockers) {
      // Collapse the numbers out so "pulse 41 is below 55" and "pulse 12 is below 55" are one
      // line rather than three hundred.
      const key = b.replace(/-?[\d.]+/g, '#').slice(0, 78);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  if (ranked.length) {
    console.log('\n  what stopped an entry, by how many minutes of the session it stopped one:');
    for (const [text, n] of ranked)
      console.log(`    ${padL(String(n), 4)}m  ${text}`);
  }

  // ---- the entries ----
  if (!entries.length) {
    console.log('\n  entries: NONE — the model would have said nothing tradable all day.');
    return;
  }

  console.log(`\n  entries: ${entries.length}`);
  console.log(
    '  ' + pad('time', 7) + pad('kind', 11) + pad('state', 11) + padL('price', 10) +
    padL('stop', 9) + padL('target', 9) + padL('EQ', 4) + padL('best', 8) + padL('worst', 8) +
    padL('close', 8) + '  result',
  );
  for (const e of entries) {
    const result = e.hitStopFirst ? 'STOPPED' : e.hitTarget ? 'target hit' : 'open at close';
    console.log(
      '  ' + pad(clock(e.at), 7) +
        pad(e.kind, 11) +
        pad(e.state, 11) +
        padL(e.price.toFixed(2), 10) +
        padL(e.stop?.toFixed(2) ?? '—', 9) +
        padL(e.target?.toFixed(2) ?? '—', 9) +
        padL(String(e.entryQuality), 4) +
        padL(e.bestAfterPct === null ? '—' : `${e.bestAfterPct >= 0 ? '+' : ''}${e.bestAfterPct}%`, 8) +
        padL(e.worstAfterPct === null ? '—' : `${e.worstAfterPct}%`, 8) +
        padL(e.closeAfterPct === null ? '—' : `${e.closeAfterPct >= 0 ? '+' : ''}${e.closeAfterPct}%`, 8) +
        '  ' + result,
    );
  }

  const won = entries.filter((e) => e.hitTarget).length;
  const lost = entries.filter((e) => e.hitStopFirst).length;
  const open = entries.length - won - lost;
  // Sum of what each entry returned IN THE STOCK, taking the stop when it was hit first and
  // the target when it was reached. Not a P&L — the option is where the leverage and the
  // spread live, and neither is knowable from a candle.
  const net = entries.reduce(
    (a, e) => a + (e.hitStopFirst ? (e.worstAfterPct ?? 0) : e.hitTarget ? (e.bestAfterPct ?? 0) : (e.closeAfterPct ?? 0)),
    0,
  );
  console.log(
    `  → ${won} reached target, ${lost} stopped, ${open} still open at the close; ` +
      `net ${net >= 0 ? '+' : ''}${net.toFixed(2)}% summed across entries, in the STOCK`,
  );
}

/* ------------------------------------------------------------------ the whole board --- */

/**
 * One line per stock, for replaying the universe rather than a handful of names.
 *
 * The per-symbol timeline above is the right output for three stocks and unreadable for two
 * hundred — it prints a dozen lines each. This keeps only what distinguishes one day from
 * another, so a finished session comes back as the board it WOULD have been, sorted the way the
 * Trend Day page sorts it.
 */
interface Summary {
  symbol: string;
  dayPct: number;
  peak: number;
  finalPhase: string;
  direction: string;
  formedAt: number | null;
  confirmedAt: number | null;
  entries: number;
  won: number;
  lost: number;
  netPct: number;
}

function summarise(symbol: string, r: ReturnType<typeof replaySymbol>): Summary | null {
  const { snapshots, entries } = r;
  if (!snapshots.length) return null;

  const first = snapshots[0];
  const last = snapshots[snapshots.length - 1];
  const formed = snapshots.find((s) => s.conviction.phase === 'Forming');
  const confirmed = snapshots.find((s) => s.conviction.phase === 'Confirmed');

  return {
    symbol,
    dayPct: ((last.ltp - first.ltp) / first.ltp) * 100,
    peak: Math.max(...snapshots.map((s) => s.conviction.score)),
    finalPhase: last.conviction.phase,
    direction: last.conviction.direction,
    formedAt: formed?.at ?? null,
    confirmedAt: confirmed?.at ?? null,
    entries: entries.length,
    won: entries.filter((e) => e.hitTarget).length,
    lost: entries.filter((e) => e.hitStopFirst).length,
    netPct: entries.reduce(
      (a, e) => a + (e.hitStopFirst ? (e.worstAfterPct ?? 0) : e.hitTarget ? (e.bestAfterPct ?? 0) : (e.closeAfterPct ?? 0)),
      0,
    ),
  };
}

/**
 * Replay every stock in the F&O universe for one day.
 *
 * One candle request per symbol, eight at a time behind the same breaker the baseline uses —
 * the same ~208 requests the live scanner's boot seed spends, for a day of your choosing. Only
 * the summary of each replay is retained; the per-minute snapshots are dropped as each symbol
 * finishes, or two hundred sessions of them would sit in memory at once.
 */
/** One trend-day confirmation, in the shape the outcome scorer already understands. */
interface Confirmation extends Entry {
  symbol: string;
  conviction: number;
  heldMin: number | null;
  adherence: number | null;
  crossings: number | null;
}

/**
 * The moment the LIVE trend-day alert would have announced this stock — or null if it never would.
 *
 * Mirrors `newlyConfirmed` in alerts/trend-day.ts rather than approximating it: the phase must be
 * `Confirmed`, the direction must be Bullish or Bearish, the conviction must clear the same env
 * floor the running alert reads, and the announcement must land inside the ten-minute freshness
 * window that makes the message "this just happened". The floor is applied at the ANNOUNCING tick
 * rather than at the phase change, which is what the live path does — a stock that confirms at 62
 * and climbs to 70 four minutes later is announced then, not skipped.
 *
 * The stop and target are the row's own signal plan at that instant. The live message uses
 * `buildTrendDayPlan`, which is pinned to trend mode and can differ slightly; this replay has no
 * option chain to build that against, so the levels below are the closest honest stand-in and the
 * output says so.
 */
function confirmationOf(symbol: string, r: ReturnType<typeof replaySymbol>): Confirmation | null {
  const floor = minConviction();
  const first = r.snapshots.find((s) => s.conviction.phase === 'Confirmed');
  if (!first) return null;

  const confirmedAt = first.conviction.confirmedAt ?? first.at;
  const announce = r.snapshots.find(
    (s) =>
      s.conviction.phase === 'Confirmed' &&
      (s.conviction.direction === 'Bullish' || s.conviction.direction === 'Bearish') &&
      s.conviction.score >= floor &&
      s.at - confirmedAt <= 10 * 60_000,
  );
  if (!announce) return null;

  const direction: 1 | -1 = announce.conviction.direction === 'Bullish' ? 1 : -1;
  return {
    symbol,
    at: announce.at,
    price: announce.ltp,
    direction,
    kind: 'confirmed',
    state: announce.signal.state,
    entryQuality: announce.signal.entryQuality,
    target: announce.signal.plan?.target ?? null,
    stop: announce.signal.plan?.stop ?? null,
    conviction: announce.conviction.score,
    heldMin: announce.conviction.heldMin ?? null,
    adherence: announce.conviction.vwapAdherence ?? null,
    crossings: announce.conviction.vwapCrossings ?? null,
    bestAfterPct: null, worstAfterPct: null, closeAfterPct: null,
    hitTarget: null, hitStopFirst: null,
  };
}

async function replayAll(
  day: string,
  members: Array<{ symbol: string; equityKey: string }>,
  baseline: Awaited<ReturnType<typeof getBaseline>>['baseline'],
  cfg: MomentumConfig,
  /** Also keep every raw entry, which the ignition feed filters rather than summarises. */
  keepEntries = false,
): Promise<{
  rows: Summary[];
  entries: Array<Entry & { symbol: string }>;
  confirmations: Confirmation[];
  scanned: number;
  empty: number;
  failed: number;
}> {
  const rows: Summary[] = [];
  const entries: Array<Entry & { symbol: string }> = [];
  const confirmations: Confirmation[] = [];
  let scanned = 0;
  let empty = 0;
  let failed = 0;
  const isToday = day === istDay();

  await inBatches(members, 8, async (m) => {
    try {
      const candles = isToday
        ? await todaySession(m.equityKey, day, 1)
        : await historical(m.equityKey, 'minutes', 1, day, day);
      const forDay = candles.filter((c) => c.day === day);
      if (!forDay.length) {
        empty++;
        return;
      }
      const replayed = replaySymbol(m.symbol, forDay, baseline?.symbols[m.symbol], cfg);
      const s = summarise(m.symbol, replayed);
      if (s) rows.push(s);
      if (keepEntries) for (const e of replayed.entries) entries.push({ ...e, symbol: m.symbol });
      if (keepEntries) {
        const c = confirmationOf(m.symbol, replayed);
        // Scored against the same forward path the entries use, so "what happened next" means
        // the same thing on both lists and the two can be compared directly.
        if (c) {
          scoreEntries([c], replayed.closes);
          confirmations.push(c);
        }
      }
      scanned++;
      // A long run with no output looks like a hang, and this one takes a couple of minutes.
      if (scanned % 25 === 0) process.stderr.write(`  …${scanned} replayed\n`);
    } catch {
      failed++;
    }
  });

  return { rows, entries, confirmations, scanned, empty, failed };
}

/**
 * The messages the ignition alert would actually have sent, in the order they would have arrived.
 *
 * THE GATE HERE IS THE LIVE ONE, not a re-description of it. `ENTRY_STATES` and the once-per-
 * symbol-per-direction rule are imported from `alerts/ignition.ts`, and the entry-quality floor
 * defaults to `minEntryQuality()` — the same function the running alert calls. A backtest that
 * re-implemented those would drift from the alert within a week and quietly start reporting a
 * strategy nobody is running, which is the standard way a backtest becomes a lie.
 *
 * Two gates in the live path genuinely cannot be reproduced here and both are stated in the
 * output rather than glossed: trigger freshness is automatic in a replay (an entry is recorded
 * at the moment its trigger fires) and there is no order book, so the liquidity component of
 * entry quality is unscored. Neither adds signals — the live feed is a subset of this one.
 */
function ignitionFeed(
  entries: Array<Entry & { symbol: string }>,
  floor: number,
): Array<Entry & { symbol: string }> {
  const seen = new Set<string>();
  return entries
    .filter((e) => ENTRY_STATES.has(e.state) && e.entryQuality >= floor)
    .sort((a, b) => a.at - b.at)
    .filter((e) => {
      const k = `${e.symbol}|${e.direction}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
}

/**
 * Push the replayed feed to Discord.
 *
 * EVERY MESSAGE CARRIES A BANNER, and that is not decoration. This posts into the same channel
 * the live trend-day alerts arrive in, and the rows below are real symbols with real entry, stop
 * and target prices — exactly the shape of a message that is acted on. A reader scrolling back a
 * week has no way to tell a replayed 09:19 ASTRAL PUT from a live one unless every single chunk
 * says so, so the banner is repeated per message rather than sent once at the top where it would
 * scroll away. `previewAlerts` in trend-day.ts takes the same position for the same reason: a
 * fabricated stop against a real symbol is a number somebody could act on.
 */
async function sendFeedToDiscord(
  day: string,
  feed: Array<Entry & { symbol: string }>,
  floor: number,
  out: Awaited<ReturnType<typeof replayAll>>,
): Promise<void> {
  if (!discordConfigured()) {
    console.log('\n  ! DISCORD_WEBHOOK_URL is not set — nothing sent.');
    return;
  }

  const won = feed.filter((e) => e.hitTarget && !e.hitStopFirst).length;
  const lost = feed.filter((e) => e.hitStopFirst).length;
  const net = feed.reduce((a, e) => a + (e.closeAfterPct ?? 0), 0);

  const banner = (part: number, parts: number) =>
    `⚡ **IGNITION BACKTEST — NOT LIVE SIGNALS** · ${day} · part ${part}/${parts}\n` +
    '_Experimental early-entry feed, replayed. Already expired. Do not trade them._\n';

  const line = (e: Entry & { symbol: string }): string => {
    const t = new Date(e.at + 330 * 60_000).toISOString().slice(11, 16);
    const mark = e.hitStopFirst ? '❌' : e.hitTarget ? '✅' : '⬜';
    return (
      `${mark} \`${t}\` **${e.symbol}** ${e.direction === 1 ? 'CALL' : 'PUT'} · ` +
      `${e.price.toFixed(2)} → T ${e.target?.toFixed(2) ?? '—'} / S ${e.stop?.toFixed(2) ?? '—'} · ` +
      `EQ ${e.entryQuality.toFixed(0)} · close ${e.closeAfterPct === null ? '—' : `${e.closeAfterPct >= 0 ? '+' : ''}${e.closeAfterPct.toFixed(2)}%`}`
    );
  };

  // Packed against the embed cap with the per-message banner already accounted for.
  const CHUNK = 3600;
  const pages: string[][] = [];
  let page: string[] = [];
  let size = 0;
  for (const e of feed) {
    const l = line(e);
    if (page.length && size + l.length + 1 > CHUNK) {
      pages.push(page);
      page = [];
      size = 0;
    }
    page.push(l);
    size += l.length + 1;
  }
  if (page.length) pages.push(page);

  const total = pages.length + 1; // + the verdict
  console.log(`\n  sending ${feed.length} rows to Discord as ${total} messages…`);

  let ok = 0;
  for (const [i, p] of pages.entries()) {
    // Sequential, with a gap: Discord rate limits a webhook at roughly five requests per two
    // seconds and answers 429 past that, which would silently drop the tail of the list.
    if (i) await new Promise((r) => setTimeout(r, 1200));
    if (await sendDiscord(`${banner(i + 1, total)}\n${p.join('\n')}`)) ok++;
  }

  await new Promise((r) => setTimeout(r, 1200));
  const verdict =
    `${banner(total, total)}\n` +
    `**Verdict — ${day}**\n` +
    `\`\`\`\n` +
    `alerts sent     : ${feed.length}   (entry quality ≥ ${floor})\n` +
    `reached target  : ${won} (${feed.length ? ((won / feed.length) * 100).toFixed(0) : 0}%)\n` +
    `stopped out     : ${lost}\n` +
    `open at close   : ${feed.length - won - lost}\n` +
    `net             : ${net >= 0 ? '+' : ''}${net.toFixed(2)}%  in the STOCK, before costs\n` +
    `universe        : ${out.scanned}/${out.scanned + out.empty + out.failed} stocks replayed\n` +
    `\`\`\`\n` +
    '_Underlying only — no option chain, no slippage, no order book. One session, and a ' +
    'rotational one. This is a measurement, not a strategy._';
  if (await sendDiscord(verdict)) ok++;

  console.log(`  ${ok}/${total} messages delivered.`);
}

/**
 * The trend-day confirmations — the list your phone ACTUALLY receives today.
 *
 * Kept separate from the ignition feed rather than folded into it, because the two answer opposite
 * questions and averaging them would hide both: this one is "is the alert I already run worth
 * running", and the ignition feed is "is the alert I am considering worth switching on".
 */
/** Direction-adjusted outcome: a PUT on a stock that fell is a WIN. */
/**
 * The confirmation's outcome, in the direction the alert named.
 *
 * ALREADY DIRECTION-ADJUSTED AT SOURCE — `scoreEntries` multiplies by `e.direction` when it fills
 * `bestAfterPct` / `worstAfterPct` / `closeAfterPct`, so a PUT on a stock that fell is stored as a
 * POSITIVE number. Multiplying by `direction` a second time here inverted every bearish row: on
 * 2026-08-14, 33 of 46 confirmations were PUTs, so the reported win rate and net were largely a
 * sign error rather than a result. NMDC PUT closed −1.14% — a loss — and was published as a ✅
 * +1.14% win. The ignition feed never had this fault because it reads `closeAfterPct` directly.
 */
const gainOf = (c: Confirmation): number => c.closeAfterPct ?? 0;

/**
 * Which properties of a confirmation separate the ones that worked from the ones that did not.
 *
 * THE POINT OF POOLING DAYS. A single session gives ~46 confirmations, and slicing 46 rows four
 * ways leaves buckets of eight. At that size the best-looking bucket is noise: with five time
 * buckets there is roughly a nine-in-ten chance that at least one clears +5% net on a coin-flip
 * signal alone. A filter fitted to that would look excellent on the day it came from and do
 * nothing afterwards, which is worse than no filter — it would be trusted.
 *
 * So every cut below is printed with its sample count beside it, and the caller is expected to
 * have pooled several sessions. A bucket under ~30 is decoration, not evidence.
 */
function printConfirmedPatterns(feed: Confirmation[], days: string[]): void {
  if (!feed.length) return;

  const cut = (label: string, of: (c: Confirmation) => string, order: string[]): void => {
    console.log(
      `\n  ${pad(label, 16)}${padL('n', 5)}${padL('right', 7)}${padL('win%', 7)}${padL('avg%', 8)}${padL('net%', 9)}`,
    );
    for (const k of order) {
      const g = feed.filter((c) => of(c) === k);
      if (!g.length) continue;
      const w = g.filter((c) => gainOf(c) > 0).length;
      const n = g.reduce((a, c) => a + gainOf(c), 0);
      console.log(
        `  ${pad(k, 16)}${padL(String(g.length), 5)}${padL(String(w), 7)}` +
          `${padL(`${((w / g.length) * 100).toFixed(0)}%`, 7)}` +
          `${padL(`${n / g.length >= 0 ? '+' : ''}${(n / g.length).toFixed(2)}`, 8)}` +
          `${padL(`${n >= 0 ? '+' : ''}${n.toFixed(1)}`, 9)}` +
          (g.length < 30 ? '   (thin)' : ''),
      );
    }
  };

  hr(`What separates the ${feed.length} confirmations that worked from the ones that did not`);
  console.log(`  pooled across ${days.length} session${days.length === 1 ? '' : 's'}: ${days.join(', ')}`);

  cut(
    'by hour',
    (c) => {
      const m = minuteOfSession(c.at);
      if (m < 90) return '10:30–10:45';
      if (m < 135) return '10:45–11:30';
      if (m < 195) return '11:30–12:30';
      if (m < 285) return '12:30–14:00';
      return '14:00–15:30';
    },
    ['10:30–10:45', '10:45–11:30', '11:30–12:30', '12:30–14:00', '14:00–15:30'],
  );

  cut(
    'by conviction',
    (c) => (c.conviction >= 85 ? 'conv 85+' : c.conviction >= 78 ? 'conv 78–84' : c.conviction >= 73 ? 'conv 73–77' : 'conv 65–72'),
    ['conv 65–72', 'conv 73–77', 'conv 78–84', 'conv 85+'],
  );

  cut(
    'by adherence',
    (c) =>
      c.adherence === null ? 'adher —' : c.adherence >= 0.99 ? 'adher 99–100%' : c.adherence >= 0.96 ? 'adher 96–98%' : 'adher <96%',
    ['adher <96%', 'adher 96–98%', 'adher 99–100%', 'adher —'],
  );

  cut(
    'by crossings',
    (c) => (c.crossings === null ? 'xing —' : c.crossings === 0 ? 'xing 0' : c.crossings <= 2 ? 'xing 1–2' : 'xing 3+'),
    ['xing 0', 'xing 1–2', 'xing 3+', 'xing —'],
  );

  cut('by side', (c) => (c.direction === 1 ? 'CALL' : 'PUT'), ['CALL', 'PUT']);

  // The one that has shown up on every list so far, and the only one that needs no new signal
  // work: entries reach real profit and hand it back because nothing ever closes them.
  const reached = (t: number) => feed.filter((c) => (c.bestAfterPct ?? 0) * c.direction >= t).length;
  hr('How many reached a profit they were never taken out at');
  for (const t of [0.3, 0.5, 0.75, 1.0, 1.5]) {
    const n = reached(t);
    console.log(
      `  touched +${t.toFixed(2)}% at some point : ${String(n).padStart(4)} of ${feed.length}` +
        ` (${((n / feed.length) * 100).toFixed(0)}%)`,
    );
  }
  const held = feed.reduce((a, c) => a + gainOf(c), 0);
  for (const t of [0.3, 0.5, 0.75]) {
    // Take the first touch of +t, else whatever it closed at. The stop is unchanged, so this is
    // an EXIT rule and nothing else — no entry is added or removed.
    const withExit = feed.reduce(
      (a, c) => a + ((c.bestAfterPct ?? 0) * c.direction >= t ? t : gainOf(c)),
      0,
    );
    console.log(
      `  net taking +${t.toFixed(2)}% when offered : ${withExit >= 0 ? '+' : ''}${withExit.toFixed(1)}%` +
        `  (against ${held >= 0 ? '+' : ''}${held.toFixed(1)}% held to close)`,
    );
  }
  console.log(
    '\n  Upper bound, not a backtest: it assumes the target is taken on the first touch and ignores\n' +
    '  that a stop could have been hit on the way there. Treat it as "is an exit rule worth\n' +
    '  building", which is a question this can answer, rather than "what would it have made".',
  );
}

async function reportConfirmed(
  day: string,
  out: Awaited<ReturnType<typeof replayAll>>,
  toDiscord: boolean,
): Promise<void> {
  const feed = [...out.confirmations].sort((a, b) => a.at - b.at);
  const universeSize = out.scanned + out.empty + out.failed;

  hr(`Trend-day confirmations — the alerts your phone actually sends, ${day}`);
  console.log(
    `${out.scanned}/${universeSize} stocks replayed` +
      (out.failed ? `, ${out.failed} FAILED (rate limit or refused)` : '') +
      `\n${feed.length} confirmations cleared the live gate (conviction ≥ ${minConviction()}, announced within 10m)\n`,
  );

  if (out.scanned < universeSize * 0.8)
    console.log(
      `  ⚠️  ONLY ${out.scanned} OF ${universeSize} STOCKS REPLAYED — the list below is a fraction, not the day.\n`,
    );

  if (!feed.length) {
    console.log('  none — nothing held a one-sided shape long enough to be announced.');
    return;
  }

  console.log(
    `  ${pad('time', 7)}${pad('symbol', 13)}${pad('dir', 6)}${padL('price', 11)}${padL('conv', 6)}` +
      `${padL('held', 6)}${padL('adher', 7)}${padL('xing', 6)}${padL('best', 8)}${padL('worst', 8)}${padL('close', 8)}`,
  );
  for (const c of feed)
    console.log(
      `  ${pad(clock(c.at), 7)}${pad(c.symbol, 13)}${pad(c.direction === 1 ? 'CALL' : 'PUT', 6)}` +
        `${padL(c.price.toFixed(2), 11)}${padL(c.conviction.toFixed(0), 6)}` +
        `${padL(c.heldMin === null ? '—' : `${c.heldMin.toFixed(0)}m`, 6)}` +
        `${padL(c.adherence === null ? '—' : `${(c.adherence * 100).toFixed(0)}%`, 7)}` +
        `${padL(c.crossings === null ? '—' : String(c.crossings), 6)}` +
        `${padL(c.bestAfterPct === null ? '—' : `+${c.bestAfterPct.toFixed(2)}%`, 8)}` +
        `${padL(c.worstAfterPct === null ? '—' : `${c.worstAfterPct.toFixed(2)}%`, 8)}` +
        `${padL(c.closeAfterPct === null ? '—' : `${c.closeAfterPct >= 0 ? '+' : ''}${c.closeAfterPct.toFixed(2)}%`, 8)}`,
    );

  // The number that answers the question. Direction-adjusted: a PUT confirmation that fell is a
  // WIN, and reading the raw stock move would score every bearish confirmation backwards.
  // The same helper the pattern cuts use. It was duplicated here with the same sign fault, so
  // the table and the summary agreed with each other and both disagreed with reality.
  const gain = gainOf;
  const winners = feed.filter((c) => gain(c) > 0).length;
  const net = feed.reduce((a, c) => a + gain(c), 0);
  const avg = feed.length ? net / feed.length : 0;

  hr('Held from the alert to the close, in the direction the alert named');
  console.log(`  confirmations   : ${feed.length}`);
  console.log(`  went the right way: ${winners} (${feed.length ? ((winners / feed.length) * 100).toFixed(0) : 0}%)`);
  console.log(`  average per alert : ${avg >= 0 ? '+' : ''}${avg.toFixed(2)}%`);
  console.log(`  net summed        : ${net >= 0 ? '+' : ''}${net.toFixed(2)}%  in the STOCK, before costs`);
  console.log(
    '\n  Underlying only, held to 15:30 — no option chain, no slippage, no exit rule. One session.',
  );

  if (!toDiscord) return;
  if (!discordConfigured()) {
    console.log('\n  ! DISCORD_WEBHOOK_URL is not set — nothing sent.');
    return;
  }

  const banner = (part: number, parts: number) =>
    // THE FLOOR IS IN THE BANNER because the same day can be replayed at several of them, and
    // two "CONFIRMED BACKTEST · 2026-08-14" blocks sitting in the channel with different rows and
    // no way to tell which gate produced which is worse than not sending the second one.
    `🔔 **CONFIRMED BACKTEST · conviction ≥ ${minConviction()}** — NOT LIVE SIGNALS · ${day} · part ${part}/${parts}\n` +
    '_The alert you actually run today, replayed at this floor. Already expired. Do not trade them._\n';

  const line = (c: Confirmation): string => {
    const g = gain(c);
    const mark = g > 0.5 ? '✅' : g < -0.5 ? '❌' : '⬜';
    return (
      `${mark} \`${clock(c.at)}\` **${c.symbol}** ${c.direction === 1 ? 'CALL' : 'PUT'} · ` +
      // Bold and backticked, so the score is the thing the eye lands on when scanning a list of
      // forty rows — it is the number the floor gates on and the one being judged here.
      `${c.price.toFixed(2)} · 🎯 **\`CONV ${c.conviction.toFixed(0)}\`** · ` +
      `held ${c.heldMin === null ? '—' : `${c.heldMin.toFixed(0)}m`} · ` +
      `adher ${c.adherence === null ? '—' : `${(c.adherence * 100).toFixed(0)}%`} · ` +
      `**${g >= 0 ? '+' : ''}${g.toFixed(2)}%** to close`
    );
  };

  const CHUNK = 3600;
  const pages: string[][] = [];
  let page: string[] = [];
  let size = 0;
  for (const c of feed) {
    const l = line(c);
    if (page.length && size + l.length + 1 > CHUNK) { pages.push(page); page = []; size = 0; }
    page.push(l);
    size += l.length + 1;
  }
  if (page.length) pages.push(page);

  const total = pages.length + 1;
  console.log(`\n  sending ${feed.length} confirmations to Discord as ${total} messages…`);
  let ok = 0;
  for (const [i, p] of pages.entries()) {
    if (i) await new Promise((r) => setTimeout(r, 1200));
    if (await sendDiscord(`${banner(i + 1, total)}\n${p.join('\n')}`)) ok++;
  }
  await new Promise((r) => setTimeout(r, 1200));
  if (
    await sendDiscord(
      `${banner(total, total)}\n**TREND-DAY CONFIRMATIONS — ${day}**\n\`\`\`\n` +
        `conviction floor  : ${minConviction()}\n` +
        `confirmations     : ${feed.length}\n` +
        `went the right way: ${winners} (${feed.length ? ((winners / feed.length) * 100).toFixed(0) : 0}%)\n` +
        `average per alert : ${avg >= 0 ? '+' : ''}${avg.toFixed(2)}%\n` +
        `net summed        : ${net >= 0 ? '+' : ''}${net.toFixed(2)}%\n` +
        `universe          : ${out.scanned}/${universeSize} replayed\n\`\`\`\n` +
        '_Direction-adjusted: a PUT that fell counts as a win. Underlying only, held to 15:30, ' +
        'no exit rule, no option pricing, no slippage. One session._',
    )
  )
    ok++;
  console.log(`  ${ok}/${total} messages delivered.`);
}

async function printIgnitionFeed(
  day: string,
  out: Awaited<ReturnType<typeof replayAll>>,
  floor: number,
  baseline: Awaited<ReturnType<typeof getBaseline>>['baseline'],
  toDiscord = false,
): Promise<void> {
  const feed = ignitionFeed(out.entries, floor);

  const universeSize = out.scanned + out.empty + out.failed;

  hr(`Ignition feed — every alert that would have reached your phone on ${day}`);
  console.log(
    `${out.scanned}/${universeSize} stocks replayed` +
      (out.empty ? `, ${out.empty} served no candles` : '') +
      (out.failed ? `, ${out.failed} FAILED (rate limit or refused)` : '') +
      `\n${out.entries.length} raw entries, ` +
      `${feed.length} would have been SENT (entry quality ≥ ${floor}, one per stock per direction)\n`,
  );

  // SAID LOUDLY, because a feed built from a tenth of the universe still prints a tidy table and
  // a hit rate, and both would be read as the day's result. A spent candle quota is the normal
  // cause: `replayAll` swallows a per-symbol failure so one refusal cannot end the run, which is
  // right for the run and wrong for the reader unless the shortfall is stated.
  if (out.scanned < universeSize * 0.8)
    console.log(
      `  ⚠️  ONLY ${out.scanned} OF ${universeSize} STOCKS WERE ACTUALLY REPLAYED. Everything below is\n` +
      '      drawn from that fraction and is NOT the day\'s feed. The usual cause is a spent Upstox\n' +
      '      candle quota — wait 30 minutes with nothing else running and re-run.\n',
    );

  if (!feed.length) {
    console.log('  none — no stock produced an entry clean enough to announce.');
    return;
  }

  console.log(
    `  ${pad('time', 7)}${pad('symbol', 13)}${pad('dir', 5)}${pad('kind', 11)}${pad('state', 10)}` +
      `${padL('price', 10)}${padL('stop', 10)}${padL('target', 10)}${padL('EQ', 4)}` +
      `${padL('best', 8)}${padL('worst', 8)}${padL('close', 8)}  result`,
  );

  for (const e of feed) {
    const t = new Date(e.at + 330 * 60_000).toISOString().slice(11, 16);
    const result = e.hitStopFirst ? 'STOPPED' : e.hitTarget ? 'target hit' : 'open at close';
    console.log(
      `  ${pad(t, 7)}${pad(e.symbol, 13)}${pad(e.direction === 1 ? 'CALL' : 'PUT', 5)}` +
        `${pad(e.kind, 11)}${pad(e.state, 10)}` +
        `${padL(e.price.toFixed(2), 10)}${padL(e.stop?.toFixed(2) ?? '—', 10)}${padL(e.target?.toFixed(2) ?? '—', 10)}` +
        `${padL(e.entryQuality.toFixed(0), 4)}` +
        `${padL(e.bestAfterPct === null ? '—' : `${e.bestAfterPct >= 0 ? '+' : ''}${e.bestAfterPct.toFixed(2)}%`, 8)}` +
        `${padL(e.worstAfterPct === null ? '—' : `${e.worstAfterPct.toFixed(2)}%`, 8)}` +
        `${padL(e.closeAfterPct === null ? '—' : `${e.closeAfterPct >= 0 ? '+' : ''}${e.closeAfterPct.toFixed(2)}%`, 8)}` +
        `  ${result}`,
    );
  }

  /* ------------------------------------------------------------------- the verdict --- */

  const won = feed.filter((e) => e.hitTarget && !e.hitStopFirst).length;
  const lost = feed.filter((e) => e.hitStopFirst).length;
  const openAtClose = feed.length - won - lost;
  const net = feed.reduce((a, e) => a + (e.closeAfterPct ?? 0), 0);
  const before1030 = feed.filter((e) => minuteOfSession(e.at) < 75).length;

  hr('Was it worth having');
  console.log(`  alerts sent            : ${feed.length}`);
  console.log(
    `  reached target         : ${won}` +
      (feed.length ? ` (${((won / feed.length) * 100).toFixed(0)}%)` : ''),
  );
  console.log(`  stopped out            : ${lost}`);
  console.log(`  still open at 15:30    : ${openAtClose}`);
  console.log(`  net if all held to close: ${net >= 0 ? '+' : ''}${net.toFixed(2)}% summed, IN THE STOCK`);
  console.log(
    `  arrived before 10:30   : ${before1030} of ${feed.length} — the trend-day alert could not ` +
      'have sent ANY of these, since nothing may confirm before minute 75',
  );

  /* ------------------------------------------------------------------ where it works --- */
  //
  // A single headline number cannot tell you whether a feed is worth having — it averages the
  // part that works with the part that does not. These two cuts are the ones that decide the
  // gate: WHEN in the session an alert fired, and how high its entry quality was. If the edge
  // lives in one bucket the fix is a gate; if it is flat everywhere, there is no edge to gate for.
  const bucket = (e: Entry): string => {
    const m = minuteOfSession(e.at);
    if (m < 15) return '09:15–09:30';
    if (m < 45) return '09:30–10:00';
    if (m < 105) return '10:00–11:00';
    if (m < 225) return '11:00–13:00';
    return '13:00–15:30';
  };
  const band = (e: Entry): string =>
    e.entryQuality >= 95 ? 'EQ 95+' : e.entryQuality >= 90 ? 'EQ 90–94' : e.entryQuality >= 85 ? 'EQ 85–89' : 'EQ 80–84';

  const cut = (label: string, of: (e: Entry) => string, order: string[]): void => {
    console.log(`\n  ${pad(label, 14)}${padL('n', 5)}${padL('target', 8)}${padL('stopped', 9)}${padL('open', 6)}${padL('win%', 7)}${padL('net%', 9)}`);
    for (const k of order) {
      const g = feed.filter((e) => of(e) === k);
      if (!g.length) continue;
      const w = g.filter((e) => e.hitTarget && !e.hitStopFirst).length;
      const l = g.filter((e) => e.hitStopFirst).length;
      const n = g.reduce((a, e) => a + (e.closeAfterPct ?? 0), 0);
      console.log(
        `  ${pad(k, 14)}${padL(String(g.length), 5)}${padL(String(w), 8)}${padL(String(l), 9)}` +
          `${padL(String(g.length - w - l), 6)}${padL(`${((w / g.length) * 100).toFixed(0)}%`, 7)}` +
          `${padL(`${n >= 0 ? '+' : ''}${n.toFixed(1)}%`, 9)}`,
      );
    }
  };

  hr('Where the alerts actually worked');
  cut('by time', bucket, ['09:15–09:30', '09:30–10:00', '10:00–11:00', '11:00–13:00', '13:00–15:30']);
  cut('by quality', band, ['EQ 80–84', 'EQ 85–89', 'EQ 90–94', 'EQ 95+']);
  cut('by side', (e) => (e.direction === 1 ? 'CALL' : 'PUT'), ['CALL', 'PUT']);

  if (toDiscord) await sendFeedToDiscord(day, feed, floor, out);

  const uncovered = baseline
    ? out.scanned - out.entries.reduce((set, e) => set.add(e.symbol), new Set<string>()).size
    : 0;
  hr('What this number is not');
  console.log(
    '  NOT a P&L. Every figure above is the underlying stock, held from the alert to the close or\n' +
    '  to a level. You would be buying an option: the leverage cuts both ways and the replay has no\n' +
    '  historical chain to price it with.\n\n' +
    '  NOT slippage-adjusted. The entry price is the 1-minute close at the moment the trigger fired.\n\n' +
    '  NOT liquidity-gated. Historical candles carry no order book, so the liquidity part of entry\n' +
    '  quality is unscored here and a few of these would be refused live.\n\n' +
    '  SAMPLED once a minute against fifteen seconds live, so the pulse windows hold a quarter of\n' +
    '  their normal readings.' +
    (baseline ? `\n\n  Baseline used: ${baseline.day}, ${Object.keys(baseline.symbols).length} symbols. ` +
      `Stocks missing from it can produce no ATR-scaled\n  entry at all and are silently absent from the feed above${uncovered > 0 ? ` (${uncovered} produced nothing)` : ''}.` : ''),
  );
}

function printBoard(day: string, out: Awaited<ReturnType<typeof replayAll>>, cfg: MomentumConfig): void {
  const phaseRank: Record<string, number> = { Confirmed: 3, Forming: 2, Faded: 1, None: 0 };
  const called = out.rows
    .filter((r) => r.peak >= cfg.thresholds.conviction.phase.formingScore && r.finalPhase !== 'None')
    .sort((a, b) => phaseRank[b.finalPhase] - phaseRank[a.finalPhase] || b.peak - a.peak);

  hr(`The board for ${day} — ${called.length} one-sided days out of ${out.scanned} stocks replayed`);

  // MOST OF THE UNIVERSE COMING BACK EMPTY IS AN UPSTREAM STATE, NOT A RESULT, and the two look
  // identical in a summary line. Upstox publishes a finished session into the historical endpoint
  // stock by stock over the hours after the close — measured at 00:05 IST, the previous session
  // was served for SBIN and not yet for PAYTM or RECLTD, while every day before it was complete.
  // Reporting "206 stocks had no candles" without saying that reads as a broken replay.
  if (out.empty > out.scanned) {
    console.log(
      `\n⚠️  ${out.empty} of ${out.empty + out.scanned} stocks returned no candles for ${day}.\n` +
      '    That is Upstox still publishing this session rather than a quiet market — a finished\n' +
      '    day lands in the historical endpoint stock by stock over the hours after the close.\n' +
      '    Replay it again later, or pick an earlier day, which will be complete.',
    );
    if (!called.length) return;
  }

  if (!called.length) {
    console.log('\nNothing held a one-sided shape on this day. On a rotational session that is the real answer.');
    return;
  }

  console.log(
    pad('stock', 13) + padL('day %', 8) + padL('peak', 6) + pad('  phase', 12) +
    pad('dir', 9) + pad('formed', 8) + pad('confirmed', 11) +
    padL('entries', 8) + padL('won', 5) + padL('lost', 6) + padL('net %', 9),
  );
  for (const r of called) {
    console.log(
      pad(r.symbol, 13) +
        padL(`${r.dayPct >= 0 ? '+' : ''}${r.dayPct.toFixed(2)}`, 8) +
        padL(r.peak.toFixed(0), 6) +
        pad('  ' + r.finalPhase, 12) +
        pad(r.direction, 9) +
        pad(r.formedAt ? clock(r.formedAt) : '—', 8) +
        pad(r.confirmedAt ? clock(r.confirmedAt) : '—', 11) +
        padL(String(r.entries), 8) +
        padL(String(r.won), 5) +
        padL(String(r.lost), 6) +
        padL(`${r.netPct >= 0 ? '+' : ''}${r.netPct.toFixed(2)}`, 9),
    );
  }

  const withEntries = called.filter((r) => r.entries > 0);
  const won = withEntries.reduce((a, r) => a + r.won, 0);
  const lost = withEntries.reduce((a, r) => a + r.lost, 0);
  const net = withEntries.reduce((a, r) => a + r.netPct, 0);
  console.log(
    `\n${called.filter((r) => r.finalPhase === 'Confirmed').length} confirmed · ` +
      `${called.filter((r) => r.finalPhase === 'Forming').length} forming · ` +
      `${called.filter((r) => r.finalPhase === 'Faded').length} faded` +
      (out.empty ? ` · ${out.empty} stocks had no candles` : '') +
      (out.failed ? ` · ${out.failed} failed` : ''),
  );
  console.log(
    `entries across those stocks: ${withEntries.reduce((a, r) => a + r.entries, 0)} — ` +
      `${won} reached target, ${lost} stopped, net ${net >= 0 ? '+' : ''}${net.toFixed(2)}% summed IN THE STOCK.`,
  );
  console.log(
    '\nThe ATR baseline used is TODAY\'s, not the one that existed on the replayed day — every\n' +
    'ATR-scaled reading (deepest dip, entry depth) carries that drift, which grows the further back\n' +
    'you go. The shape readings — adherence, crossings, efficiency — do not depend on it.',
  );
}

/* ---------------------------------------------------------------------------- main --- */

async function main() {
  if (!tokenSet()) {
    console.error('UPSTOX_ACCESS_TOKEN is not set — put your Analytics Token in api/.env');
    process.exit(1);
  }

  // BARE WORDS ARE ACCEPTED AS WELL AS FLAGS, because the flags do not survive npm.
  //
  // `npm run replay-trend -- --all --day 2026-08-11` runs `tsx trend-replay.ts 2026-08-11`:
  // npm's own option parser consumes `--all` (one of its config keys) and `--day` before the
  // script is reached, and only the bare date is passed through. The script then read that date
  // as a stock symbol and reported it was not in the F&O universe — a confusing answer to a
  // command that looked right.
  //
  // Rather than only documenting `npx tsx`, both spellings work: a positional YYYY-MM-DD is the
  // day, and a positional `all` is the universe. No stock is named either of those things.
  const args = process.argv.slice(2);
  const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

  const dayIdx = args.indexOf('--day');
  const flagDay = dayIdx >= 0 ? args[dayIdx + 1] : undefined;
  // `dayIdx + 1` is 0 when there is no `--day`, which would silently eat the first symbol.
  const skip = dayIdx >= 0 ? dayIdx + 1 : -1;

  const bare = args.filter((a, i) => !a.startsWith('--') && i !== skip);
  const bareDay = bare.find((a) => ISO_DAY.test(a));
  const day = flagDay ?? bareDay ?? istDay();

  // `--sweep N` pools the N trading days ending at `day`, which is the only way a pattern cut is
  // worth reading: one session yields ~46 confirmations and a four-way slice of 46 is buckets of
  // eight. Weekends are skipped here; a listed holiday simply serves no candles and drops out.
  // `--conv N` replays at a different conviction floor WITHOUT editing api/.env, so a "what if I
  // raised it" question costs a flag rather than a config change that then has to be remembered
  // and undone. `minConviction()` reads process.env on every call, so setting it here — after the
  // env file has already been loaded at import — is what the whole run then sees.
  // Whatever the UI panel has set, first — so a replay is measured at the floor the live channel
  // is actually running at rather than at whatever `.env` said before somebody moved the slider.
  // `--conv` is applied after this and therefore still wins, which is the order that flag needs.
  await ensureAlertOverrides();

  const convIdx = args.indexOf('--conv');
  const convArg = Number(convIdx >= 0 ? args[convIdx + 1] : NaN);
  if (Number.isFinite(convArg) && convArg >= 0 && convArg <= 100)
    process.env.TREND_DAY_ALERT_MIN_CONVICTION = String(convArg);

  const sweepIdx = args.indexOf('--sweep');
  const sweepN = Math.max(0, Math.min(30, Number(sweepIdx >= 0 ? args[sweepIdx + 1] : 0) || 0));
  const sweepDays: string[] = [];
  for (let back = 0; sweepDays.length < sweepN && back < 60; back++) {
    const d = isoDaysBefore(back, day);
    const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
    if (dow !== 0 && dow !== 6) sweepDays.push(d);
  }
  sweepDays.reverse();

  const all = args.includes('--all') || bare.some((a) => a.toLowerCase() === 'all');
  const ignition = args.includes('--ignition') || bare.some((a) => a.toLowerCase() === 'ignition');
  // Push the feed to Discord as well as printing it. Every message it sends is banner-marked as a
  // backtest — see `sendFeedToDiscord`, this posts into the live alert channel.
  const toDiscord = args.includes('--discord') || bare.some((a) => a.toLowerCase() === 'discord');
  // The list the LIVE trend-day alert would have sent, as opposed to the experimental ignition one.
  const confirmed = args.includes('--confirmed') || bare.some((a) => a.toLowerCase() === 'confirmed');

  // The entry-quality floor the feed is gated on. Defaults to the live alert's own, so running
  // this with no argument reports what the phone would actually have received.
  const eqIdx = args.indexOf('--eq');
  const eqArg = Number(eqIdx >= 0 ? args[eqIdx + 1] : NaN);
  const floor = Number.isFinite(eqArg) && eqArg >= 0 && eqArg <= 100 ? eqArg : minEntryQuality();

  const symbols = bare
    .filter((a) => a !== bareDay && !['all', 'ignition', 'confirmed', 'discord'].includes(a.toLowerCase()))
    // Values belonging to --eq / --conv / --sweep arrive as bare words too. No ticker is a
    // number, so dropping numerics is both safe and enough.
    .filter((a) => !Number.isFinite(Number(a)))
    .map((s) => s.toUpperCase());

  if (!symbols.length && !all && !ignition && !confirmed) {
    console.error(
      'usage:\n' +
      '  npx tsx tools/trend-replay.ts BOSCHLTD NHPC [--day 2026-08-05]\n' +
      '  npx tsx tools/trend-replay.ts --all [--day 2026-08-05]      the whole F&O universe, one line each\n' +
      '\n' +
      '  npm run replay-trend -- all 2026-08-05                      same thing through npm, which\n' +
      '  npm run replay-trend -- BOSCHLTD 2026-08-05                 strips leading -- flags\n' +
      '\n' +
      'The day defaults to today (IST). Today is served straight from the intraday endpoint;\n' +
      'a past session only appears once Upstox has published it, which takes hours after the close.',
    );
    process.exit(1);
  }

  const cfg = await configRepository.get();
  const uni = await universe();

  hr('Replay');
  console.log(
    `day ${day}, ${all ? `the whole universe (${uni.members.length} stocks)` : `symbols ${symbols.join(', ')}`}, ` +
      `config version ${cfg.version}`,
  );
  console.log(
    `conviction: forming from minute ${cfg.thresholds.conviction.phase.minMinutesForming} at score ` +
      `${cfg.thresholds.conviction.phase.formingScore}, confirmed from minute ` +
      `${cfg.thresholds.conviction.phase.minMinutesConfirmed} at ${cfg.thresholds.conviction.phase.confirmScore} ` +
      `held ${cfg.thresholds.conviction.phase.confirmHoldMin}m`,
  );
  console.log(
    `budget multiplier: forming ×${cfg.signal.trend.budgetMultiplier.forming}, ` +
      `confirmed ×${cfg.signal.trend.budgetMultiplier.confirmed} on a base of ${cfg.signal.extension.atrUsedMax} ATR`,
  );

  // THE BASELINE HAS TO PREDATE THE DAY BEING REPLAYED, and using the live one does not.
  //
  // `prevClose` on the stored baseline is the last completed session's close. Replay 2026-08-14
  // with a baseline built on the 15th or later and `prevClose` IS the 14th's close — so every
  // `changePct` in the replay is measured against a price that had not happened yet. RECLTD fell
  // 344 → 335 that day and the replay read it at 09:19 as +2.4% and bullish; APOLLOHOSP rose
  // 3.7% and its opening gap was recorded as −1.70 ATR. The signal layer falls back to
  // `changePct` for direction until conviction is ready, which is exactly the first half hour,
  // so the early entries were graded with their direction inverted. That is what produced a 15%
  // hit rate — a number below chance on symmetric stops, which no merely-weak signal reaches.
  //
  // So a past day gets its own isolated build: `nowMs` on the replay day, nothing written, no
  // carry-forward from the live baseline. Today's replay keeps using the live one, which for
  // today IS the point-in-time baseline.
  const replayingToday = day === istDay();
  let baseline: Awaited<ReturnType<typeof getBaseline>>['baseline'];

  if (replayingToday) {
    let b = await getBaseline();
    if (!b.baseline) {
      console.log('\nno baseline — building it, this needs a couple of minutes…');
      await ensureBaseline({
        atrPeriod: cfg.thresholds.atrExpansion.period,
        trendLookback: cfg.thresholds.trendStructure.lookbackSessions,
      });
      b = await getBaseline();
    }
    baseline = b.baseline;
    console.log(
      `baseline: ${baseline ? `${baseline.day}, ${Object.keys(baseline.symbols).length} symbols (live)` : 'NONE — ATR-scaled readings will be unavailable'}`,
    );
  } else {
    // Midday on the replay day, so `istDay(nowMs)` lands on it whatever the host's timezone.
    const asOf = Date.parse(`${day}T06:30:00Z`);
    console.log(`\nbuilding a point-in-time baseline as of ${day} (isolated — the live one is untouched)…`);
    baseline = await buildBaseline(
      {
        atrPeriod: cfg.thresholds.atrExpansion.period,
        trendLookback: cfg.thresholds.trendStructure.lookbackSessions,
        isolated: true,
      },
      asOf,
    );
    const sample = baseline.symbols.RECLTD ?? Object.values(baseline.symbols)[0];
    console.log(
      `baseline: ${day}, ${Object.keys(baseline.symbols).length} symbols (point-in-time)` +
        (sample ? ` — e.g. ${sample.symbol} prevClose ${sample.prevClose}, which must be the session BEFORE ${day}` : ''),
    );
  }

  // `--ignition` answers a different question from `--all`: not "which stocks trended" but
  // "what would the phone actually have said, and was it worth having". It applies the LIVE
  // alert's own gate — see the note on `ignitionFeed` — so the list below is the message log,
  // not an optimistic reading of the same data.
  // Both feeds come off ONE replay. Invoking the tool twice would build two point-in-time
  // baselines and spend the candle budget twice — and, worse, the two lists could then differ
  // for reasons having nothing to do with the alerts being compared.
  // A sweep replays each session against ITS OWN point-in-time baseline and pools only the
  // confirmations. Nothing is sent to Discord: the output is a pattern table, and a wall of
  // several hundred expired rows on a phone is not one.
  if (sweepN > 1) {
    const pooled: Confirmation[] = [];
    const covered: string[] = [];
    for (const d of sweepDays) {
      try {
        const asOf = Date.parse(`${d}T06:30:00Z`);
        const b = await buildBaseline(
          {
            atrPeriod: cfg.thresholds.atrExpansion.period,
            trendLookback: cfg.thresholds.trendStructure.lookbackSessions,
            isolated: true,
          },
          asOf,
        );
        const out = await replayAll(d, uni.members, b, cfg, true);
        if (!out.scanned) {
          console.log(`  ${d}: no candles (holiday?) — skipped`);
          continue;
        }
        pooled.push(...out.confirmations);
        covered.push(d);
        console.log(`  ${d}: ${out.confirmations.length} confirmations from ${out.scanned}/${uni.members.length} stocks`);
      } catch (e) {
        console.log(`  ${d}: FAILED — ${String((e as Error).message).slice(0, 120)}`);
      }
    }
    if (!pooled.length) {
      console.log('\nno confirmations pooled — nothing to analyse.');
      return;
    }
    const w = pooled.filter((c) => gainOf(c) > 0).length;
    const net = pooled.reduce((a, c) => a + gainOf(c), 0);
    hr(`Pooled: ${pooled.length} confirmations across ${covered.length} sessions`);
    console.log(
      `  went the right way: ${w} (${((w / pooled.length) * 100).toFixed(0)}%)  ·  ` +
        `average ${net / pooled.length >= 0 ? '+' : ''}${(net / pooled.length).toFixed(3)}%  ·  ` +
        `net ${net >= 0 ? '+' : ''}${net.toFixed(1)}%`,
    );
    printConfirmedPatterns(pooled, covered);
    return;
  }

  if (ignition || confirmed) {
    const wanted = [ignition && 'ignition', confirmed && 'confirmation'].filter(Boolean).join(' + ');
    console.log(`\nreplaying ${uni.members.length} stocks for the ${wanted} feed — one candle request each…`);
    const out = await replayAll(day, uni.members, baseline, cfg, true);
    // Ignition first, confirmations second, each ending with its own stats message — so the
    // channel reads as two labelled blocks rather than one interleaved stream.
    if (ignition) await printIgnitionFeed(day, out, floor, baseline, toDiscord);
    if (confirmed) await reportConfirmed(day, out, toDiscord);
    return;
  }

  if (all) {
    console.log(`\nreplaying ${uni.members.length} stocks — one candle request each, eight at a time…`);
    printBoard(day, await replayAll(day, uni.members, baseline, cfg), cfg);
    return;
  }

  for (const symbol of symbols) {
    const member = uni.members.find((m) => m.symbol === symbol);
    if (!member) {
      console.log(`\n${symbol}: not in the F&O universe this scanner covers`);
      continue;
    }

    const sym = baseline?.symbols[symbol];
    if (!sym?.atr) console.log(`\n! ${symbol} has no ATR baseline — every ATR-scaled reading below will be blank`);

    // Today is only on the intraday endpoint and past days only on the historical one; asking
    // the wrong one answers 200 with an empty array, which reads as "nothing traded".
    const candles =
      day === istDay()
        ? await todaySession(member.equityKey, day, 1)
        : await historical(member.equityKey, 'minutes', 1, day, day);

    const forDay = candles.filter((c) => c.day === day);
    if (!forDay.length) {
      console.log(`\n${symbol}: Upstox served no 1-minute candles for ${day} (holiday, or the date is out of range)`);
      continue;
    }

    printSymbol(symbol, replaySymbol(symbol, forDay, sym, cfg), cfg);
  }

  hr('Reading this');
  console.log(
    'The `entries` table is the answer to "would the scanner have told me". Each row is a moment the\n' +
    'board would have shown Buy Call / Buy Put, and `best` / `worst` / `close` are what the STOCK did\n' +
    'afterwards — not the option, which needs a chain this replay does not have.\n\n' +
    'The extension line above it is the fix itself, measured: the share of the session the old fixed\n' +
    'ceiling would have called spent, against the conviction-scaled one. On a genuine trend day the\n' +
    'first number is large and the second is near zero, and the difference is every entry that used to\n' +
    'be refused.',
  );
}

main().catch((e) => {
  console.error('\nFAILED:', e);
  process.exit(1);
});

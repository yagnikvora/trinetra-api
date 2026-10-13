// The cron jobs. Three of them, and the intervals are a rate-limit budget, not a taste.
//
//   SCAN        every `refresh.quoteMs` (default 15s), while the market is open.
//               Three quote requests plus up to `shortlistSize` chain requests, which the
//               enrichment cache collapses to roughly one chain pass per `refresh.enrichMs`.
//               The interval is 15s rather than 30s because the timing layer's resolution
//               IS the poll interval: a trigger cannot be reported sooner than the reading
//               that would have detected it. The chain tier is unaffected — its own TTL
//               still collapses enrichment to once a minute.
//
//   BASELINE    once a day at `refresh.baselineHourIst` (default 08:00 IST), before the
//               open. ~416 requests. Also runs on boot if the stored baseline is not
//               today's, because a scanner with no volume profile has no RVOL, which is the
//               heaviest factor in the model.
//
//   SEED        once per process per day, after the baseline. ~208 requests, and only for
//               symbols this process did not watch from the open — so a scanner that has been
//               up since 09:10 spends nothing, and one started at 13:00 (or at 21:00) rebuilds
//               the part of the session it missed from the exchange's own candles rather than
//               reporting the whole board as "warming up". See data/session-seed.ts.
//
//   FLUSH       the session state, on a slow tick, so a crash costs seconds of VWAP slope
//               rather than the morning's opening ranges.
//
// Scanning stops when the market closes. The numbers are frozen for the day, so continuing
// to poll would spend the request budget re-fetching a board that cannot change — and the
// first scan after the open needs that budget intact. One scan IS run after the close, so
// the final board of the day is the settled one and the IV history record is the close.

import { configRepository } from './config/config.repository.js';
import { runScan } from './engine/momentum.engine.js';
import { snapshotRepository } from './data/snapshot.repository.js';
import { ensureBaseline, getBaseline } from './data/baseline.js';
import { flushSessionState } from './data/session-state.js';
import { seedSession, seedStatus, type SeedOutcome } from './data/session-seed.js';
import { resetUniverse } from './data/universe.js';
import { istDay, istMinutes, marketOpen, SESSION_CLOSE_MIN } from './session.js';
import {
  backfillExcursions, journalBoot, journalSettleDue, journalTick,
} from './journal/journal.js';
import { flushCandidateLog } from './alerts/displacement.js';
import { newsSweepDue, sweepNews } from './data/news-sentiment.js';
import { archiveNearMisses } from './journal/near-miss.js';
import { sessionBellTick } from '../alerts/session-bell.js';
import { checkTelegram } from '../alerts/telegram.js';
import { checkDiscord } from '../alerts/discord.js';
import { tokenSet } from '../upstox.js';
import { feedStatus, startFeed, stopFeed, type FeedStatus } from '../feed/client.js';

/** How long after the close the final settling scan runs. */
const POST_CLOSE_MINUTES = 5;
const FLUSH_MS = 60_000;

/**
 * How often the session bells are checked.
 *
 * Its own timer rather than a line inside `scanTick`, because that returns early without an Upstox
 * token and a good morning does not need one — an API whose token expired should still say good
 * morning, and would otherwise go quiet on exactly the day you most want to notice. Thirty seconds
 * puts the message within half a minute of the bell.
 *
 * This job — and the channel probe below it — moved here from the pullback scheduler when that
 * module was removed. Neither has anything to do with momentum; this is simply the scheduler that
 * still exists.
 */
const BELL_MS = 30_000;

let timers: NodeJS.Timeout[] = [];
let scanning = false;
let lastBaselineDay = '';
/**
 * When the next baseline attempt may run, and how many have failed today.
 *
 * The old code cleared `lastBaselineDay` on failure and let the 5-minute tick try again, which
 * is ~416 requests every 5 minutes — about 3,700 per 30 minutes against a 2,000 ceiling. Once
 * the first attempt failed the retries alone guaranteed the quota stayed spent, so it could
 * never recover. Backing off geometrically means a failure costs one more attempt soon and then
 * progressively fewer, which is what leaves budget for the attempt that can actually succeed.
 */
let baselineRetryAt = 0;
let baselineAttempts = 0;
/** Upstox's own window. No point retrying a spent candle quota sooner than this. */
const BASELINE_BACKOFF_MS = [5 * 60_000, 15 * 60_000, 30 * 60_000, 60 * 60_000];
let lastSeedDay = '';
let lastPostCloseDay = '';
let lastError: { at: number; message: string } | null = null;
let lastScanAt = 0;

export interface SchedulerStatus {
  running: boolean;
  lastScanAt: number;
  lastError: { at: number; message: string } | null;
  baselineDay: string | null;
  baselineSymbols: number;
  /**
   * Of `baselineSymbols`, how many are readings carried over from an earlier day because today's
   * build could not reach them. Non-zero is normal; climbing day after day means the morning
   * build keeps losing its request budget and the ATRs behind the alerts are drifting stale.
   */
  baselineCarried: number;
  tokenConfigured: boolean;
  seed: SeedOutcome;
  /**
   * The live feed.
   *
   * Worth reporting even though a dead feed is not an outage: the scan silently falls back to
   * REST, so the only symptom of a feed that never connects is that the alerts are as late as
   * they used to be — which is invisible unless something says so here.
   */
  feed: FeedStatus;
}

/**
 * Run one scan and store it.
 *
 * Never throws: a scheduled job that rejects takes the timer down with it on some runtimes,
 * and a transient Upstox blip must not permanently stop the scanner. The error is recorded
 * so `/momentum/status` can report it, and the last good board stays served.
 */
export async function scanOnce(nowMs = Date.now()): Promise<void> {
  if (scanning) return; // a slow cycle must not overlap the next one and double the calls
  scanning = true;
  try {
    const cfg = await configRepository.get();
    const board = await runScan(cfg, nowMs);
    await snapshotRepository.save(board);
    lastScanAt = nowMs;
    lastError = null;
  } catch (e) {
    lastError = { at: nowMs, message: String((e as Error).message) };
  } finally {
    scanning = false;
  }
}

async function baselineTick(nowMs = Date.now()): Promise<void> {
  const cfg = await configRepository.get();
  const today = istDay(nowMs);
  if (lastBaselineDay === today) return;

  const stored = await getBaseline(nowMs);
  const dueByClock = istMinutes(nowMs) >= cfg.refresh.baselineHourIst * 60;
  const missing = !stored.baseline || stored.stale;
  if (!missing || !dueByClock) {
    // Already current for today: record it so the check is cheap for the rest of the day.
    if (!missing) lastBaselineDay = today;
    return;
  }

  // A failed attempt sets a floor on the next one. Without it the 5-minute tick spends more
  // request budget than the endpoint refills, and the build can never succeed again that day.
  if (nowMs < baselineRetryAt) return;

  lastBaselineDay = today; // set first, so a long build is not started twice
  try {
    // The expiry roll and any newly-listed F&O name land with the new day's master.
    resetUniverse();
    await ensureBaseline(
      { atrPeriod: cfg.thresholds.atrExpansion.period, trendLookback: cfg.thresholds.trendStructure.lookbackSessions },
      nowMs,
    );
    baselineAttempts = 0;
    baselineRetryAt = 0;
  } catch (e) {
    lastBaselineDay = ''; // failed — let a later tick retry, once the back-off has elapsed
    const wait = BASELINE_BACKOFF_MS[Math.min(baselineAttempts, BASELINE_BACKOFF_MS.length - 1)];
    baselineAttempts++;
    baselineRetryAt = nowMs + wait;
    lastError = {
      at: nowMs,
      message:
        `baseline build failed (attempt ${baselineAttempts}, next in ${Math.round(wait / 60_000)}m): ` +
        String((e as Error).message),
    };
  }
}

/**
 * Rebuild whatever of today's session this process did not watch.
 *
 * Runs after the baseline rather than beside it, and that ordering is load-bearing: the seed
 * scales its VWAP-side buffer and its pullback depth by ATR, and an ATR-less replay would
 * record crossings against a flat percentage band — giving a seeded board that disagrees with
 * a watched one on the single cleanest one-sidedness reading in the model.
 *
 * Once per process per day. There is no value in a second pass: symbols watched from the open
 * are skipped, and the ones that were seeded are being accumulated live from that point on.
 */
async function seedTick(nowMs = Date.now()): Promise<void> {
  if (process.env.MOMENTUM_SEED === 'off') return;
  if (!tokenSet()) return;

  const today = istDay(nowMs);
  if (lastSeedDay === today) return;
  if (istMinutes(nowMs) <= 0) return;

  lastSeedDay = today; // set first, so a slow seed is not started twice
  const out = await seedSession({}, nowMs);
  const failed = Object.keys(out.failures).length;
  if (out.seeded || failed)
    console.log(
      `[momentum] session seed: rebuilt ${out.seeded}, kept ${out.skipped} watched live, ` +
        `${out.empty} with no candles, ${failed} failed`,
    );
  // A seed that reached nothing is not today's seed. Clearing the stamp lets the next tick
  // retry, which is what recovers from booting into a spent candle quota.
  if (!out.seeded && failed) lastSeedDay = '';
}

async function scanTick(nowMs = Date.now()): Promise<void> {
  if (!tokenSet()) return;

  if (marketOpen(nowMs)) {
    await scanOnce(nowMs);
    return;
  }

  // One settling scan a few minutes after the close, so the day's final board — and the IV
  // history row built from it — reflects the closing print rather than 15:29.
  const today = istDay(nowMs);
  const minutes = istMinutes(nowMs);
  if (
    lastPostCloseDay !== today &&
    minutes >= SESSION_CLOSE_MIN + POST_CLOSE_MINUTES &&
    minutes < SESSION_CLOSE_MIN + 60
  ) {
    lastPostCloseDay = today;
    await scanOnce(nowMs);
  }
}

/** Probe both phone channels, never throwing — a dead channel must not stop the scanner. */
async function probeChannels(): Promise<void> {
  await Promise.allSettled([checkTelegram(), checkDiscord()]);
}

/** Start the jobs. Idempotent — calling twice does not double the timers. */
export async function startScheduler(): Promise<void> {
  if (timers.length) return;
  const cfg = await configRepository.get();

  // Opened before the first scan and left open all day. Connecting is not gated on market
  // hours: the feed sends a snapshot on connect, so an evening restart still comes up with a
  // priced board, and a process that is already connected at 09:15 has the open rather than
  // spending its first cycle establishing a socket. Nothing is subscribed until a caller asks
  // — `quoteSnapshot` does that on every cycle, which is also how an expiry roll lands.
  if (tokenSet()) startFeed();

  // `unref` so these never hold the process open on their own: a CLI that imports this
  // module should still exit when its work is done.
  const every = (ms: number, fn: () => void) => {
    const t = setInterval(fn, ms);
    t.unref?.();
    timers.push(t);
  };

  // The seed chases the baseline rather than running on its own timer, because it needs that
  // baseline's ATRs to measure a replayed session the same way a watched one is measured. Both
  // are no-ops once they have run for the day, so the five-minute cadence is only a retry.
  const baselineThenSeed = (nowMs?: number) =>
    baselineTick(nowMs)
      .catch((e) => { lastError = { at: Date.now(), message: `baseline tick: ${String((e as Error).message)}` }; })
      .then(() => seedTick(nowMs))
      .catch((e) => { lastError = { at: Date.now(), message: `session seed: ${String((e as Error).message)}` }; });

  every(cfg.refresh.quoteMs, () => void scanTick());
  every(5 * 60_000, () => void baselineThenSeed());
  every(BELL_MS, () => void sessionBellTick());

  // THE TRADE JOURNAL. Two jobs and they are deliberately not one.
  //
  // The mark runs on the scan interval and costs nothing — the option's own instrument key is on
  // the WebSocket feed, so a position is watched for free. It exists so the page has a live
  // number, not so it can decide the day.
  //
  // The settle runs every two minutes and is what actually writes the record: it fetches each
  // contract's 1-minute candles and grades the path. Its cadence is slow because it is a REST
  // call per open contract per day, and it is a CATCH-UP job as well as a closing one — a
  // process that was asleep all afternoon settles the day correctly on its next tick, and one
  // that was off for a week settles every day it missed. That is the whole reason the exit is
  // derived from candles rather than from the marks it collected.
  every(cfg.refresh.quoteMs, () => void journalTick().catch((e) => {
    lastError = { at: Date.now(), message: `journal mark: ${String((e as Error).message)}` };
  }));
  every(2 * 60_000, () => void journalSettleDue().catch((e) => {
    lastError = { at: Date.now(), message: `journal settle: ${String((e as Error).message)}` };
  }));
  // Repair the excursions of anything that was not watched from entry — a feed that was down
  // this morning, a process started at lunch. On the settle's timer because it is the same kind
  // of job and spends the same kind of request, and it costs nothing on a normal day: a row
  // drops out of the selection the moment it is filled, so there is usually nothing to fetch.
  every(2 * 60_000, () => void backfillExcursions(istDay(Date.now())).catch((e) => {
    lastError = { at: Date.now(), message: `journal backfill: ${String((e as Error).message)}` };
  }));
  // The candidate log, written once the displacement window has closed. On the same slow timer as
  // the settle because it is the same kind of job — idempotent, catches up after a restart, and of
  // no consequence if a tick is missed.
  every(2 * 60_000, () => void flushCandidateLog().catch(() => {}));

  // Read the overnight news on every stock before the open, and again each half hour until the
  // trend-day window has passed. In the background and never awaited: the free model tier can take
  // over a minute to answer, which is why the alerts look the result up instead of asking for it.
  const newsTick = () => void newsSweepDue().then((due) => (due ? sweepNews() : 0)).catch(() => {});
  every(5 * 60_000, newsTick);
  newsTick();

  // Once an hour after the window: price the qualifiers the cap turned away, while their contracts
  // still exist. This is the only job here with a genuine deadline — an option series expires in
  // about four weeks and its candles become unfetchable the moment it does, so a near miss not
  // archived inside that window can never be priced. Idempotent, so an hourly retry costs nothing.
  every(60 * 60_000, () => void archiveNearMisses(istDay(Date.now())).catch(() => {}));
  // Once on boot: push any local history the shared store has never seen — which is what
  // backfills the day a database is first configured — then close off anything left open.
  void journalBoot().then(() => journalSettleDue()).catch(() => {});

  // Ask each phone channel whether it actually works, now rather than at 10:30. A configured
  // channel that cannot be reached is indistinguishable from a quiet market on `/momentum/status`
  // — same `failures: 0`, same `lastSentAt: null` — and the first send is otherwise attempted at
  // the precise moment a trend day confirms. Re-probed hourly so a channel that dies mid-session
  // (a deleted webhook, a network that starts filtering) is reported rather than merely silent.
  void probeChannels();
  every(60 * 60_000, () => void probeChannels());
  // Forced on this tick: the scan's own flush is throttled to keep a 2MB write off every
  // 15-second cycle, and this is the one that guarantees the morning reaches disk anyway.
  every(FLUSH_MS, () => void flushSessionState(true));

  // Rung once on the way in as well as on the timer, so a process that restarts inside the ten
  // minutes after a bell still delivers it. The persisted "sent today" record is what stops that
  // from becoming a second copy.
  void sessionBellTick();

  // Kick both immediately rather than waiting a full interval for the first board — but the scan
  // CHASES the baseline rather than racing it.
  //
  // These two used to be fired side by side, unawaited. On a boot with no stored baseline that
  // put a full scan — conviction, phase machine, trend-day alert and all — several minutes ahead
  // of the ATRs it needs, which is the window the 2026-08-13 blank alerts came out of. The
  // interval timer still fires during a long build and those boards are still served (a board
  // with no RVOL is worth more than no board), but the FIRST one now waits, and the alert has its
  // own baseline gate for the rest.
  void baselineThenSeed().finally(() => void scanTick());
}

/**
 * Record a baseline failure raised outside the scheduler's own tick.
 *
 * The manual rebuild route runs `ensureBaseline` directly, so its failures never reached the
 * `lastError` that `/momentum/status` reports. Exported so that route can report through the
 * same field rather than growing a second one nobody thinks to read.
 */
export function noteBaselineFailure(message: string, nowMs = Date.now()): void {
  lastError = { at: nowMs, message };
}

export function stopScheduler(): void {
  for (const t of timers) clearInterval(t);
  timers = [];
  // Without this a test that mounts the module and tears it down leaves a socket reconnecting
  // in the background, and the process never exits.
  stopFeed();
}

export async function schedulerStatus(): Promise<SchedulerStatus> {
  const b = await getBaseline();
  return {
    running: timers.length > 0,
    lastScanAt,
    lastError,
    baselineDay: b.baseline?.day ?? null,
    baselineSymbols: Object.keys(b.baseline?.symbols ?? {}).length,
    baselineCarried: b.baseline?.carried ?? 0,
    tokenConfigured: tokenSet(),
    // Surfaced because "no trend days today" and "this process never rebuilt the session"
    // produce an identical empty board and want opposite responses.
    seed: seedStatus(),
    feed: feedStatus(),
  };
}

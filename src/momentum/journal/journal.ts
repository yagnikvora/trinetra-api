// The trade journal — every alert this app sends, recorded as a position and settled at the
// close, so the day can be read at night instead of watched.
//
// WHY IT IS NOT A LOG FILE. An alert says "buy this contract"; a journal has to say what that
// instruction was actually worth. That needs three things a log cannot give you: the contract's
// price at the moment of the alert, its price path afterwards, and the exit rule applied to that
// path the same way the backtest applied it. All three are here.
//
// WHERE IT IS STORED is `./repository.ts`, and the short version is: local disk always, plus
// Postgres when `DATABASE_URL` is set, because the machine that records the day and the machine
// that reads it are not the same machine.
//
// HOW A TRADE GETS ITS PRICES, and why in this order:
//
//   ENTRY is the ASK at signal time, taken from the `StrikeChoice` the alert had already
//   resolved. Not the mid and not the last trade — the ask is what a buyer pays, and a journal
//   that marks entries at the mid reports an edge that half the spread already ate.
//
//   THE RUNNING MARK comes from the WebSocket feed. The option's own instrument key is
//   subscribed on the first tick after the alert, so watching a position through the day costs
//   no REST quota at all. This is the number the page shows while the market is open.
//
//   THE SETTLED EXIT comes from the contract's own 1-minute candles, fetched once after the
//   close. This is the authoritative record and it deliberately overwrites whatever the live
//   marks concluded, for two reasons. First, it is correct even if this process was asleep for
//   the afternoon — an uptime gap costs the day nothing. Second, a 15-second tick stream only
//   sees the prices it happens to sample, so it misses the low that would have stopped you out
//   and reports a better day than you had; the candle path sees the whole excursion.
//
//   WITHIN ONE CANDLE THE STOP WINS. A minute bar cannot say whether its high or its low came
//   first, and resolving that in the trade's favour is how a backtest invents an edge. Same
//   convention as `research/lab.mjs`, so the journal and the study can be compared.
//
// WHAT IT DOES NOT DO. It never places an order and never claims your fill was its fill. The
// entry and exit it records are the tradeable prices that existed; yours will differ, and
// `PATCH /momentum/journal/:id` exists so you can replace either with what you actually got.
// An edited trade is flagged and the page shows it as yours rather than the system's.
//
// THE ONE EXIT THAT IS NOT A RULE is `POST /momentum/journal/:id/exit`, which closes a single
// open position at the live bid because you have just sold it. It still places no order — it
// records the exit you took, at the price the feed was showing when you took it — and like an
// edit it takes the row out of settlement's hands, or the nightly pass would grade your 11:00
// exit as a 15:15 square-off.

import {
  istDay, istMinutes, sessionAt, SESSION_CLOSE_MIN, SESSION_MINUTES, SESSION_OPEN_MIN,
} from '../session.js';
import { feedTick, subscribeKeys, takeSellRange } from '../../feed/client.js';
import { sessionCandles, type UpstoxCandle } from '../../upstox.js';
import {
  FileJournalRepository, MirrorJournalRepository,
  type JournalRepository, type JournalSyncStatus,
} from './repository.js';
import {
  databaseUrl, getPool, PostgresJournalRepository, savePaths, type OptionPathRow,
} from './postgres.js';
import { store, STORE_KEYS } from '../store.js';
import { bookReadings, chainOiReadings, oiReadings, vixReadings } from '../data/flow-tape.js';
import { recentChain } from '../data/option-chain.js';
import type {
  JournalChannel, JournalContract, JournalEntryInput, JournalShadow, JournalTrade,
} from './types.js';

export type {
  JournalChannel, JournalContract, JournalEntryInput, JournalFill, JournalShadow, JournalTrade,
} from './types.js';
export type { JournalSyncStatus } from './repository.js';

/* ---------------------------------------------------------------------------- config --- */

const num = (name: string, fallback: number, lo: number, hi: number): number => {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= lo && raw <= hi ? raw : fallback;
};

/**
 * The exit the journal applies, and the alternatives it scores alongside it.
 *
 * The defaults are the pair the 36-session study settled on: a -50% stop with the position run
 * to +80% or to the square-off. They are deliberately NOT a 15%/30% pair — that combination was
 * measured at -2.9% of premium a trade, because 2.5% each way plus a day of decay is already
 * 8.5% of premium and a 15-point stop has only about 6.5 points of room left in it. The
 * `shadow` rules below re-score every trade under the tighter pairs anyway, so the page can
 * show what the alternative would have cost on the same prices rather than arguing about it.
 */
export const journalConfig = () => ({
  enabled: (process.env.JOURNAL ?? 'on').trim().toLowerCase() !== 'off',
  /** Take-profit and stop, as a percentage of what the contract cost. */
  tpPct: num('JOURNAL_TP_PCT', 80, 1, 1000) / 100,
  slPct: num('JOURNAL_SL_PCT', 50, 1, 99) / 100,
  /**
   * THE CHECKPOINT. Once the position has been up `armAtPct`, the stop moves once to `lockPct`
   * and never moves again. 0, the default, switches it off and grades at the two fixed levels.
   *
   * WHY IT IS OFF (2026-09-19). It was switched on 2026-08-30 on 78 trades, where +24% → +6% led
   * the flat pair by ₹20,816. That lead did not survive a larger sample. Re-graded on all 194
   * trades from 1 Jul to 18 Sep, each on its own archived minute path, flat +80/−50 nets
   * ₹1,70,226 and +24% → +6% nets ₹1,52,977. It converts 14 red trades into small wins, but it
   * stops out more winners on their ordinary pullbacks than that is worth. Every arming level from
   * +5% to +30% loses to flat on the same data, and so does every lock gated to the afternoon once
   * the raised stop may only be placed while the price is above it.
   *
   * The mechanism is still here because `ExitLab` and the shadow rules grade against it. Switch it
   * back on only on a sample larger than the one that switched it off.
   */
  armAtPct: num('JOURNAL_ARM_AT_PCT', 0, 0, 1000) / 100,
  lockPct: num('JOURNAL_LOCK_PCT', 6, -99, 1000) / 100,
  /** Minute of session to square off anything still open. 360 = 15:15. */
  squareOffMin: num('JOURNAL_SQUARE_OFF_MIN', 360, 1, SESSION_CLOSE_MIN - SESSION_OPEN_MIN),
  /**
   * Round-trip charges per lot, in rupees: brokerage both ways plus STT, exchange transaction
   * charges, SEBI turnover fee, GST and stamp duty. One configurable number rather than a
   * modelled breakdown, because the breakdown differs by broker and the total is what lands in
   * the account. Set it to your own from a contract note.
   */
  chargePerLot: num('JOURNAL_CHARGE_PER_LOT', 120, 0, 100_000),
  /** Lots per position. One, until there is a reason for more. */
  lots: num('JOURNAL_LOTS', 1, 1, 1000),
  /** How far back the boot-time reconcile pushes local history the database has never seen. */
  backfillDays: num('JOURNAL_BACKFILL_DAYS', 120, 1, 3650),
});

/**
 * An exit rule the journal can grade a path under — the shipped one, or an alternative.
 *
 * `armAt`/`trail` are what make a rule PATH-DEPENDENT rather than two fixed price levels. They
 * exist because two fixed levels cannot express the thing the record actually shows going wrong:
 * a position that was up 25% at 11:00 and was handed to the square-off at a loss.
 */
export interface ExitRule {
  name: string;
  tp: number;
  sl: number;
  /** Once the position has been up this much, the stop moves. Omitted = it never moves. */
  armAt?: number;
  /** Where it moves to: 'breakeven', or this many points below the running peak. */
  trail?: number | 'breakeven';
  /**
   * Park the stop at this FIXED level once armed, and never move it again. Set instead of `trail`.
   * A checkpoint does not follow the peak, so a position that runs to +60% and pulls back to +20%
   * is left alone — which is why it beats both the trails and the multi-rung ladders on this book.
   */
  lock?: number;
}

/**
 * The alternatives every settled trade is re-scored under, on its own candles.
 *
 * WHY THE TRAILING ONES WERE ADDED (2026-08-27). Over the first 65 trades the record decomposes
 * into 5 trades that reached +80% and paid ₹78,723 — more than the whole book's profit — 54
 * square-offs worth ₹26,305, and 6 stops costing ₹47,449. Two conclusions follow and they pull in
 * opposite directions: the rare full winners ARE the edge, so no rule that caps the upside can be
 * adopted (+30/-50 and +60/-30 both score worse here on real paths); but 17 trades were up 15% or
 * more and still closed red, which is ₹67,340 of profit handed back to the clock.
 *
 * A trail is the only shape that can protect the second without capping the first. Whether it
 * actually does cannot be answered from the trades already recorded — reconstructing a trail from
 * a stored peak is look-ahead, because the real thing trails the RUNNING peak and would exit at
 * the first retrace from an intermediate high. So these are graded live, on real paths, and the
 * shipped exit stays where it is until they have enough trades to be worth reading.
 *
 * Arming levels are deliberately high. Of the 6 stops, 4 never got above +11%, so a low arm mostly
 * converts trades that were going to lose anyway while clipping the winners that carry the book.
 */
export const SHADOW: ExitRule[] = [
  { name: '+30/-15', tp: 0.30, sl: 0.15 },
  { name: '+30/-50', tp: 0.30, sl: 0.50 },
  { name: '+60/-30', tp: 0.60, sl: 0.30 },
  { name: 'BE@+20', tp: 0.80, sl: 0.50, armAt: 0.20, trail: 'breakeven' },
  { name: 'trail25@+40', tp: 0.80, sl: 0.50, armAt: 0.40, trail: 0.25 },
  { name: 'trail30@+50', tp: 0.80, sl: 0.50, armAt: 0.50, trail: 0.30 },
];

/* ------------------------------------------------------------------------- the store --- */

let repository: JournalRepository | null = null;

/**
 * Local disk, plus Postgres when a database is configured.
 *
 * Built lazily rather than at import: `DATABASE_URL` is loaded by `src/env.js`, and a module
 * evaluated before it would decide there was no database and cache that decision for the life of
 * the process.
 */
export function journalRepository(): JournalRepository {
  if (repository) return repository;
  const url = databaseUrl();
  const local = new FileJournalRepository();
  repository = url ? new MirrorJournalRepository(local, new PostgresJournalRepository()) : local;
  return repository;
}

/** Test seam, and how `check-neon` points a probe at its own connection. */
export function setJournalRepository(r: JournalRepository | null): void {
  repository = r;
}

/* ------------------------------------------------------------------------- the money --- */

/**
 * Fill in the rupee columns from whatever prices the trade currently has.
 *
 * Kept in one place and called from every mutation, so an edited fill and an auto one cannot end
 * up with the money computed two different ways.
 */
function price(t: JournalTrade): void {
  const cfg = journalConfig();
  const size = t.contract ? t.contract.lotSize * t.lots : 0;
  t.amountUsed = size > 0 ? +(t.entry.premium * size).toFixed(2) : null;
  t.updatedAt = Date.now();
  // An untracked exit means nobody could put a price on the contract. Grading that as a loss —
  // or charging brokerage on it — would be inventing both the fill and the fee.
  if (!t.exit || t.exit.reason === 'untracked' || !(size > 0)) {
    t.grossPnl = null; t.charges = null; t.netPnl = null; t.netPct = null;
    return;
  }
  t.grossPnl = +((t.exit.premium - t.entry.premium) * size).toFixed(2);
  t.charges = +(cfg.chargePerLot * t.lots).toFixed(2);
  t.netPnl = +(t.grossPnl - t.charges).toFixed(2);
  t.netPct = t.amountUsed ? +(t.netPnl / t.amountUsed).toFixed(4) : null;
}

/* ------------------------------------------------------------------------- recording --- */

/**
 * What was behind the move at the moment of the alert: futures OI over the move, the chain's OI
 * around the money, the stock's order book and India VIX. Stored on every trade so that, once there
 * are enough of them, "did the dead trades have OI falling, or sellers stacked, under them?" can be
 * answered. The chart could not answer it — see `flow-tape.ts` for the study that showed that.
 *
 * Swallows its own failures. These are research readings, and a missing one must never cost a
 * journal row.
 */
function flowReadings(r: JournalEntryInput, nowMs: number): Record<string, number | null> {
  try {
    return {
      ...oiReadings(r.symbol, nowMs),
      ...chainOiReadings(recentChain(r.symbol, nowMs), r.strike?.strike ?? null, r.strike?.type ?? null),
      ...bookReadings(r.symbol, nowMs),
      ...vixReadings(nowMs),
    };
  } catch {
    return {};
  }
}

/**
 * Journal a batch of alerts. Called by each channel immediately after it has resolved contracts
 * and delivered the message.
 *
 * Never throws. A journal that can break an alert is worse than no journal — the alert is the
 * thing that spends money and it must reach the phone whatever happens here.
 */
export async function recordEntries(
  channel: JournalChannel,
  rows: JournalEntryInput[],
  nowMs = Date.now(),
): Promise<void> {
  const cfg = journalConfig();
  if (!cfg.enabled || !rows.length) return;
  try {
    const repo = journalRepository();
    const day = istDay(nowMs);
    const seen = await repo.existing(day);
    const minute = Math.max(0, istMinutes(nowMs) - SESSION_OPEN_MIN);
    const fresh: JournalTrade[] = [];

    for (const r of rows) {
      const id = `${day}:${channel}:${r.symbol}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const lotSize = r.strike?.lotSize ?? r.lotSize ?? null;
      const contract: JournalContract | null = r.strike && lotSize
        ? {
          label: r.strike.label,
          strike: r.strike.strike,
          type: r.strike.type,
          instrumentKey: r.strike.instrumentKey,
          expiry: r.strike.expiry,
          lotSize,
        }
        : null;
      // The ask, not the mid — see the note at the top of this file. `entryCost` is already
      // the ask; `premium` is the last trade and is the fallback when the book was one-sided.
      const paid = r.strike ? (r.strike.entryCost > 0 ? r.strike.entryCost : r.strike.premium) : 0;
      const t: JournalTrade = {
        id, day, channel, symbol: r.symbol, direction: r.direction,
        contract, lots: cfg.lots,
        entry: { at: nowMs, minute: r.minute ?? minute, premium: +paid.toFixed(2), spot: r.spot, source: 'auto' },
        exit: null, mark: null, mfePct: null, maePct: null, markedFrom: null,
        spreadPctAtEntry: r.strike?.spreadPct ?? null,
        amountUsed: null, grossPnl: null, charges: null, netPnl: null, netPct: null,
        shadow: [],
        readings: { ...flowReadings(r, nowMs), ...(r.readings ?? {}) },
        note: r.note ?? '',
        // A contract that could not be priced is recorded anyway — the signal happened, and a
        // journal that hides its unpriceable days overstates how tradeable the feed is.
        status: contract && paid > 0 ? 'open' : 'closed',
        settled: false,
        edited: false,
        updatedAt: nowMs,
      };
      if (t.status === 'closed') {
        t.exit = { at: nowMs, minute: t.entry.minute, premium: 0, spot: r.spot, source: 'auto', reason: 'untracked' };
        t.settled = true;
      }
      price(t);
      fresh.push(t);
    }
    if (!fresh.length) return;
    await repo.save(fresh);
    subscribeOpen(nowMs).catch(() => {});
  } catch {
    // Deliberately swallowed. See the doc comment.
  }
}

/* ---------------------------------------------------------------------- live marking --- */

/**
 * What a seller would get for one contract right now, straight off the feed.
 *
 * THE BID, NOT THE LAST TRADE. An exit is a sale, and pricing it at the LTP records a level
 * nobody was actually offering. Falling back to the LTP when the book carries no bid is a small
 * optimism, and it is the same one the running mark has always made.
 *
 * `maxAgeMs` is what makes this safe to reuse for a REAL exit rather than a display mark. A tick
 * left over from this morning is not a price anything can be sold at now, and writing one into
 * the record as today's exit would invent a fill. The mark pass passes no bound because a stale
 * mark on screen is visibly stale — the row shows its age — while a stale exit is permanent.
 */
function sellSide(key: string, nowMs: number, maxAgeMs = Infinity): number | null {
  const tick = feedTick(key);
  if (!tick || nowMs - tick.at > maxAgeMs) return null;
  const best = tick.depth?.[0];
  const out = best && best.bidP > 0 ? best.bidP : tick.ltp ?? 0;
  return out > 0 ? out : null;
}

/** Ask the feed for every open contract. Idempotent, so calling it every tick is free. */
async function subscribeOpen(nowMs: number): Promise<void> {
  const day = istDay(nowMs);
  const keys = (await journalRepository().mine(day))
    .filter((t) => t.status === 'open' && t.contract)
    .map((t) => t.contract!.instrumentKey);
  if (keys.length) subscribeKeys(keys);
}

/**
 * One pass over today's open positions: mark them, and close any that have hit a level.
 *
 * The exits found here are provisional — `settleDay` re-derives them from candles afterwards.
 * They exist so the page has something true to show at 11:00, not as the record.
 *
 * Reads the LOCAL copy on purpose. See `JournalRepository.mine`.
 */
export async function journalTick(nowMs = Date.now()): Promise<void> {
  const cfg = journalConfig();
  if (!cfg.enabled) return;
  const repo = journalRepository();
  await subscribeOpen(nowMs).catch(() => {});

  const day = istDay(nowMs);
  // THE TICK IS A LIVE MARKER, and every number it writes is stamped with the minute it is
  // running in. Outside the session that is not a session minute at all — 22:30 is minute 795 —
  // and the square-off below fires on `minute >= squareOffMin`, which every minute of the evening
  // satisfies. A row reopened at night by "revert to settled" was being closed on the spot at
  // minute 795, against a mark left over from the morning, before settlement ever saw it.
  //
  // Nothing here has anything true to say once the close has passed. `settleDay` owns those rows
  // and prices them from the contract's own candles.
  const minute = istMinutes(nowMs) - SESSION_OPEN_MIN;
  if (minute < 0 || minute > SESSION_MINUTES) return;
  const changed: JournalTrade[] = [];

  for (const t of await repo.mine(day)) {
    if (t.status !== 'open' || !t.contract) continue;
    // No age bound here: the running mark carries its own timestamp and the page shows it.
    const out = sellSide(t.contract.instrumentKey, nowMs) ?? 0;
    if (out > 0) {
      const pct = (out - t.entry.premium) / t.entry.premium;
      t.mark = { at: nowMs, premium: +out.toFixed(2), pct: +pct.toFixed(4) };
      // The minute is recorded only when the extreme actually moves, so it always names the tick
      // that set it rather than the tick that last looked.
      // Where the tick-by-tick record of this row begins.
      //
      // Only ever decided on the first mark, because that is the only moment it is knowable.
      // Once the row carries excursions this must not be recomputed: `null` there means "candles
      // covered the whole trade", which is what `backfillExcursions` and `settleDay` write, and
      // re-deriving it from the extremes would undo their work on the very next tick.
      if (t.mfePct === null) {
        t.markedFrom = minute > t.entry.minute + 2 ? minute : null;
      } else if (t.markedFrom === undefined) {
        // A row from before this field existed. Dated from the earliest extreme it managed to
        // record rather than from now, which would claim a blind window wider than the real one.
        const seen = [t.mfeMinute, t.maeMinute].filter((m): m is number => m !== null && m !== undefined);
        t.markedFrom = seen.length ? Math.min(...seen) : null;
      }
      // THE WHOLE WINDOW, NOT THE INSTANT. `out` is where the bid stands right now; `range` is
      // everywhere it has been since the previous pass. Levels are tested against the range and
      // the excursions are built from it, because a poll every `refresh.quoteMs` cannot otherwise
      // see a move that goes through a level and comes back between two of its own samples — and
      // the 1-minute candles `settleDay` grades against see exactly that. Without this the live
      // row and the settled row disagree for the rest of the session: MPHASIS on 2026-09-01
      // wicked through its checkpoint inside minute 242 and went on marking live until 15:15.
      const range = takeSellRange(t.contract.instrumentKey) ?? { low: out, high: out };
      const lowPct = (range.low - t.entry.premium) / t.entry.premium;
      const highPct = (range.high - t.entry.premium) / t.entry.premium;

      if (t.mfePct === null || highPct > t.mfePct) { t.mfePct = highPct; t.mfeMinute = minute; }
      if (t.maePct === null || lowPct < t.maePct) { t.maePct = lowPct; t.maeMinute = minute; }
      t.updatedAt = nowMs;
      changed.push(t);

      // The stop in force right now. `mfePct` has already absorbed this window above, which is
      // correct here and not look-ahead: a live marker genuinely sees the high before it can act
      // on it, unlike a candle where the two are simultaneous by construction.
      const armed = cfg.armAtPct > 0 && (t.mfePct ?? 0) >= cfg.armAtPct;
      const stop = armed ? cfg.lockPct : -cfg.slPct;

      // Stop checked before target: if this window could be read either way, it is the stop.
      const hitStop = lowPct <= stop;
      if (hitStop || highPct >= cfg.tpPct) {
        // Filled AT THE LEVEL, not at the extreme the window reached through it — the same
        // convention `gradePath` uses on a candle, and the one that does not credit the position
        // with a price it only touched on the way past.
        const exitPct = hitStop ? stop : cfg.tpPct;
        t.exit = {
          at: nowMs, minute, premium: +(t.entry.premium * (1 + exitPct)).toFixed(2),
          spot: null, source: 'auto',
          reason: hitStop ? (armed ? 'checkpoint' : 'stop') : 'target',
        };
        t.status = 'closed';
        price(t);
      }
    }
    if (t.status === 'open' && minute >= cfg.squareOffMin && t.mark) {
      // Stamped at the square-off minute, not at whichever tick first noticed it had passed. The
      // two are the same on a running process and differ after a restart, and "the 15:15
      // square-off" is a rule with a time of its own — it did not happen at 15:23 because that is
      // when the process woke up.
      t.exit = {
        at: sessionAt(day, cfg.squareOffMin), minute: cfg.squareOffMin,
        premium: t.mark.premium, spot: null, source: 'auto', reason: 'square-off',
      };
      t.status = 'closed';
      price(t);
      if (!changed.includes(t)) changed.push(t);
    }
  }
  if (changed.length) await repo.save(changed);
  // Retry anything the database has not taken yet. Cheap, and a no-op when nothing is queued.
  await repo.flush().catch(() => {});
}

/* -------------------------------------------------------------------------- settling --- */

/**
 * Grade one premium path against a target and a stop.
 *
 * Exported because this function IS the journal's opinion — everything else is bookkeeping. The
 * convention it encodes is the one from `research/lab.mjs`: a minute bar cannot say whether its
 * high or its low came first, so a bar that touches both levels is resolved as the STOP. Grading
 * it the other way is how a record flatters itself.
 */
export function gradePath(
  bars: Array<{ minute: number; high: number; low: number; close: number }>,
  paid: number,
  fromMinute: number,
  tp: number,
  sl: number,
  lastMinute: number,
  /**
   * Optional single checkpoint: once the position has been up `armAt`, the stop moves once to
   * `lock` and stays there. Omit it and this grades exactly as it always did.
   *
   * The arming test reads the peak as it stood BEFORE the current bar. Letting a bar both set the
   * high that arms the checkpoint and be stopped on it is how a backtest invents money — in the
   * real session the stop had not moved yet when that low printed.
   */
  checkpoint?: { armAt: number; lock: number },
): {
  pct: number; out: 'target' | 'stop' | 'checkpoint' | 'close'; minute: number;
  mfe: number; mae: number;
  /**
   * The minute each extreme was set, or null while that extreme is still 0.
   *
   * Null rather than the entry minute on purpose: `mfe` and `mae` both start at 0 and are only
   * ever moved by a bar that beat them, so a trade that never traded above its entry has an `mfe`
   * of exactly 0 that belongs to no minute at all. Reporting the entry minute there would invent a
   * moment when the position was at its best, which is the one thing this column must not do.
   */
  mfeMinute: number | null; maeMinute: number | null;
} {
  let mfe = 0, mae = 0, lastClose = paid, lastMin = fromMinute;
  let mfeMinute: number | null = null, maeMinute: number | null = null;
  for (const b of bars) {
    if (b.minute <= fromMinute || b.minute > lastMinute) continue;
    const down = (b.low - paid) / paid;
    const up = (b.high - paid) / paid;

    // The stop in force for THIS bar, from the peak as it stood before it.
    const armed = checkpoint !== undefined && checkpoint.armAt > 0 && mfe >= checkpoint.armAt;
    const stop = armed ? checkpoint.lock : -sl;

    if (down < mae) { mae = down; maeMinute = b.minute; }
    if (up > mfe) { mfe = up; mfeMinute = b.minute; }
    lastClose = b.close; lastMin = b.minute;
    if (down <= stop) {
      return { pct: stop, out: armed ? 'checkpoint' : 'stop', minute: b.minute, mfe, mae, mfeMinute, maeMinute };
    }
    if (up >= tp) return { pct: tp, out: 'target', minute: b.minute, mfe, mae, mfeMinute, maeMinute };
  }
  return { pct: (lastClose - paid) / paid, out: 'close', minute: lastMin, mfe, mae, mfeMinute, maeMinute };
}

/**
 * Grade a path under a rule whose stop can MOVE — a breakeven or a trailing exit.
 *
 * `gradePath` above stays as it is because it grades the shipped exit and the tests pin it; this
 * is the generalisation the shadow rules need, and it reduces to the same answer when a rule has
 * no `armAt`.
 *
 * TWO THINGS HERE ARE LOAD-BEARING AND MUST SURVIVE AN EDIT.
 *
 *   THE TRAIL IS COMPUTED FROM THE PREVIOUS BAR'S PEAK, never this bar's high. Letting one bar
 *   both set a new high and be stopped on the trail derived from that same high is how a
 *   backtest sells every top: in the real session the trail had not moved yet when the low
 *   printed. This single line is the difference between a believable result and a fantasy.
 *
 *   THE STOP IS STILL CHECKED BEFORE THE TARGET, so an ambiguous minute resolves against the
 *   trade, exactly as everywhere else in this file.
 */
export function gradeRule(
  bars: Array<{ minute: number; high: number; low: number; close: number }>,
  paid: number,
  fromMinute: number,
  rule: ExitRule,
  lastMinute: number,
): { pct: number; out: 'target' | 'stop' | 'close'; minute: number } {
  let peak = 0, lastClose = paid, lastMin = fromMinute;
  for (const b of bars) {
    if (b.minute <= fromMinute || b.minute > lastMinute) continue;
    const up = (b.high - paid) / paid;
    const down = (b.low - paid) / paid;

    let stop = -rule.sl;
    if (rule.armAt !== undefined && peak >= rule.armAt) {
      if (rule.lock !== undefined) stop = rule.lock;
      else if (rule.trail !== undefined) stop = rule.trail === 'breakeven' ? 0 : Math.max(-rule.sl, peak - rule.trail);
    }

    if (down <= stop) return { pct: stop, out: 'stop', minute: b.minute };
    if (up >= rule.tp) return { pct: rule.tp, out: 'target', minute: b.minute };

    if (up > peak) peak = up;
    lastClose = b.close; lastMin = b.minute;
  }
  return { pct: (lastClose - paid) / paid, out: 'close', minute: lastMin };
}

/**
 * Upstox candles to the minute-of-session bars `gradePath` grades.
 *
 * EXTRACTED SO IT CAN BE TESTED, because the one line in it was wrong for the life of the module
 * and nothing caught it. `c[0]` is epoch SECONDS — `UpstoxCandle` documents that, and `isoToEpoch`
 * divides by 1000 — while `istMinutes` takes MILLISECONDS. Passing the raw value read a 2026
 * candle as 21 January 1970 and put every bar of every session at minute ~768. `gradePath` drops
 * anything past the square-off minute, so every bar was discarded and it returned its empty-path
 * answer: an exit equal to the entry, at the entry minute, with zero excursion. Every settled
 * trade therefore booked exactly minus the charges, and looked like a real flat day.
 *
 * It survived because the settlement path had never run on a real trade: the journal was empty
 * until a backfill filled it, and backfilled rows arrive already settled. The first live signal to
 * reach settlement (AUBANK, 2026-08-25) exposed it immediately.
 */
export function sessionBars(
  raw: UpstoxCandle[],
): Array<{ minute: number; high: number; low: number; close: number }> {
  return raw
    .map((c) => ({
      minute: Math.max(0, istMinutes(c[0] * 1000) - SESSION_OPEN_MIN),
      high: c[2], low: c[3], close: c[4],
    }))
    .sort((a, b) => a.minute - b.minute);
}

/** One archived contract path: `[minute, high, low, close]` per bar. */
export type ArchivedPath = Array<[number, number, number, number]>;

/**
 * Keep every settled contract's candle path, keyed by trade id.
 *
 * Stored through the same `store` the rest of the module uses, one document a month, so it lands
 * beside the journal and is copied with it. Never throws — an archive that can break settlement
 * would be trading the record for a research convenience.
 */
async function archivePaths(
  day: string,
  trades: JournalTrade[],
  fetched: Map<string, Array<{ minute: number; high: number; low: number; close: number }>>,
): Promise<void> {
  const compact = new Map<string, ArchivedPath>();
  for (const t of trades) {
    if (!t.contract) continue;
    const bars = fetched.get(t.contract.instrumentKey);
    if (!bars?.length || compact.has(t.id)) continue;
    compact.set(t.id, bars.map((b) => [b.minute, b.high, b.low, b.close] as [number, number, number, number]));
  }
  if (!compact.size) return;

  // Local disk FIRST, for the same reason the journal writes locally first: disk is milliseconds
  // and cannot be unreachable, and this is the copy that must exist before the key expires.
  const key = `${STORE_KEYS.journalPaths}_${day.slice(0, 7)}`;
  const doc = (await store.read<Record<string, ArchivedPath>>(key)) ?? {};
  let added = 0;
  for (const [id, bars] of compact) {
    if (doc[id]) continue;
    doc[id] = bars;
    added++;
  }
  if (added) await store.write(key, doc);

  // Then the shared store, best effort. A failure here is logged by the caller's catch and costs
  // nothing permanent — the local copy is already safe and `journal-archive-push` can retry it.
  if (!databaseUrl()) return;
  const rows: OptionPathRow[] = [];
  for (const t of trades) {
    const bars = compact.get(t.id);
    if (!bars || !t.contract) continue;
    rows.push({
      day: t.day,
      instrumentKey: t.contract.instrumentKey,
      symbol: t.symbol,
      strike: t.contract.strike ?? null,
      optType: t.contract.type ?? null,
      expiry: t.contract.expiry ?? null,
      lotSize: t.contract.lotSize ?? null,
      role: 'traded',
      bars,
    });
  }
  if (rows.length) await savePaths(getPool(), rows);
}

/**
 * Fill in the excursions of a position that was not watched from the start.
 *
 * The live pass builds `mfePct`/`maePct` tick by tick, so a row first marked at 02:09 PM knows
 * nothing about the five hours before it — and the trade's own 1-minute candles have known all
 * along. This reads them and replaces the partial figures with the real ones.
 *
 * WHAT IT DELIBERATELY DOES NOT DO IS CLOSE ANYTHING.
 *
 * A path that reached the target or the stop inside the blind window is a trade that, by the
 * rules, should already have exited — and settling it here would be the tidy answer. It is also
 * the answer that reaches into a position the operator may still be holding and books an exit
 * they never took, on the strength of a candle nobody was watching. So the breach is written to
 * the note instead, and the exit is left to `settleDay`, which grades the whole path from entry
 * at square-off and will find the same level honestly.
 *
 * Self-limiting: clearing `markedFrom` is what takes a row out of the selection, so each one is
 * fetched at most once no matter how often the timer fires.
 */
export async function backfillExcursions(day: string, nowMs = Date.now()): Promise<number> {
  const cfg = journalConfig();
  if (!cfg.enabled) return 0;
  const repo = journalRepository();
  const today = istDay(nowMs);

  const gapped = (await repo.mine(day)).filter((t) => {
    if (t.status !== 'open' || !t.contract || t.edited) return false;
    // Never marked at all, or marked from well after entry. Two minutes of slack because the
    // first mark landing a tick after the entry is not a gap.
    if (t.mfePct === null) return true;
    return t.markedFrom !== null && t.markedFrom !== undefined && t.markedFrom > t.entry.minute + 2;
  });
  if (!gapped.length) return 0;

  const changed: JournalTrade[] = [];
  for (const t of gapped) {
    let bars: Array<{ minute: number; high: number; low: number; close: number }>;
    try {
      bars = sessionBars(await sessionCandles(t.contract!.instrumentKey, day, today, 'minutes', 1));
    } catch {
      continue; // Leave the gap flagged. A row that still says so is better than one that lies.
    }
    const path = bars.filter((b) => b.minute >= t.entry.minute);
    if (!path.length) continue;

    const paid = t.entry.premium;
    let mfe = 0, mae = 0, mfeMinute: number | null = null, maeMinute: number | null = null;
    let breach: { out: 'target' | 'stop'; minute: number } | null = null;
    for (const b of path) {
      const up = (b.high - paid) / paid, down = (b.low - paid) / paid;
      if (down < mae) { mae = down; maeMinute = b.minute; }
      if (up > mfe) { mfe = up; mfeMinute = b.minute; }
      // Stop before target, the same way round `gradePath` resolves a bar that touches both.
      if (!breach && down <= -cfg.slPct) breach = { out: 'stop', minute: b.minute };
      if (!breach && up >= cfg.tpPct) breach = { out: 'target', minute: b.minute };
    }

    t.mfePct = +mfe.toFixed(4);
    t.maePct = +mae.toFixed(4);
    t.mfeMinute = mfeMinute;
    t.maeMinute = maeMinute;
    // The candles ran from entry, so there is no longer a window this row cannot account for.
    t.markedFrom = null;
    if (breach) {
      const said = `${breach.out} touched at minute ${breach.minute} while unwatched`;
      if (!t.note.includes(said)) t.note = [t.note, said].filter(Boolean).join(' · ');
    }
    t.updatedAt = nowMs;
    changed.push(t);
  }
  if (changed.length) await repo.save(changed);
  return changed.length;
}

/**
 * Fetch each open contract's own candles and write the authoritative exit.
 *
 * Runs after the square-off minute, and on boot for any earlier day left unsettled — which is
 * what makes an overnight restart or a crashed afternoon cost the record nothing.
 */
/**
 * What holding to the square-off would have paid, from the same bars the grade came from.
 *
 * The LAST BAR AT OR BEFORE the square-off, not the last bar there is: option candles run a few
 * minutes past 15:15 and grading to 15:30 would compare the exit rules against a close nobody
 * could have taken. `gradePath` bounds itself the same way.
 */
export function dayEndOf(
  bars: Array<{ minute: number; close: number }>,
  paid: number,
  fromMinute: number,
  size: number,
  lots: number,
  squareOffMin: number,
): JournalTrade['dayEnd'] {
  const last = bars.filter((b) => b.minute > fromMinute && b.minute <= squareOffMin).pop();
  if (!last || !(last.close > 0) || !(size > 0) || !(paid > 0)) return null;
  return {
    premium: +last.close.toFixed(2),
    pct: +((last.close - paid) / paid).toFixed(4),
    // Charged like the real exit, so the two subtract cleanly.
    netPnl: +((last.close - paid) * size - journalConfig().chargePerLot * lots).toFixed(2),
  };
}

export async function settleDay(day: string, nowMs = Date.now()): Promise<number> {
  const cfg = journalConfig();
  if (!cfg.enabled) return 0;
  const repo = journalRepository();
  const today = istDay(nowMs);
  const pending = (await repo.unsettled()).filter((t) => t.day === day && t.contract);
  if (!pending.length) return 0;

  // Fetched before any write: this is the slow part, and interleaving network waits with disk
  // writes would hold the write chain for as long as Upstox takes to answer.
  const fetched = new Map<string, Array<{ minute: number; high: number; low: number; close: number }>>();
  for (const t of pending) {
    const key = t.contract!.instrumentKey;
    if (fetched.has(key)) continue;
    try {
      fetched.set(key, sessionBars(await sessionCandles(key, day, today, 'minutes', 1)));
    } catch {
      fetched.set(key, []);
    }
  }

  // THE PATH IS ARCHIVED BEFORE ANYTHING IS GRADED, because it is perishable in a way nothing
  // else here is. Upstox answers `UDAPI100011 Invalid Instrument key` for a contract whose series
  // has expired — verified on 2026-08-27, when every July and August option in this journal became
  // unfetchable and an exit-rule study across 61 settled trades could no longer be run at all. The
  // trades survived; the evidence needed to ask a NEW question of them did not.
  //
  // Compact on purpose: [minute, high, low, close] per bar, which is everything `gradeRule` reads.
  await archivePaths(day, pending, fetched).catch(() => {});

  const done: JournalTrade[] = [];
  for (const t of pending) {
    const bars = fetched.get(t.contract!.instrumentKey) ?? [];
    // An edited trade is the operator's record of their own fill. Settlement must not overwrite
    // it — it would silently replace what they typed with what the market did.
    //
    // BUT NOT EVERYTHING HERE IS THEIRS. `dayEnd` and the shadow grades describe what the
    // CONTRACT did: both are computed from bars and the entry alone, neither reads `t.exit`, and
    // on a hand-exited row they are the only things that can answer whether getting out early was
    // right. Skipping the whole block withheld them from exactly the rows that needed them most —
    // a manual exit came back with no 15:15 counterfactual to judge itself against.
    if (t.edited) {
      if (bars.length) {
        t.dayEnd = dayEndOf(
          bars, t.entry.premium, t.entry.minute,
          t.contract!.lotSize * t.lots, t.lots, cfg.squareOffMin,
        );
        t.shadow = SHADOW.map((s): JournalShadow => {
          const w = gradeRule(bars, t.entry.premium, t.entry.minute, s, cfg.squareOffMin);
          return { name: s.name, pct: +w.pct.toFixed(4), out: w.out, minute: w.minute };
        });
      }
      t.settled = true; t.updatedAt = nowMs; done.push(t); continue;
    }
    if (!bars.length) {
      // No candles for the contract. Keep whatever the live marks concluded rather than
      // inventing a price, and say so.
      if (!t.exit) {
        t.exit = {
          at: sessionAt(day, t.entry.minute), minute: t.entry.minute, premium: t.entry.premium,
          spot: null, source: 'auto', reason: 'untracked',
        };
        t.note = [t.note, 'no candles for the contract; exit not priced'].filter(Boolean).join(' · ');
        t.status = 'closed';
      }
      t.settled = true; price(t); done.push(t);
      continue;
    }
    const r = gradePath(
      bars, t.entry.premium, t.entry.minute, cfg.tpPct, cfg.slPct, cfg.squareOffMin,
      cfg.armAtPct > 0 ? { armAt: cfg.armAtPct, lock: cfg.lockPct } : undefined,
    );
    // `at` comes from the minute the candle says it happened, NOT from `nowMs`. Settlement is a
    // catch-up job: it grades an afternoon that is already over, and on a restart it grades days
    // that are weeks over. Stamping it with its own clock is how a 12:05 checkpoint came to be
    // filed at 3:16 PM, and how a row re-settled in the evening claimed an eleven-hour hold.
    t.exit = {
      at: sessionAt(day, r.minute), minute: r.minute,
      premium: +(t.entry.premium * (1 + r.pct)).toFixed(2),
      spot: null, source: 'auto',
      reason: r.out === 'close' ? 'square-off' : r.out,
    };
    t.mfePct = +r.mfe.toFixed(4);
    t.maePct = +r.mae.toFixed(4);
    t.mfeMinute = r.mfeMinute;
    t.maeMinute = r.maeMinute;
    // The candles run from entry whatever the marker was doing at the time, so whatever gap the
    // live pass left is now closed and the row should stop advertising one.
    t.markedFrom = null;
    t.shadow = SHADOW.map((s): JournalShadow => {
      const w = gradeRule(bars, t.entry.premium, t.entry.minute, s, cfg.squareOffMin);
      return { name: s.name, pct: +w.pct.toFixed(4), out: w.out, minute: w.minute };
    });
    t.dayEnd = dayEndOf(
      bars, t.entry.premium, t.entry.minute,
      t.contract!.lotSize * t.lots, t.lots, cfg.squareOffMin,
    );
    t.status = 'closed';
    t.settled = true;
    price(t);
    done.push(t);
  }
  if (done.length) await repo.save(done);
  return done.length;
}

/**
 * Settle anything outstanding — today if the square-off has passed, and any earlier day still
 * open. Called from the scheduler; safe to call repeatedly.
 */
export async function journalSettleDue(nowMs = Date.now()): Promise<number> {
  const cfg = journalConfig();
  if (!cfg.enabled) return 0;
  const today = istDay(nowMs);
  const minute = istMinutes(nowMs) - SESSION_OPEN_MIN;
  const days = new Set((await journalRepository().unsettled()).map((t) => t.day));
  let n = 0;
  for (const day of [...days].sort()) {
    if (day === today && minute < cfg.squareOffMin) continue;
    n += await settleDay(day, nowMs);
  }
  return n;
}

/**
 * One-shot startup work: push local history the database has never seen.
 *
 * Called from the scheduler AND from the first journal request, so a process running without the
 * scheduler — `npm run viewer` on the reading machine — still reconciles.
 */
let booted = false;
export async function journalBoot(): Promise<number> {
  if (booted || !journalConfig().enabled) return 0;
  booted = true;
  try {
    return await journalRepository().reconcile(journalConfig().backfillDays);
  } catch {
    return 0;
  }
}

/** Test seam: forget that boot already ran. */
export function resetJournalBoot(): void {
  booted = false;
}

/* --------------------------------------------------------------------------- reading --- */

export interface JournalTotals {
  trades: number;
  closed: number;
  open: number;
  untracked: number;
  wins: number;
  losses: number;
  winRate: number | null;
  amountUsed: number;
  grossPnl: number;
  charges: number;
  netPnl: number;
  /** Net against the money actually deployed, which is the only return that means anything. */
  netPct: number | null;
  best: number | null;
  worst: number | null;
  byChannel: Array<{ channel: string; trades: number; wins: number; netPnl: number; winRate: number | null }>;
  shadow: Array<{ name: string; netPnl: number; wins: number; trades: number }>;
}

export interface JournalDay {
  day: string;
  trades: JournalTrade[];
  totals: JournalTotals;
}

function totals(trades: JournalTrade[]): JournalTotals {
  const cfg = journalConfig();
  const done = trades.filter((t) => t.netPnl !== null);
  const wins = done.filter((t) => (t.netPnl ?? 0) > 0).length;
  const sum = (f: (t: JournalTrade) => number | null) => +done.reduce((a, t) => a + (f(t) ?? 0), 0).toFixed(2);
  const used = +trades.reduce((a, t) => a + (t.amountUsed ?? 0), 0).toFixed(2);
  const net = sum((t) => t.netPnl);

  const channels = new Map<string, { trades: number; wins: number; netPnl: number }>();
  for (const t of trades) {
    const c = channels.get(t.channel) ?? { trades: 0, wins: 0, netPnl: 0 };
    c.trades++;
    if ((t.netPnl ?? 0) > 0) c.wins++;
    c.netPnl += t.netPnl ?? 0;
    channels.set(t.channel, c);
  }

  // What the alternative exits would have returned on the same prices. Only trades that were
  // actually settled carry shadows, so this compares like with like.
  const shadow = SHADOW.map((s) => {
    const rows = trades.filter((t) => t.shadow.some((x) => x.name === s.name) && t.amountUsed);
    let netPnl = 0, w = 0;
    for (const t of rows) {
      const sh = t.shadow.find((x) => x.name === s.name)!;
      const g = sh.pct * (t.amountUsed ?? 0) - cfg.chargePerLot * t.lots;
      netPnl += g;
      if (g > 0) w++;
    }
    return { name: s.name, netPnl: +netPnl.toFixed(2), wins: w, trades: rows.length };
  });

  return {
    trades: trades.length,
    closed: trades.filter((t) => t.status === 'closed').length,
    open: trades.filter((t) => t.status === 'open').length,
    untracked: trades.filter((t) => t.exit?.reason === 'untracked').length,
    wins, losses: done.length - wins,
    winRate: done.length ? +(wins / done.length).toFixed(4) : null,
    amountUsed: used,
    grossPnl: sum((t) => t.grossPnl),
    charges: sum((t) => t.charges),
    netPnl: net,
    netPct: used > 0 ? +(net / used).toFixed(4) : null,
    best: done.length ? Math.max(...done.map((t) => t.netPnl ?? 0)) : null,
    worst: done.length ? Math.min(...done.map((t) => t.netPnl ?? 0)) : null,
    byChannel: [...channels.entries()]
      .map(([channel, c]) => ({
        channel, trades: c.trades, wins: c.wins, netPnl: +c.netPnl.toFixed(2),
        winRate: c.trades ? +(c.wins / c.trades).toFixed(4) : null,
      }))
      .sort((a, b) => b.netPnl - a.netPnl),
    shadow,
  };
}

export interface JournalView {
  from: string;
  to: string;
  channel: string | null;
  days: JournalDay[];
  totals: JournalTotals;
  config: ReturnType<typeof journalConfig> & { shadow: typeof SHADOW };
  sync: JournalSyncStatus;
  /**
   * Weekdays in the range with no record at all.
   *
   * Named "no record" rather than "no signals" on purpose. A day the scanner was not running and
   * a day on which nothing qualified are indistinguishable in the data, and reading the first as
   * the second is how a gap in the record turns into a belief about the market.
   */
  emptyDays: number;
}

export async function journalRange(from: string, to: string, channel?: string | null): Promise<JournalView> {
  const repo = journalRepository();
  const all = await repo.range(from, to, (channel ?? null) as JournalChannel | null);
  const byDay = new Map<string, JournalTrade[]>();
  for (const t of all) {
    const a = byDay.get(t.day) ?? [];
    a.push(t); byDay.set(t.day, a);
  }
  const days: JournalDay[] = [...byDay.keys()].sort().reverse().map((day) => {
    const trades = byDay.get(day)!.sort((a, b) => a.entry.at - b.entry.at);
    return { day, trades, totals: totals(trades) };
  });
  return {
    from, to, channel: channel ?? null, days,
    totals: totals(all),
    config: { ...journalConfig(), shadow: SHADOW },
    sync: await repo.status(),
    emptyDays: Math.max(0, countSessionDays(from, to) - days.length),
  };
}

/** Calendar weekdays in the range. Holidays are not netted out; it is a rough "quiet" count. */
function countSessionDays(from: string, to: string): number {
  let n = 0;
  const a = Date.parse(`${from}T00:00:00Z`), b = Date.parse(`${to}T00:00:00Z`);
  for (let t = a; t <= b && n < 1000; t += 86_400_000) {
    const dow = new Date(t).getUTCDay();
    if (dow !== 0 && dow !== 6) n++;
  }
  return n;
}

/* -------------------------------------------------------------------------- exit lab --- */

/** One rule's score over a set of trades. Rupees, because that is what the decision is in. */
export interface ExitLabResult {
  name: string;
  net: number;
  wins: number;
  losses: number;
  trades: number;
  winRate: number | null;
  /** The single worst and best trade under this rule. */
  worst: number;
  best: number;
  /** Deepest peak-to-trough on the day-by-day equity curve this rule would have produced. */
  maxDrawdown: number;
  /** How the exits split. A rule that never fires its checkpoint is a rule doing nothing. */
  outs: { target: number; stop: number; close: number };
}

export interface ExitLabReport {
  from: string;
  to: string;
  /** Trades in range that could be graded, and the ones with no archived path. */
  graded: number;
  missing: number;
  results: ExitLabResult[];
}

/**
 * Re-grade real trades under arbitrary exit rules, from the archived candle paths.
 *
 * THE ARCHIVE IS THE ONLY SOURCE. This never touches Upstox, and that is a hard requirement
 * rather than an optimisation: it answers an HTTP request, and a study that fetched sixty expired
 * contracts on every slider drag would empty the quota in an afternoon — and would fail anyway,
 * because Upstox rejects the instrument key of an expired series outright. A trade with no
 * archived path is counted in `missing` and left out, which is the honest handling: silently
 * grading a subset and reporting it as the whole book is how a study lies.
 *
 * The grading is `gradeRule`, the same function the shipped shadow rules go through, so a result
 * here and a result in the journal's own shadow column cannot disagree about method — a minute
 * that could have gone either way resolves as the stop in both.
 */
export async function exitLab(
  from: string,
  to: string,
  channel: JournalChannel | null,
  rules: ExitRule[],
): Promise<ExitLabReport> {
  const cfg = journalConfig();
  const trades = (await journalRepository().range(from, to, channel)).filter(
    (t) => t.contract && t.entry.premium > 0 && t.exit && t.exit.reason !== 'untracked',
  );
  const paths = await readArchivedPaths(trades);

  const usable = trades.filter((t) => (paths.get(t.id)?.length ?? 0) > 0);
  const results: ExitLabResult[] = rules.map((rule) => {
    let net = 0, wins = 0, losses = 0, worst = 0, best = 0;
    const outs = { target: 0, stop: 0, close: 0 };
    // Day totals, so the drawdown is measured on the equity curve a trader would have lived
    // through rather than on the order the rows happen to come back in.
    const byDay = new Map<string, number>();

    for (const t of usable) {
      const bars = (paths.get(t.id) as ArchivedPath).map(([minute, high, low, close]) => ({
        minute, high, low, close,
      }));
      const g = gradeRule(bars, t.entry.premium, t.entry.minute, rule, cfg.squareOffMin);
      const pnl = +(g.pct * (t.amountUsed ?? 0) - cfg.chargePerLot * t.lots).toFixed(2);
      net += pnl;
      if (pnl > 0) wins++; else if (pnl < 0) losses++;
      worst = Math.min(worst, pnl);
      best = Math.max(best, pnl);
      outs[g.out]++;
      byDay.set(t.day, (byDay.get(t.day) ?? 0) + pnl);
    }

    let run = 0, peak = 0, maxDrawdown = 0;
    for (const day of [...byDay.keys()].sort()) {
      run += byDay.get(day) as number;
      peak = Math.max(peak, run);
      maxDrawdown = Math.max(maxDrawdown, peak - run);
    }

    return {
      name: rule.name,
      net: +net.toFixed(2),
      wins,
      losses,
      trades: usable.length,
      winRate: wins + losses > 0 ? +(wins / (wins + losses)).toFixed(4) : null,
      worst: +worst.toFixed(2),
      best: +best.toFixed(2),
      maxDrawdown: +maxDrawdown.toFixed(2),
      outs,
    };
  });

  return { from, to, graded: usable.length, missing: trades.length - usable.length, results };
}

/**
 * Archived paths for these trades: the shared store first, local month documents as the fallback.
 *
 * Neon first because it is the copy both machines see and the one that survives a reinstall.
 * Never throws — a study that cannot read the archive returns nothing to grade, which the caller
 * reports as `missing`, rather than failing the request.
 */
async function readArchivedPaths(trades: JournalTrade[]): Promise<Map<string, ArchivedPath>> {
  const out = new Map<string, ArchivedPath>();
  if (!trades.length) return out;

  if (databaseUrl()) {
    try {
      const days = [...new Set(trades.map((t) => t.day))];
      const { rows } = await getPool().query<{ day: string; instrument_key: string; bars: ArchivedPath }>(
        `SELECT day::text AS day, instrument_key, bars FROM momentum_option_path
          WHERE day = ANY($1::date[]) AND role = 'traded'`,
        [days],
      );
      for (const r of rows) {
        const t = trades.find((x) => x.day === r.day && x.contract?.instrumentKey === r.instrument_key);
        if (t) out.set(t.id, r.bars);
      }
    } catch { /* the local months below are the fallback */ }
  }

  for (const month of [...new Set(trades.map((t) => t.day.slice(0, 7)))]) {
    const doc = await store
      .read<Record<string, ArchivedPath>>(`${STORE_KEYS.journalPaths}_${month}`)
      .catch(() => null);
    if (!doc) continue;
    for (const [id, bars] of Object.entries(doc)) if (!out.has(id)) out.set(id, bars);
  }
  return out;
}

/* --------------------------------------------------------------------------- editing --- */

export interface JournalPatch {
  entryPremium?: number;
  exitPremium?: number;
  lots?: number;
  note?: string;
  /** Restore the prices settlement recorded, and let it own the row again. */
  reset?: boolean;
}

/**
 * Replace a trade's prices with the operator's own fill.
 *
 * Once edited, `settleDay` leaves the row alone — otherwise the next settlement pass would
 * quietly overwrite a real contract note with a modelled exit.
 */
export async function journalPatch(id: string, patch: JournalPatch): Promise<JournalTrade | null> {
  const repo = journalRepository();
  const t = await repo.one(id);
  if (!t) return null;

  if (patch.reset) {
    if (t.original) {
      t.entry = t.original.entry;
      t.exit = t.original.exit;
      // The size comes back with the prices. The edit dialog always sends `lots`, so leaving it
      // behind on a revert left the operator's position size attached to the app's entry price —
      // a row that was never held, at a price that was never paid.
      if (t.original.lots !== undefined) t.lots = t.original.lots;
      t.status = t.exit ? 'closed' : 'open';
      delete t.original;
    }
    // The running mark was measured against the entry that has just been thrown away, so its
    // `pct` now describes a trade this row is not: a revert came back still advertising +33%
    // against an entry that made it -5.7%. The premium is an observed price and stays; only the
    // percentage is re-expressed against the entry now in force.
    if (t.mark && t.entry.premium > 0) {
      t.mark = {
        ...t.mark,
        pct: +((t.mark.premium - t.entry.premium) / t.entry.premium).toFixed(4),
      };
    }
    t.edited = false;
    // Left unsettled on purpose: the next settlement pass owns this row again, and for a past
    // day that pass runs within two minutes.
    t.settled = false;
    t.note = '';
  } else {
    // Snapshot before the first mutation, never after — a second edit must not overwrite the
    // only copy of what the market actually said.
    const wasEdited = t.edited;
    if (!wasEdited)
      t.original = { entry: { ...t.entry }, exit: t.exit ? { ...t.exit } : null, lots: t.lots };
    if (patch.entryPremium !== undefined) {
      t.entry.premium = +patch.entryPremium.toFixed(2);
      t.entry.source = 'manual';
      t.edited = true;
    }
    if (patch.exitPremium !== undefined) {
      t.exit = {
        at: Date.now(), minute: t.exit?.minute ?? t.entry.minute, premium: +patch.exitPremium.toFixed(2),
        spot: null, source: 'manual', reason: 'manual',
      };
      t.status = 'closed';
      t.settled = true;
      t.edited = true;
    }
    if (patch.lots !== undefined) { t.lots = Math.max(1, Math.round(patch.lots)); t.edited = true; }
    if (patch.note !== undefined) t.note = patch.note.slice(0, 500);
    // A note-only patch changed no price, so it must not leave a snapshot behind pretending it did.
    if (!t.edited && !wasEdited) delete t.original;
  }
  price(t);
  await repo.save([t]);
  return t;
}

/**
 * How stale the feed's last packet may be and still count as a price you can sell at.
 *
 * Two minutes rather than a few seconds because a far strike can genuinely go a minute without
 * printing, and refusing a real exit on a quiet contract is worse than pricing it a minute late.
 * Past that the honest answer is that nobody knows what it is worth, and the operator types the
 * fill they actually got.
 */
const EXIT_MARK_MAX_AGE_MS = 120_000;

/**
 * Close ONE open position now, at the live bid, because the operator has just sold it.
 *
 * This is the only exit in the file that happens because somebody decided it should. The other
 * three are rules — the target, the stop and the square-off — and `journalTick` writes those on
 * its own. That difference is why the row comes out stamped `manual` and `edited`: `settleDay`
 * skips edited rows, and without that flag the next settlement pass would re-grade this trade
 * against the shipped +80/−50 path and replace a real 11:04 exit with a modelled 15:15
 * square-off. The exit that actually happened would be gone from the record.
 *
 * It refuses rather than guesses. No contract, already closed, or a feed that has not printed
 * this instrument in two minutes all return an error, because every one of them would otherwise
 * be resolved by inventing a price — and an invented exit is indistinguishable from a real one
 * the moment it is written.
 *
 * Returns null when there is no such trade, matching `journalPatch`, so the route can answer 404.
 */
export async function journalExitNow(id: string, nowMs = Date.now()): Promise<JournalTrade | null> {
  const repo = journalRepository();
  const t = await repo.one(id);
  if (!t) return null;
  if (t.status !== 'open' || t.exit) throw new Error('that trade is already closed');
  if (!t.contract) throw new Error('no contract was resolved for this trade, so there is nothing to sell');

  const out = sellSide(t.contract.instrumentKey, nowMs, EXIT_MARK_MAX_AGE_MS);
  if (out === null)
    throw new Error(
      `the feed has no price for ${t.contract.label} in the last ` +
      `${Math.round(EXIT_MARK_MAX_AGE_MS / 1000)}s — record the fill you got with “my fill” instead`,
    );

  const minute = Math.max(0, istMinutes(nowMs) - SESSION_OPEN_MIN);
  const premium = +out.toFixed(2);
  const pct = (premium - t.entry.premium) / t.entry.premium;

  // Snapshot before the first mutation, exactly as `journalPatch` does: this is the only copy of
  // what the market said before the operator overrode it, and it is what "revert to settled"
  // reads. `exit: null` rather than a copy because the guard above has already established that
  // there is no exit yet — reverting this row has to put it back to open.
  if (!t.edited) t.original = { entry: { ...t.entry }, exit: null, lots: t.lots };

  // The excursions have to bracket the outcome. Exiting at the high of the day and leaving `mfe`
  // below the exit would show a row that beat its own best price, which reads as a broken record
  // rather than as the rounding it would actually be.
  if (t.mfePct === null) t.markedFrom = minute > t.entry.minute + 2 ? minute : null;
  if (t.mfePct === null || pct > t.mfePct) { t.mfePct = +pct.toFixed(4); t.mfeMinute = minute; }
  if (t.maePct === null || pct < t.maePct) { t.maePct = +pct.toFixed(4); t.maeMinute = minute; }

  t.mark = { at: nowMs, premium, pct: +pct.toFixed(4) };
  t.exit = { at: nowMs, minute, premium, spot: null, source: 'manual', reason: 'manual' };
  t.status = 'closed';
  // DELIBERATELY LEFT UNSETTLED. `edited` is what protects this fill from being re-graded — the
  // settle pass checks that flag and keeps its hands off the prices. `settled` means something
  // else: that the after-close pass has been over this row and given it the things only candles
  // can, its archived option path and its 15:15 counterfactual. Setting it here hid the row from
  // `settleDay` altogether, so a hand-exited trade was the one kind in the journal that never got
  // its path archived — and the path expires with the series about four weeks later.
  t.edited = true;
  price(t);
  await repo.save([t]);
  // Push it at once rather than waiting for the next tick: this is the row most likely to be
  // read from the other machine within the minute.
  await repo.flush().catch(() => {});
  return t;
}

/* ---------------------------------------------------------------------------- status --- */

export async function journalStatus(nowMs = Date.now()): Promise<Record<string, unknown>> {
  const cfg = journalConfig();
  const repo = journalRepository();
  const day = istDay(nowMs);
  const today = await repo.mine(day).catch(() => [] as JournalTrade[]);
  return {
    enabled: cfg.enabled,
    exit: `+${(100 * cfg.tpPct).toFixed(0)}% / -${(100 * cfg.slPct).toFixed(0)}%`
      + (cfg.armAtPct > 0
        ? `, stop to ${cfg.lockPct >= 0 ? '+' : ''}${(100 * cfg.lockPct).toFixed(0)}% once up ${(100 * cfg.armAtPct).toFixed(0)}%`
        : '')
      + `, square off at minute ${cfg.squareOffMin}`,
    chargePerLot: cfg.chargePerLot,
    lots: cfg.lots,
    today: {
      day,
      trades: today.length,
      open: today.filter((t) => t.status === 'open').length,
      unsettled: today.filter((t) => !t.settled).length,
    },
    // Where the record lives, and whether the far half of it is answering. `remote: 'degraded'`
    // with a non-zero `pending` is the state to act on — the day is safe on disk and is not
    // reaching the machine you read it on.
    sync: await repo.status(),
  };
}

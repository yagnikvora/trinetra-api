// The Ignition signal — one message the moment a move STARTS, rather than once it is proven.
//
// This is the alert the trend-day one structurally cannot be. `minMinutesConfirmed` is 75, so a
// conviction cannot be Confirmed before 10:30 — and by 10:30 the move is 75 minutes old. Replayed
// against 2026-08-14, IDEA fired three entries before 10:00 (09:38 at 13.67, 09:48 at 13.78,
// 09:57 at 13.79) and every one reached its target; the entries available after the trend-day
// alert fired at 10:30 were 14.08 and 14.09 and neither did. The board knew at 09:38. The phone
// heard at 10:30. Nothing was wrong with the model — the phone was wired to the slowest thing it
// produces.
//
// So this alert is keyed off the TIMING layer instead of the conviction layer: `signal.state` and
// `signal.action`, which are recomputed from the last few minutes on every 15-second scan and are
// already a finished entry — trigger, entry, stop, target, entry quality and a contract.
//
// WHAT MAKES IT DIFFERENT FROM THE TREND-DAY ALERT, and why both are worth having:
//
//   IT FIRES EARLY AND IS THEREFORE LESS CERTAIN. That is the whole trade and it is not hidden.
//   The trend-day alert waits 75 minutes because waiting buys confidence; this one does not wait,
//   so some of these will fail. On the 2026-08-14 replay IDEA's ignitions won and APOLLOHOSP's
//   10:36 ignition was stopped. What the reader gets in exchange is the move in front of them
//   rather than behind: `Igniting` is defined as "a trigger fired within the last few minutes,
//   volume is bursting, and the range travelled is still small against ATR" — see types.ts.
//
//   ONE STOCK PER MESSAGE. The trend-day alert batches because seventeen confirmations land in
//   one tick at 10:30. Ignitions do not synchronise — they are spread across the morning by the
//   nature of what they detect — so batching would only delay them, and the reader's question
//   here is "do I take this one", not "which of these fifteen".
//
//   ENTRY QUALITY IS THE GATE, NOT THE SCORE. `entryQuality` is explicitly "what this row is
//   worth AS AN ENTRY" — freshness, pulse strength, room left, alignment, liquidity, nothing
//   cumulative. The 12-factor score is a statement about the stock and rises as a move matures,
//   which is exactly backwards for this purpose: it peaks when the trade is worst.
//
// EVERYTHING ELSE IS BORROWED FROM `trend-day.ts` ON PURPOSE — the markup pair, the once-per-day
// dedupe on disk, the freshness window, the "no ATR, no alert" gate. Those were all written
// against real failures on this channel and re-deriving them here would be re-earning them.

import { istDay, minuteOfSession } from '../session.js';
import { recordEntries } from '../journal/journal.js';
import { store, STORE_KEYS } from '../store.js';
import type {
  FactorKey, MomentumConfig, MomentumRow, SignalPlan, StrikeChoice, TriggerKind,
} from '../types.js';
import { TRIGGER_LABEL } from '../engine/signal.service.js';
import { HTML, istClock, MARKDOWN, type Markup } from '../../alerts/markup.js';
import { discordConfigured, sendDiscord } from '../../alerts/discord.js';
import { sendTelegram, telegramConfigured } from '../../alerts/telegram.js';

/* ------------------------------------------------------------------------ the gate --- */

/** Exported for `alerts/settings.ts`, for the reason given on the trend-day channel's pair. */
export const enabled = (): boolean => (process.env.IGNITION_ALERTS ?? '').trim().toLowerCase() === 'on';

/**
 * The entry-quality floor.
 *
 * 80 by default. On the 2026-08-14 replay that keeps IDEA's 09:38 (88) and 09:57 (92) and drops
 * the tired late-session entries that scored in the 70s and went nowhere. It is the one number
 * worth tuning per taste: lower it for more signals and more failures, raise it for fewer and
 * better. `entryQuality` is bounded 0–100, so anything outside that is ignored rather than obeyed.
 */
export const minEntryQuality = (): number => {
  // Blank reads as unset, not as zero — see the note on the trend-day channel's `minConviction`.
  const raw = (process.env.IGNITION_ALERT_MIN_EQ ?? '').trim();
  const n = Number(raw);
  return raw !== '' && Number.isFinite(n) && n >= 0 && n <= 100 ? n : 80;
};

/**
 * How many ignitions may be announced in a single tick.
 *
 * Not a batching rule — each still gets its own message — but a ceiling on a pathological minute.
 * Ignitions genuinely do not cluster the way 10:30 confirmations do, so this is rarely reached;
 * it exists so that a market-wide gap open cannot put twenty notifications on a phone at 09:20.
 * The ones dropped are the lowest entry quality, and they are named in the last message.
 */
const MAX_PER_TICK = 3;

/**
 * How fresh the trigger has to be.
 *
 * The signal layer already ages a trigger out at `signal.maxTriggerAgeMin` and reports
 * `freshness` 100→0 across that window. This is a second, tighter bound for the PHONE: an
 * ignition is a claim that the move is starting, and a trigger eight minutes old has either
 * worked or failed by the time somebody reads it. It is also the restart guard — a process that
 * boots at 11:00 finds rows mid-move and must not announce them as fresh ignitions.
 */
const MAX_TRIGGER_AGE_MS = 4 * 60_000;

/**
 * States an ignition may be announced from.
 *
 * `Igniting` is the one this alert exists for — types.ts calls it "the only state where a fresh
 * option entry has the whole leg in front of it". `Trending` is included because on a genuine
 * trend day the leg IS the day and the state machine sits there rather than in `Igniting`; the
 * 09:48 IDEA entry that reached target was `Trending`. Everything else is deliberately excluded:
 * `Extending` means the entry is a pullback (that is the trend-day alert's job), and `Extended`,
 * `Stalling` and `Reversing` are the states where the score is highest and the trade is worst.
 */
export const ENTRY_STATES = new Set(["Igniting", "Trending"]);

/* ----------------------------------------------------------------------- the state --- */

interface AlertState {
  day: string;
  /** `SYMBOL|1` / `SYMBOL|-1` for everything already announced today. */
  announced: string[];
}

const EMPTY: AlertState = { day: '', announced: [] };

const key = (symbol: string, dir: 1 | -1): string => `${symbol}|${dir}`;

async function load(day: string): Promise<AlertState> {
  const saved = await store.read<AlertState>(STORE_KEYS.ignitionAlerts);
  return saved && saved.day === day ? { day, announced: saved.announced ?? [] } : { ...EMPTY, day };
}

/* ------------------------------------------------------------------- the selection --- */

export interface IgnitionAlert {
  symbol: string;
  direction: 1 | -1;
  price: number;
  changePct: number;
  state: string;
  entryQuality: number;
  triggerKind: TriggerKind;
  triggerAgeMin: number;
  plan: SignalPlan;
  strike: StrikeChoice | null;
  lotSize: number | null;
  /** How much of a normal day's range is already spent. The "am I early" number. */
  atrUsed: number | null;
  rvol: number | null;
  /** True when the day's own conviction layer already agrees this is one-sided. */
  convictionAgrees: boolean;
  convictionScore: number | null;
}

/**
 * Which rows are announceable ignitions — pure, so the live alert and the backtest below cannot
 * drift apart. Every gate here is a property of the row; nothing reads a clock beyond `nowMs`.
 *
 * ONE ALERT PER SYMBOL PER DIRECTION PER DAY, and that is a real decision rather than a default.
 * The `trendPullback` trigger is designed to repeat — the tradable events on a trend day are the
 * successive dips — but a phone is not a board, and a stock that ignites, fades and re-ignites
 * four times would produce four messages that each read as new information and are not. The
 * repeating entries stay on the board where they belong; the phone gets the first one.
 */
export function selectIgnitions(
  rows: MomentumRow[],
  announced: Set<string>,
  nowMs: number,
  floor: number,
): MomentumRow[] {
  return rows.filter((r) => {
    const s = r.signal;
    if (!s || !s.trigger || !s.plan) return false;
    // An action, not a state. `Watch` and `Stand Aside` are the model declining, and announcing
    // one would be reporting that it thought about it.
    if (s.action !== 'Buy Call' && s.action !== 'Buy Put') return false;
    if (!ENTRY_STATES.has(s.state)) return false;
    if (s.entryQuality < floor) return false;
    // Freshness, which is what makes this an event. Also the restart guard — see the note above.
    if (nowMs - s.trigger.at > MAX_TRIGGER_AGE_MS) return false;
    // The pulse ring is empty for the first few minutes after a boot and every timing reading is
    // dark until it refills. An "ignition" computed from no readings is not one.
    if (!s.pulse.ready) return false;
    // Any gate the signal layer itself failed. `blockers` is that list in words, and an entry
    // with one is one the board is already refusing to offer.
    if (s.blockers.length) return false;
    return !announced.has(key(r.symbol, s.action === 'Buy Call' ? 1 : -1));
  });
}

/** One numeric metric off a named factor, or null when the factor was unavailable. */
function numericMetric(row: MomentumRow, key: FactorKey, metric: string): number | null {
  const v = row.factors.find((f) => f.key === key)?.metrics?.[metric];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Turn a selected row into the alert payload. Pure, and shared with the backtest. */
export function toAlert(r: MomentumRow, nowMs: number): IgnitionAlert {
  const s = r.signal!;
  const direction: 1 | -1 = s.action === 'Buy Call' ? 1 : -1;
  return {
    symbol: r.symbol,
    direction,
    price: r.price,
    changePct: r.changePct,
    state: s.state,
    entryQuality: s.entryQuality,
    triggerKind: s.trigger!.kind,
    triggerAgeMin: (nowMs - s.trigger!.at) / 60_000,
    plan: s.plan!,
    strike: s.strike,
    lotSize: s.strike?.lotSize ?? null,
    atrUsed: s.extension?.atrUsed ?? null,
    // `factors` is an ordered array rather than a map — see types.ts, the order is the order the
    // UI lists them — so this is a lookup by key rather than a property access.
    rvol: numericMetric(r, 'rvol', 'rvol'),
    // Reported rather than required. A confirmed one-sided day behind an ignition is genuine
    // corroboration, but demanding it would re-impose the 10:30 gate this alert exists to escape
    // — and the IDEA entries that worked fired at 09:38, an hour before its conviction confirmed.
    convictionAgrees:
      !!r.conviction &&
      r.conviction.ready &&
      ((direction === 1 && r.conviction.direction === 'Bullish') ||
        (direction === -1 && r.conviction.direction === 'Bearish')),
    convictionScore: r.conviction?.score ?? null,
  };
}

/* ---------------------------------------------------------------------- the message --- */

const inr = (v: number): string => `₹${Math.round(v).toLocaleString('en-IN')}`;
const px = (v: number): string =>
  `₹${v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pct = (v: number): string => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}%`;

/**
 * One ignition, as a message.
 *
 * Deliberately shorter than the trend-day block. That message is read at 10:30 against fifteen
 * others and has to justify a choice between them; this one is read alone, while the move it
 * describes is minutes old, and every line that is not the trade costs time the reader does not
 * have. So: what fired, the levels, the contract, and the one honest caveat.
 */
export function buildMessage(a: IgnitionAlert, m: Markup, nowMs: number): string {
  const arrow = a.direction === 1 ? '🟢' : '🔴';
  const word = a.direction === 1 ? 'BULLISH' : 'BEARISH';
  const out: string[] = [
    `⚡ ${m.bold(`${m.escape(a.symbol)} — ${word} IGNITION`)}`,
    m.italic(`${istClock(nowMs)} IST · ${m.escape(TRIGGER_LABEL[a.triggerKind])} · ${a.triggerAgeMin.toFixed(0)}m ago`),
    '',
    `${arrow} ${m.bold(px(a.price))}  ${pct(a.changePct)}  ·  entry quality ${m.bold(a.entryQuality.toFixed(0))}`,
  ];

  const p = a.plan;
  out.push(
    `    Entry ${m.bold(p.entry.toFixed(2))} · Stop ${m.bold(p.stop.toFixed(2))} (${pct(-p.stopPct)})` +
      ` · Target ${m.bold(p.target.toFixed(2))} (${pct(p.targetPct)})` +
      (p.rewardRisk !== null ? ` · ${m.bold(`${p.rewardRisk.toFixed(2)}R`)}` : ''),
  );

  if (a.strike) {
    const s = a.strike;
    out.push(
      `    🎟 ${m.bold(`BUY ${m.escape(s.label)}`)} ${m.italic(`(${m.escape(s.expiry)}, ${s.expiryDays}d)`)}` +
        ` — ${m.bold(`₹${s.entryCost.toFixed(2)}`)} × ${s.lotSize ?? '?'} = ${m.bold(s.costPerLot === null ? '—' : inr(s.costPerLot))} per lot`,
    );
    if (s.profitPerLot !== null)
      out.push(
        `       🎯 Target → ${m.bold(`+${inr(s.profitPerLot)}`)}` +
          (s.gainPctAtTarget === null ? '' : ` (+${s.gainPctAtTarget.toFixed(0)}%)`),
      );
    for (const w of s.warnings.slice(0, 2)) out.push(`       ⚠️ ${m.escape(w)}`);
  } else {
    out.push(
      a.lotSize
        ? `    ${m.italic(`No option chain this cycle — pick the contract yourself. Lot is ${a.lotSize}.`)}`
        : `    ${m.italic('No option chain this cycle — pick the contract yourself.')}`,
    );
  }

  // The context that decides whether this is early or merely loud.
  const context = [
    `${a.state.toLowerCase()}`,
    a.atrUsed !== null ? `${a.atrUsed.toFixed(2)} ATR of range used` : null,
    a.rvol !== null ? `RVOL ${a.rvol.toFixed(1)}x` : null,
    a.convictionAgrees && a.convictionScore !== null
      ? `one-sided day agrees (conviction ${a.convictionScore.toFixed(0)})`
      : null,
  ]
    .filter(Boolean)
    .join(' · ');
  out.push(`    ${m.italic(context)}`);

  // SAID EVERY TIME, because it is the thing that separates this alert from the trend-day one and
  // a reader who forgets it will size these the same way. An ignition is a claim about the next
  // few minutes, not a proven day.
  out.push('');
  out.push(m.italic('Early signal — the move is starting, not proven. Stops and targets are on the underlying. Nothing here is advice.'));
  return out.join('\n');
}

/* ------------------------------------------------------------------------ the drive --- */

let lastSentAt: number | null = null;
let lastError: string | null = null;
let announcedToday = 0;
let suppressedToday = 0;

/**
 * Called once per scan with the finished board. Never throws — an alert channel must not be able
 * to fail the scan that produced it.
 */
export async function onScan(
  rows: MomentumRow[],
  _cfg: MomentumConfig,
  nowMs: number,
  baselineReady: boolean,
): Promise<IgnitionAlert[]> {
  if (!enabled()) return [];

  try {
    // Same gate as the trend-day alert, for the same reason: entry, stop and target are all
    // multiples of ATR, and a message without them is the one that was asked not to be built.
    // No separate notice here — the trend-day alert already sends one a day and two would be noise.
    if (!baselineReady) return [];

    const day = istDay(nowMs);
    const state = await load(day);
    const announced = new Set(state.announced);

    const picked = selectIgnitions(rows, announced, nowMs, minEntryQuality())
      .map((r) => toAlert(r, nowMs))
      .sort((a, b) => b.entryQuality - a.entryQuality);
    if (!picked.length) return [];

    const sending = picked.slice(0, MAX_PER_TICK);
    const dropped = picked.slice(MAX_PER_TICK);
    if (dropped.length) suppressedToday += dropped.length;

    // Recorded BEFORE the send, exactly as the bells and the trend-day alert do it: a channel
    // slower than the 15-second scan would otherwise be handed the same rows on the next tick.
    // Only what is actually sent is recorded, so a dropped one can still go out later.
    state.announced = [...announced, ...sending.map((a) => key(a.symbol, a.direction))];
    await store.write(STORE_KEYS.ignitionAlerts, state);
    announcedToday = state.announced.length;

    await deliver(sending, dropped, nowMs);
    await recordEntries('ignition', sending.map((a) => ({
      symbol: a.symbol,
      direction: a.direction,
      spot: a.price,
      minute: minuteOfSession(nowMs),
      lotSize: a.lotSize,
      strike: a.strike,
      readings: {
        entryQuality: a.entryQuality,
        changePct: a.changePct,
        atrUsed: a.atrUsed,
        rvol: a.rvol,
        convictionScore: a.convictionScore,
      },
      note: a.triggerKind,
    })), nowMs);
    return sending;
  } catch (e) {
    lastError = String((e as Error).message);
    return [];
  }
}

async function deliver(alerts: IgnitionAlert[], dropped: IgnitionAlert[], nowMs: number): Promise<void> {
  if (!telegramConfigured() && !discordConfigured()) {
    lastError = 'no phone channel is configured';
    return;
  }

  const results: boolean[] = [];
  for (const [i, a] of alerts.entries()) {
    // The tail note rides on the last message rather than becoming a message of its own — a
    // notification whose entire content is "two more" is the kind of thing that gets a bot muted.
    const tail =
      i === alerts.length - 1 && dropped.length
        ? `\n\n_+ ${dropped.length} more ignited this minute: ${dropped.map((d) => d.symbol).join(', ')} — on the Momentum Scanner._`
        : '';
    const jobs: Promise<boolean>[] = [];
    if (telegramConfigured()) jobs.push(sendTelegram(buildMessage(a, HTML, nowMs) + tail));
    if (discordConfigured()) jobs.push(sendDiscord(buildMessage(a, MARKDOWN, nowMs) + tail, a.direction));
    results.push(...(await Promise.all(jobs)));
  }

  lastError = results.every(Boolean) ? null : 'a configured channel refused the message';
  lastSentAt = nowMs;
}

/** Reported on `/momentum/status`. */
export const ignitionAlertStatus = () => ({
  enabled: enabled(),
  minEntryQuality: minEntryQuality(),
  maxTriggerAgeMin: MAX_TRIGGER_AGE_MS / 60_000,
  announcedToday,
  // Non-zero means a minute produced more ignitions than the per-tick ceiling. They are not lost
  // — an unannounced symbol is still eligible on a later tick — but a climbing number means the
  // entry-quality floor is set too low for this market.
  suppressedToday,
  lastSentAt,
  lastError,
});

/** Test seam. */
export const resetIgnitionAlerts = async (): Promise<void> => {
  lastSentAt = null;
  lastError = null;
  announcedToday = 0;
  suppressedToday = 0;
  await store.write(STORE_KEYS.ignitionAlerts, { ...EMPTY });
};

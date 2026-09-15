// The Trend Day signal — one message the moment a stock's conviction is CONFIRMED.
//
// This is the alert the trend-day board could never be. The board is a state you look at; this is
// the event you cannot be looking at, because it happens at 10:30 while you are reading something
// else. `advanceTrend` in `data/session-state.ts` promotes a stock to `Confirmed` after 75 minutes
// of session, a conviction of 70 held for twenty, and half an ATR of actual displacement — and the
// instant that promotion lands is the one moment worth interrupting somebody for.
//
// FOUR THINGS DECIDE WHETHER THIS IS USABLE OR MUTED, and all four came out of the real board.
//
//   THE 10:30 STAMPEDE. `minMinutesConfirmed` is 75, so nothing may confirm before 10:30 and a
//   great many things confirm AT 10:30 — on 2026-08-12 seventeen stocks confirmed and eight of
//   them landed in the same fifteen-second tick. Eight notifications in one second is how a
//   channel gets muted, and a muted channel costs the one alert that mattered. So a tick's
//   confirmations are collected and sent as ONE message. Nothing is delayed and nothing is
//   dropped: a lone confirmation at 13:29 is still its own message, sent within fifteen seconds.
//
//   IT MUST NOT FIRE LATE. A confirmation is only announced while it is fresh — see
//   `MAX_CONFIRM_AGE_MS`. That is what makes the alert honest ("this just happened" rather than
//   "this happened at some point"), and it is also the restart guard: a process that boots at
//   14:00 finds seventeen rows already sitting at `Confirmed`, and without the freshness test it
//   would announce all seventeen as though the afternoon had just erupted.
//
//   IT MUST NOT FIRE TWICE. Confirmed is a STATE, not an edge — the row stays there for hours, and
//   the phase machine's hysteresis lets a day fade and re-confirm. So a symbol and direction is
//   announced once per day, recorded to the same disk store the baseline uses so a restart does
//   not re-announce.
//
//   THE PLAN HAS TO BE REAL. The message names a contract, a stop, a target and what one lot
//   costs, so those numbers are built by `buildTrendDayPlan` — the module's own plan builder,
//   pinned to trend mode — and never recomputed here. A second implementation of the strategy
//   living inside the alert is how the message and the board start disagreeing about a price.
//
// WHAT THE MESSAGE DOES NOT CLAIM. Confirmation is a statement about the DAY, not about this
// second's entry: by 10:30 the move is 75 minutes old and price is often extended. The module's
// own view is that the good trend-day entry is a retracement into the trend, so the message says
// how far off the day's extreme price currently is and lets that be read rather than implying the
// confirmation price is the entry.

import { istDay, minuteOfSession } from '../session.js';
import { store, STORE_KEYS } from '../store.js';
import { getBaseline } from '../data/baseline.js';
import { stockChain } from '../data/option-chain.js';
import { universe } from '../data/universe.js';
import { selectStrike } from '../services/strike.service.js';
import { recordEntries } from '../journal/journal.js';
import { displacementTaken } from './displacement.js';
import { latestTrendPlans, type TrendDayPlan } from '../engine/momentum.engine.js';
import type {
  ConvictionSummary, MomentumConfig, MomentumRow, SignalPlan, StrikeChoice,
} from '../types.js';
// Delivery and markup come from the platform-level alerts module at `src/alerts/`. They used to
// live inside the pullback scanner, which is why this note exists at all: when that scanner was
// removed they moved out, because a channel is delivery and not strategy code.
import { HTML, istClock, MARKDOWN, type Markup } from '../../alerts/markup.js';
import { discordConfigured, sendDiscord } from '../../alerts/discord.js';
import { sendTelegram, telegramConfigured } from '../../alerts/telegram.js';

/**
 * How fresh a confirmation has to be to be worth announcing.
 *
 * Ten minutes. Long enough to survive a slow tick, a restart or a scan that overran; short enough
 * that "just confirmed" is a true statement. Anything older is a fact about the board, which is
 * what the board is for.
 */
const MAX_CONFIRM_AGE_MS = 10 * 60_000;

/**
 * Chains fetched per tick to price a contract for rows the shortlist missed.
 *
 * Sized for the stampede rather than for an average tick. Six covered the common case — a lone
 * confirmation at 13:29 — and quietly starved the one that matters: the batch is sorted by
 * conviction, so on a seventeen-stock 10:30 the top six got a contract and the remaining eleven
 * got "pick the contract yourself". This is one request per symbol on the one or two ticks a day
 * that carry confirmations, against the ~28 the enrichment tier already spends every minute, so
 * covering a whole stampede is affordable and the ceiling is only here to bound a pathological day.
 */
const MAX_CHAIN_FETCHES = 20;

/**
 * Telegram rejects a message over 4096 characters, and a rejected batch is a silent miss. Discord
 * embeds cap at the same figure, so one budget serves both with room for the markup.
 */
const MAX_MESSAGE_CHARS = 3600;

/**
 * How many messages one tick's confirmations may be split across.
 *
 * The batching rule above exists because eight notifications in one second is how a channel gets
 * muted. Trimming was the first answer to that and it overshot: a stock past the character budget
 * lost its plan, its contract, its lot and its cost — everything the message exists to carry — to
 * save a buzz. Three is the compromise. A stampede worth three notifications is the single most
 * informative moment of the trading day, and past three the remainder is still named rather than
 * dropped in silence.
 */
const MAX_MESSAGES = 3;

/* ------------------------------------------------------------------------ the gate --- */

// Exported so `alerts/settings.ts` can report what the channel is ACTUALLY set to without
// re-deriving the rule. That module writes the environment this reads; it never reads it itself.
export const enabled = (): boolean => (process.env.TREND_DAY_ALERTS ?? '').trim().toLowerCase() !== 'off';

/**
 * The conviction floor, at confirmation.
 *
 * 65 by default. On the 2026-08-12 board that takes seventeen confirmations down to about seven —
 * the ones with genuine one-sidedness behind them — and drops the likes of a 47 that reached
 * `Confirmed` early and has been decaying inside the fade hysteresis ever since.
 */
export const minConviction = (): number => {
  // BLANK IS NOT ZERO. `Number('')` is 0, which is finite and in range, so an env line left as
  // `TREND_DAY_ALERT_MIN_CONVICTION=` — the obvious way to clear a setting by hand — used to read
  // as a floor of zero and announce every confirmation on the board. An unset setting means the
  // default, and a floor of 0 has to be asked for by writing it.
  const raw = (process.env.TREND_DAY_ALERT_MIN_CONVICTION ?? '').trim();
  const n = Number(raw);
  return raw !== '' && Number.isFinite(n) && n >= 0 && n <= 100 ? n : 65;
};

/* ----------------------------------------------------------------------- the state --- */

interface AlertState {
  day: string;
  /** `SYMBOL|1` / `SYMBOL|-1` for everything already announced today. */
  announced: string[];
  /**
   * Whether today's "the baseline is missing, alerts are withheld" notice has gone out.
   *
   * Persisted for the same reason `announced` is: the scan runs every fifteen seconds, and a
   * condition that lasts until somebody rebuilds the baseline would otherwise send that notice
   * two hundred and forty times an hour.
   */
  suppressionNotice?: boolean;
}

const EMPTY: AlertState = { day: '', announced: [] };

const key = (symbol: string, dir: 1 | -1): string => `${symbol}|${dir}`;

/**
 * Today's record. A stored record from a previous day is discarded rather than migrated — the
 * whole point of it is "already announced TODAY", and yesterday's list would silence this morning.
 */
async function load(day: string): Promise<AlertState> {
  const saved = await store.read<AlertState>(STORE_KEYS.trendAlerts);
  return saved && saved.day === day
    ? { day, announced: saved.announced ?? [], suppressionNotice: saved.suppressionNotice ?? false }
    : { ...EMPTY, day };
}

/* ------------------------------------------------------------------- the selection --- */

export interface TrendDayAlert {
  symbol: string;
  direction: 1 | -1;
  price: number;
  changePct: number;
  conviction: ConvictionSummary;
  plan: SignalPlan | null;
  strike: StrikeChoice | null;
  /**
   * The "am I chasing" pair, both already on the row.
   *
   * `minutesSinceExtreme` is the direct answer: a stock that made a new low ninety seconds ago is
   * still extending, and buying it at the confirmation price is buying the spike. `atrUsed` is how
   * much of the day's expected range is already spent, which is the same question at day scale.
   *
   * The exact ATR-off-the-extreme figure the trend re-entry gate uses is computed inside
   * `signal.service.ts` and not carried on the row; plumbing it through the public row type to
   * decorate a message would be a wider change than the line is worth.
   */
  minutesSinceExtreme: number | null;
  atrUsed: number | null;
  lotSize: number | null;
}

/**
 * Which alerts still need a chain fetched, in the order the cap should spend itself.
 *
 * Pure and separated from `priceContracts` for the same reason `newlyConfirmed` is separated from
 * `onScan`: the ordering is the whole correctness of the cap and it should be testable without a
 * chain or a clock.
 *
 * PLANNED ROWS FIRST. Every alert that goes out now gets a contract, plan or no plan, so the
 * plan-less rows compete for `MAX_CHAIN_FETCHES` slots that used to be reserved for planned ones
 * by the filter itself. A stable partition keeps the conviction order inside each group and
 * guarantees the first `MAX_CHAIN_FETCHES` still contains every row the old filter would have
 * priced — so widening the filter cannot cost a planned row its chain on a heavy tick. Seventeen
 * stocks confirmed on 2026-08-12 and eight landed in one tick; the cap is not hypothetical.
 */
export function needingChains(alerts: TrendDayAlert[]): TrendDayAlert[] {
  return alerts
    .filter((a) => !a.strike)
    .sort((x, y) => Number(Boolean(y.plan)) - Number(Boolean(x.plan)))
    .slice(0, MAX_CHAIN_FETCHES);
}

/**
 * Which rows have just confirmed and clear the floor — pure, so the whole selection is testable
 * without a clock, a chain or a disk.
 */
export function newlyConfirmed(
  rows: MomentumRow[],
  announced: Set<string>,
  nowMs: number,
  floor: number,
  /**
   * Symbols another channel has already taken today — see `displacementTaken`.
   *
   * ONE STOCK, ONE POSITION, whatever names the day gives it. A displacement alert at 09:50 and
   * a trend-day confirmation at 10:30 on the same underlying are not two ideas: it is the same
   * move, read twice by two detectors that were built to notice it at different hours. Buying it
   * again puts a second lot of premium on one thesis while the journal reports two independent
   * signals, which flatters the count and doubles the loss when the move fails. On 2026-09-09 it
   * happened three times in one morning — ADANIENT, COALINDIA and HDFCLIFE were each taken twice.
   *
   * Blocked on the SYMBOL, not on the direction: the second read being bearish where the first
   * was bullish makes it a worse trade, not a different one.
   */
  blocked: Set<string> = new Set(),
): MomentumRow[] {
  return rows.filter((r) => {
    const c = r.conviction;
    if (!c || c.phase !== 'Confirmed' || c.confirmedAt === null) return false;
    if (c.direction !== 'Bullish' && c.direction !== 'Bearish') return false;
    // Freshness first — it is the test that makes this an event rather than a state, and the one
    // that stops a restart from announcing a whole afternoon at once.
    if (nowMs - c.confirmedAt > MAX_CONFIRM_AGE_MS) return false;
    if (c.score < floor) return false;
    if (blocked.has(r.symbol)) return false;
    return !announced.has(key(r.symbol, c.direction === 'Bullish' ? 1 : -1));
  });
}

/* -------------------------------------------------------------------- the contract --- */

/**
 * Price a contract for a row the enrichment shortlist did not reach.
 *
 * The shortlist is ranked by provisional score and entry quality, and a stock that has quietly
 * walked one direction since 09:30 is by construction not near the top of either — which is the
 * same blind spot the conviction layer itself was written to fix. Most confirmations therefore
 * arrive with no chain, and a trend-day alert with no contract is exactly the alert that was
 * asked not to be built.
 *
 * Bounded and fire-and-forget: at most `MAX_CHAIN_FETCHES` a tick, and a failure leaves the
 * contract null and the message still goes with the stock plan on it.
 */
async function priceContracts(alerts: TrendDayAlert[], cfg: MomentumConfig, nowMs: number): Promise<void> {
  if (!alerts.length) return;

  // The chain is addressed by the underlying's instrument key, which the row does not carry. The
  // universe is memoised for the day, so this resolves without an upstream request — and it is
  // also where the lot size comes from, since NSE lists the same lot for that underlying's
  // options as for its future.
  const uni = await universe(nowMs);

  // THE LOT IS NOT THE CHAIN'S TO GIVE, and filling it first is the difference between a message
  // that can be acted on and one that cannot. It comes off the futures contract in the universe
  // — no request, no ATR, no plan — but it used to be assigned inside the chain fetch below,
  // which is skipped for any row without a plan. So on 2026-08-13 a missing ATR took the lot size
  // and the position cost down with the stop and the target, none of which needed it.
  for (const a of alerts) a.lotSize ??= uni.bySymbol.get(a.symbol)?.future?.lotSize ?? null;

  // EVERY ALERT THAT GOES OUT GETS A CONTRACT, including one the plan builder declined.
  //
  // This used to require a plan, on the reasoning that a strike is ranked against the plan's
  // target and picking one without it would be naming a strike on no reasoning at all. The
  // reasoning was sound and the conclusion was wrong, because the target handed to the picker is
  // not a recommendation — it is the move the contract has to survive, which is why
  // `displacement.ts` derives its own from ATR and has never needed a plan at all.
  //
  // What the requirement actually cost: a confirmed day that has stopped making new extremes goes
  // stale, `trendStale` withdraws the ATR budget, `roomAtr` reads 0 on an already-extended stock
  // and `buildPlan` returns null. The alert still goes out — `usable` passes it on ATR alone —
  // but it went out with no contract, so `recordEntries` journalled it `untracked`: no premium,
  // no path, no grade, and no way to ever ask whether the trade was worth taking. KALYANKJIL on
  // 2026-09-01 was stale by 3.1 minutes and cost a +12% session that the journal could not see.
  //
  // So: rank against the plan's target when there is one, and against the same ATR target the
  // plan itself would have used when there is not. The MESSAGE still prints no stop and no
  // target for a plan-less row — see `contractLines` — because the model genuinely declined to
  // size those. Naming the contract is not the same claim as naming a level.
  //
  // PLANNED ROWS TAKE THE CAP FIRST, so widening the filter cannot cost a row a chain it would
  // have had before. `alerts` arrives sorted by conviction and this is a stable partition, so the
  // planned rows keep that order among themselves and are followed by the plan-less ones in
  // theirs — which means the first `MAX_CHAIN_FETCHES` still contains every row the old filter
  // would have priced. Without this the change would be a silent regression on the heavy ticks
  // this cap exists for: 17 stocks confirmed on 2026-08-12 and 8 landed in one tick.
  const needing = needingChains(alerts);
  if (!needing.length) return;

  // Only fetched when something actually needs it, and only for the plan-less rows: the baseline
  // is the same per-symbol ATR `buildPlan` works from, so the fallback target is the one the plan
  // would have carried had its budget not been withdrawn.
  const atrOf = needing.every((a) => a.plan)
    ? new Map<string, number>()
    : new Map(
      Object.values((await getBaseline(nowMs).catch(() => ({ baseline: null }))).baseline?.symbols ?? {})
        .filter((s) => s.atr > 0)
        .map((s) => [s.symbol, s.atr] as const),
    );

  await Promise.all(
    needing.map(async (a) => {
      try {
        const member = uni.bySymbol.get(a.symbol);
        if (!member) return;
        // A plan-less row with no ATR either has nothing to rank against and nothing to say. That
        // is the baseline hole the message already names, not this stalled-day case.
        const atr = atrOf.get(a.symbol) ?? null;
        const target = a.plan?.target
          ?? (atr === null ? null : a.price + a.direction * cfg.signal.trend.targetAtr * atr);
        if (target === null) return;
        const chain = await stockChain(a.symbol, member.equityKey, nowMs);
        a.strike = selectStrike({
          chain,
          direction: a.direction,
          spot: a.price,
          targetPrice: target,
          lotSize: a.lotSize,
          // The same band `buildSignal` uses for a trend re-entry. A confirmed trend day is a
          // 30–90 minute hold, not a scalp, so the payoff ranking on its own would walk out to
          // the cheapest strike and buy something that stops tracking the stock the plan is on.
          preferDelta: { min: cfg.signal.trend.strike.minDelta, max: cfg.signal.trend.strike.maxDelta },
          maxThetaPctPerHour: cfg.signal.trend.strike.maxThetaPctPerHour,
          config: cfg,
        });
      } catch {
        // Left null. The alert is worth sending without a contract; it is not worth failing over.
      }
    }),
  );
}

/* ---------------------------------------------------------------------- the message --- */

/** Rupee totals, rounded — at a lot's scale a rupee is noise. */
const inr = (v: number): string => `₹${Math.round(v).toLocaleString('en-IN')}`;

/**
 * A share price, to the paise.
 *
 * Rounded, ₹1432.50 renders as ₹1,433 — a price the reader then cannot match against the entry on
 * the line below it, which is the sort of small discrepancy that makes someone re-check every other
 * number in the message.
 */
const px = (v: number): string => `₹${v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** A signed percentage with a real minus sign, so it matches the stop and target lines. */
const pct = (v: number): string => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}%`;

const arrow = (d: 1 | -1): string => (d === 1 ? '🟢' : '🔴');
const word = (d: 1 | -1): string => (d === 1 ? 'BULLISH' : 'BEARISH');

/** One stock's block. */
function block(a: TrendDayAlert, m: Markup): string[] {
  const c = a.conviction;
  const out: string[] = [
    `${arrow(a.direction)} ${m.bold(m.escape(a.symbol))}  ${px(a.price)}  ${pct(a.changePct)}`,
  ];

  // CONVICTION GETS ITS OWN LINE, because it is the number that decides whether the rest of the
  // message is worth reading — it is what the alert's own floor gates on — and it used to be the
  // first of five similar-looking figures on one line, where a reader scanning a 10:30 batch had
  // to pick it out from adherence, crossings, dip depth and hold time.
  //
  // A line of its own rather than the headline above: `buildMessages` drops a block's FIRST line
  // when the batch is a single stock, because the message header already names it. Putting
  // conviction there would have silently removed it from exactly the messages that carry one
  // confirmation — which is most of them outside the 10:30 stampede.
  out.push(`    🎯 ${m.bold(`CONVICTION ${c.score.toFixed(0)}`)}`);

  // The shape behind the verdict. Without it "conviction 73" is a number the reader has to trust;
  // with it, they can disagree — which is the whole reason the conviction layer reports its
  // sub-reads rather than just its score. Conviction itself is on the line above now, so what
  // remains here is only the evidence for it.
  const shape = [
    c.vwapAdherence !== null ? `${(c.vwapAdherence * 100).toFixed(0)}% ${a.direction === 1 ? 'above' : 'below'} VWAP` : null,
    c.vwapCrossings !== null ? `${c.vwapCrossings} crossing${c.vwapCrossings === 1 ? '' : 's'}` : null,
    c.deepestPullbackAtr !== null ? `deepest dip ${c.deepestPullbackAtr.toFixed(2)} ATR` : null,
    c.heldMin !== null ? `held ${c.heldMin.toFixed(0)}m` : null,
  ].filter(Boolean).join(' · ');
  // Guarded, because every entry above is nullable: on a row with no conviction sub-reads this
  // used to push a line containing four spaces, which renders as a blank gap under the score.
  if (shape) out.push(`    ${shape}`);

  if (a.plan) {
    const p = a.plan;
    out.push(
      `    Entry ${m.bold(p.entry.toFixed(2))} · Stop ${m.bold(p.stop.toFixed(2))} (${pct(-p.stopPct)})` +
      ` · Target ${m.bold(p.target.toFixed(2))} (${pct(p.targetPct)})` +
      (p.rewardRisk !== null ? ` · ${m.bold(`${p.rewardRisk.toFixed(2)}R`)}` : ''),
    );
  } else {
    // NAMED, NOT GUESSED AT. `buildPlan` declines for two reasons and they want opposite responses,
    // so the line says which:
    //
    //   no ATR      the daily baseline never covered this symbol — a build that ran out of request
    //               budget leaves exactly this hole, and it persists for the whole session.
    //               Fixable: POST /momentum/baseline/rebuild.
    //   no room     the day is `stale` in `trendContext`'s sense — still one-sided, but it stopped
    //               making new extremes, so the retired range ceilings come back and there is no
    //               budget left to size a target against. Not a fault; it is the model declining
    //               to hand a 2R target to something that has gone nowhere for hours.
    //
    // An earlier version blamed the baseline for both, which sent a reader to check a build that
    // was fine.
    out.push(
      a.atrUsed === null
        ? `    ${m.italic('No levels — this stock has no ATR in today\'s baseline, so no stop or target can be sized.')}`
        : `    ${m.italic('No levels — the day has stopped making new extremes, so the model will not size a target on it.')}`,
    );
  }

  if (a.strike) {
    const s = a.strike;
    out.push(
      `    🎟 ${m.bold(`BUY ${m.escape(s.label)}`)} ${m.italic(`(${m.escape(s.expiry)}, ${s.expiryDays}d)`)}` +
      ` — ${m.bold(`₹${s.entryCost.toFixed(2)}`)} × ${s.lotSize ?? '?'} = ${m.bold(s.costPerLot === null ? '—' : inr(s.costPerLot))} per lot`,
    );
    const legs = [
      // ONLY WHEN THERE IS A PLAN. A plan-less row is still given a contract so the journal can
      // track it, and the picker was handed an ATR target to rank strikes against — but that
      // target is an input to the ranking, not a level anybody promised. Printing rupees against
      // it here would contradict the "the model will not size a target on it" line directly
      // above. `riskPerLot` already returns null without a plan, so on such a row this whole
      // line drops out and the contract stands on its own.
      a.plan && s.profitPerLot !== null
        ? `🎯 Target → ${m.bold(`+${inr(s.profitPerLot)}`)}${s.gainPctAtTarget === null ? '' : ` (+${s.gainPctAtTarget.toFixed(0)}%)`}`
        : null,
      // The downside in rupees, first-order in delta. Labelled an estimate because it is one —
      // the chain prices the upside properly and has no equivalent for the stop.
      riskPerLot(a) !== null ? `🛑 Stop → ${m.bold(`−${inr(riskPerLot(a) as number)}`)} ${m.italic('(est.)')}` : null,
    ].filter(Boolean).join(' · ');
    if (legs) out.push(`       ${legs}`);
    out.push(
      `       Delta ${Math.abs(s.delta).toFixed(2)}` +
      (s.iv === null ? '' : ` · IV ${s.iv.toFixed(0)}`) +
      (s.spreadPct === null ? '' : ` · spread ${s.spreadPct.toFixed(1)}%`) +
      (s.breakEven === null ? '' : ` · B/E ${s.breakEven.toFixed(2)}`),
    );
    for (const w of s.warnings.slice(0, 2)) out.push(`       ⚠️ ${m.escape(w)}`);
  } else {
    // No contract, but say what IS known. The lot is the piece a reader cannot look up in their
    // head, and it comes off the future rather than off the chain — so a cycle with no chain
    // still knows it, and printing it turns "pick the contract yourself" from a dead end into an
    // instruction someone can follow at their broker.
    out.push(
      a.lotSize
        ? `    ${m.italic(`No option chain this cycle — pick the contract yourself. Lot is ${a.lotSize}.`)}`
        : `    ${m.italic('No option chain for this stock this cycle — pick the contract yourself.')}`,
    );
  }

  // The honesty line. Confirmation is a claim about the DAY; it is not a claim that this second is
  // the entry, and by 10:30 the move is already 75 minutes old. This module's own view is that the
  // trend-day entry worth taking is a retracement into the trend, so a row still printing new
  // extremes is flagged as the chase it is rather than dressed up as a fresh signal.
  const context = [
    a.minutesSinceExtreme !== null
      ? a.minutesSinceExtreme < 3
        ? `still making new ${a.direction === 1 ? 'highs' : 'lows'}`
        : `${a.minutesSinceExtreme.toFixed(0)}m since the last extreme`
      : null,
    a.atrUsed !== null ? `${a.atrUsed.toFixed(2)} ATR of range used` : null,
  ].filter(Boolean).join(' · ');
  if (context)
    out.push(
      a.minutesSinceExtreme !== null && a.minutesSinceExtreme < 3
        ? `    ⚠️ ${m.italic(`${context} — this is the chase. The entry is the dip into it.`)}`
        : `    ${m.italic(context)}`,
    );

  if (a.conviction.partial)
    out.push(`    ⚠️ ${m.italic('Partial session record — this process did not watch the whole day.')}`);

  return out;
}

/** What one lot loses if the stop is reached, first-order in delta. */
function riskPerLot(a: TrendDayAlert): number | null {
  const s = a.strike;
  if (!s || !a.plan || s.lotSize === null) return null;
  const move = Math.abs(a.plan.entry - a.plan.stop);
  const premiumAtStop = Math.max(0, s.entryCost - Math.abs(s.delta) * move);
  return Math.round((s.entryCost - premiumAtStop) * s.lotSize);
}

/**
 * The whole batch, in one channel's markup — as one message where it fits, and as up to
 * `MAX_MESSAGES` where it does not.
 *
 * The first version of this trimmed to a single message and named whatever fell off the end. That
 * is the right instinct at the wrong price: the names it kept were the strongest by conviction,
 * but the ones it dropped lost their entry, stop, target, contract, lot and cost — the entire
 * content of the alert — and a reader who then went to the board had to rebuild all of it by
 * hand at the busiest moment of the session. Splitting spends one extra notification to keep
 * every confirmation whole, and the cap is what stops a pathological morning becoming a wall.
 */
export function buildMessages(alerts: TrendDayAlert[], m: Markup, nowMs: number): string[] {
  if (!alerts.length) return [];

  const one = alerts.length === 1;
  const stamp = m.italic(`${istClock(nowMs)} IST · conviction is confirmed, held and one-sided`);
  const foot = m.italic('Stops and targets are on the underlying. Nothing here is advice.');

  // Blocks are rendered once and measured once. `block` is not free — it formats a dozen numbers
  // per row — and the packing below would otherwise call it three times for every alert.
  const blocks = alerts.map((a) => (one ? block(a, m).slice(1) : block(a, m)).join('\n'));

  const head = (part: number, parts: number): string => {
    const title = one
      ? `${arrow(alerts[0].direction)} ${m.bold(`${m.escape(alerts[0].symbol)} — ${word(alerts[0].direction)} TREND DAY CONFIRMED`)}`
      : `🔔 ${m.bold(`${alerts.length} TREND DAYS CONFIRMED`)}`;
    return parts > 1 ? `${title} ${m.italic(`(${part}/${parts})`)}` : title;
  };

  // Pack greedily, in conviction order, against a budget that already accounts for the header,
  // the timestamp and the footer this message will carry.
  const pages: number[][] = [];
  let page: number[] = [];
  let size = 0;
  const overhead = head(1, MAX_MESSAGES).length + stamp.length + foot.length + 8;

  for (let i = 0; i < blocks.length; i++) {
    const chunk = blocks[i].length + 2;
    // A block that cannot fit an empty page would loop forever; it goes on its own page and is
    // left to the wire limit, which no single row has ever come close to.
    if (page.length && size + chunk > MAX_MESSAGE_CHARS - overhead) {
      pages.push(page);
      if (pages.length === MAX_MESSAGES) {
        page = [];
        break;
      }
      page = [];
      size = 0;
    }
    page.push(i);
    size += chunk;
  }
  if (page.length) pages.push(page);

  // Anything past the last page is still named. Reaching this means more than three messages'
  // worth confirmed in one tick, which has not happened on a real board — but silence about it
  // would be the same failure the trimming had.
  const shown = pages.flat().length;
  const dropped = alerts.slice(shown);

  return pages.map((idx, p) => {
    const last = p === pages.length - 1;
    return [
      head(p + 1, pages.length),
      stamp,
      '',
      ...idx.flatMap((i) => [blocks[i], '']),
      ...(last && dropped.length
        ? [m.italic(`+ ${dropped.length} more: ${dropped.map((d) => m.escape(d.symbol)).join(', ')} — on the Trend Day board.`)]
        : []),
      ...(last ? [foot] : []),
    ].join('\n');
  });
}

/**
 * The batch as a single message.
 *
 * Kept because a caller that can only send one string — and the tests, which assert on one — is
 * better served by the first page than by joining pages that were split to fit a wire limit.
 */
export const buildMessage = (alerts: TrendDayAlert[], m: Markup, nowMs: number): string =>
  buildMessages(alerts, m, nowMs)[0] ?? '';

/* ---------------------------------------------------------------------- the preview --- */

/**
 * A sample batch, for `GET /momentum/alerts/test`.
 *
 * Built from the REAL board — the highest-conviction rows on it, whatever phase they are in — so
 * the test proves the whole path rather than a hard-coded string: the channel, the markup, the
 * chain fetch and the strike selection all run exactly as they will at 10:30.
 *
 * The one thing it cannot reproduce out of hours is the plan. Entry, stop and target come off the
 * pulse's ATR, and the pulse is dark until the quote ring refills after the open — so an evening
 * preview shows real stocks with real conviction and no levels, and says so rather than inventing
 * them. If nothing on the board carries a conviction reading at all, the fallback below is used
 * instead, and it is deliberately named `SAMPLE`: a fabricated stop against a REAL symbol is a
 * number somebody could act on, and that is the one thing a preview must never produce.
 */
export async function previewAlerts(
  rows: MomentumRow[],
  cfg: MomentumConfig,
  nowMs: number,
  count = 1,
  /**
   * Skip the board and send the illustrative layout instead.
   *
   * Exists because the live preview is honestly incomplete out of hours — entry, stop and target
   * come off the pulse's ATR, which is dark until the quote ring refills after the open, so an
   * evening test shows real stocks with no levels and no contract. That proves the channel but not
   * the format, and the format is the half most worth checking before 10:30 arrives.
   */
  demo = false,
): Promise<{ alerts: TrendDayAlert[]; basis: string }> {
  if (demo) {
    const n = Math.max(1, Math.min(count, 8));
    return {
      // Varied per entry rather than the same block repeated. Three identical SAMPLEs prove the
      // heading and the stacking and nothing about how a batch READS — which is the whole reason
      // to preview a batch: whether eight of these are scannable or a wall.
      alerts: Array.from({ length: n }, (_, i) => illustrative(nowMs, i)),
      basis: `the illustrative layout, ${n} row${n === 1 ? '' : 's'} — invented numbers on symbols named SAMPLE, so nothing here is tradable`,
    };
  }

  const candidates = rows
    .filter((r) => r.conviction?.ready && r.conviction.direction !== 'Neutral')
    .sort((a, b) => (b.conviction?.score ?? 0) - (a.conviction?.score ?? 0))
    .slice(0, Math.max(1, Math.min(count, 8)));

  if (!candidates.length) return { alerts: [illustrative(nowMs)], basis: 'an illustrative example — the board carried no conviction reading' };

  // The SAME plans the live alert would use — see `latestTrendPlans`. Reading `row.signal.plan`
  // instead is what made the first version of this preview claim "no price plan" for stocks the
  // live path prices without trouble: `buildSignal` bails early with a null plan whenever the pulse
  // ring is not ready, and `buildTrendDayPlan` deliberately does not go through that gate.
  const plans = latestTrendPlans();

  const alerts: TrendDayAlert[] = candidates.map((r) => {
    const built = plans.get(r.symbol);
    return {
      symbol: r.symbol,
      direction: r.conviction!.direction === 'Bullish' ? 1 : -1,
      price: r.price,
      changePct: r.changePct,
      conviction: r.conviction as ConvictionSummary,
      plan: built?.plan ?? r.signal?.plan ?? null,
      strike: built?.strike ?? r.signal?.strike ?? null,
      minutesSinceExtreme: r.signal?.pulse?.minutesSinceExtreme ?? null,
      atrUsed: r.signal?.extension?.atrUsed ?? null,
      lotSize: built?.strike?.lotSize ?? r.signal?.strike?.lotSize ?? null,
    };
  });

  await priceContracts(alerts, cfg, nowMs);

  const withPlan = alerts.filter((a) => a.plan).length;
  const withStrike = alerts.filter((a) => a.strike).length;
  return {
    alerts,
    basis:
      `${alerts.length} live row${alerts.length === 1 ? '' : 's'} from the board ` +
      `(${candidates.map((r) => `${r.symbol} ${r.conviction!.phase.toLowerCase()} ${r.conviction!.score.toFixed(0)}`).join(', ')}) — ` +
      `${withPlan} with a price plan, ${withStrike} with a contract, ` +
      // The count is the diagnostic that separates "this stock cannot be priced" from "the scan
      // that filled this map never ran". Zero here with confirmed rows on the board means the
      // latter, and the two look identical on the phone.
      `${plans.size} trend plan${plans.size === 1 ? '' : 's'} held from the last scan`,
  };
}

/**
 * The variations a demo batch cycles through.
 *
 * Deliberately not eight clones. What a batch preview is FOR is judging whether a stampede of
 * confirmations is scannable on a phone, and that depends on the rows differing: two directions
 * mixed together, a four-digit price beside a three-digit one, a row with no contract, a row
 * carrying a liquidity warning, a row still making new extremes. Each of those renders a different
 * branch of `block()`, so a demo of eight exercises nearly the whole message.
 *
 * Every symbol is a `SAMPLE`, and that is not cosmetic: a fabricated stop against a REAL ticker is
 * a number somebody could act on, which is the one thing a preview must never produce.
 */
const DEMO_ROWS: ReadonlyArray<{
  suffix: string; dir: 1 | -1; price: number; chg: number; conv: number; held: number;
  adherence: number; crossings: number; dip: number; stopPct: number; targetPct: number;
  premium: number; lot: number; delta: number; iv: number; gain: number;
  mse: number; used: number; noChain?: boolean; warn?: string;
}> = [
  { suffix: '', dir: -1, price: 1432.5, chg: -2.84, conv: 73, held: 22, adherence: 0.96, crossings: 2, dip: 0.31, stopPct: 1.31, targetPct: 2.62, premium: 28.4, lot: 750, delta: -0.42, iv: 31, gain: 46, mse: 8, used: 1.42 },
  { suffix: '-B', dir: 1, price: 2412, chg: 1.82, conv: 71, held: 19, adherence: 0.91, crossings: 4, dip: 0.44, stopPct: 1.22, targetPct: 2.45, premium: 41.9, lot: 250, delta: 0.46, iv: 27, gain: 39, mse: 22, used: 0.98 },
  { suffix: '-C', dir: -1, price: 1084.2, chg: -3.34, conv: 69, held: 31, adherence: 0.94, crossings: 3, dip: 0.28, stopPct: 1.33, targetPct: 2.69, premium: 19.6, lot: 550, delta: -0.48, iv: 34, gain: 57, mse: 1, used: 1.61, warn: 'open interest is thin at this strike' },
  { suffix: '-D', dir: 1, price: 316.75, chg: 2.41, conv: 68, held: 26, adherence: 0.89, crossings: 5, dip: 0.39, stopPct: 1.44, targetPct: 2.88, premium: 6.85, lot: 3000, delta: 0.44, iv: 38, gain: 52, mse: 11, used: 1.15 },
  { suffix: '-E', dir: -1, price: 5010, chg: -1.96, conv: 67, held: 44, adherence: 0.93, crossings: 1, dip: 0.22, stopPct: 1.18, targetPct: 2.36, premium: 0, lot: 0, delta: 0, iv: 0, gain: 0, mse: 35, used: 1.28, noChain: true },
  { suffix: '-F', dir: 1, price: 9289, chg: 1.34, conv: 66, held: 17, adherence: 0.87, crossings: 6, dip: 0.47, stopPct: 1.09, targetPct: 2.18, premium: 118.5, lot: 75, delta: 0.41, iv: 24, gain: 33, mse: 2, used: 1.71 },
  { suffix: '-G', dir: -1, price: 275.8, chg: -2.18, conv: 66, held: 38, adherence: 0.92, crossings: 2, dip: 0.34, stopPct: 1.51, targetPct: 3.02, premium: 5.4, lot: 4000, delta: -0.45, iv: 41, gain: 61, mse: 16, used: 1.06 },
  { suffix: '-H', dir: 1, price: 2668, chg: 1.07, conv: 65, held: 21, adherence: 0.88, crossings: 4, dip: 0.42, stopPct: 1.27, targetPct: 2.54, premium: 52.3, lot: 200, delta: 0.43, iv: 29, gain: 41, mse: 27, used: 0.91 },
];

/** One illustrative row. `i` selects a variation so a batch does not repeat itself. */
function illustrative(nowMs: number, i = 0): TrendDayAlert {
  const d = DEMO_ROWS[i % DEMO_ROWS.length];
  const dirWord = d.dir === 1 ? 'Bullish' : 'Bearish';
  const stop = +(d.price * (1 - (d.dir * d.stopPct) / 100)).toFixed(2);
  const target = +(d.price * (1 + (d.dir * d.targetPct) / 100)).toFixed(2);
  const strikeAt = Math.round(d.price / 20) * 20;

  return {
    symbol: `SAMPLE${d.suffix}`,
    direction: d.dir,
    price: d.price,
    changePct: d.chg,
    conviction: {
      ready: true, score: d.conv, phase: 'Confirmed', direction: dirWord, heldMin: d.held,
      confirmedAt: nowMs, convictionAtConfirm: d.conv, peak: d.conv + 2,
      vwapAdherence: d.adherence, vwapCrossings: d.crossings,
      sessionEfficiency: 0.51, rangePosition: 0.92, deepestPullbackAtr: d.dip,
      partial: false, summary: `Confirmed ${dirWord.toLowerCase()} trend day`,
    } as ConvictionSummary,
    plan: {
      entry: d.price, stop, target,
      stopPct: d.stopPct, targetPct: d.targetPct,
      rewardRisk: +(d.targetPct / d.stopPct).toFixed(2),
      optionMovePctAtTarget: d.gain, underlyingMovePctForTargetOption: d.targetPct,
      meetsOptionTarget: true, basis: d.noChain ? 'atr-only' : 'strike',
    } as SignalPlan,
    strike: d.noChain
      ? null
      : ({
          strike: strikeAt, type: d.dir === 1 ? 'CE' : 'PE',
          label: `${strikeAt} ${d.dir === 1 ? 'CE' : 'PE'}`, instrumentKey: 'SAMPLE',
          expiry: '2026-08-27', expiryDays: 15, stepsFromAtm: 0, moneyness: 'ATM',
          premium: d.premium, entryCost: d.premium, bid: +(d.premium * 0.99).toFixed(2),
          ask: d.premium, spreadPct: 1.1, delta: d.delta, gamma: 0.004, iv: d.iv,
          thetaPctPerHour: 1.2, oi: 120_000, volume: 40_000, lotSize: d.lot,
          costPerLot: Math.round(d.premium * d.lot),
          premiumAtTarget: +(d.premium * (1 + d.gain / 100)).toFixed(2),
          gainPctAtTarget: d.gain,
          profitPerLot: Math.round(d.premium * (d.gain / 100) * d.lot),
          breakEven: +(strikeAt + d.dir * d.premium).toFixed(2),
          reason: 'illustrative', warnings: d.warn ? [d.warn] : [],
        } as StrikeChoice),
    minutesSinceExtreme: d.mse,
    atrUsed: d.used,
    lotSize: d.noChain ? null : d.lot,
  };
}

/* ------------------------------------------------------------------------ the drive --- */

let lastSentAt: number | null = null;
let lastCount = 0;
let lastError: string | null = null;
let announcedToday = 0;
/**
 * Confirmations this process declined to announce because they could not be priced.
 *
 * A separate counter from `lastError` because these are not errors in the delivery sense — the
 * channel is fine, the message would simply have been useless — and because a send that succeeds
 * clears `lastError`, which would hide exactly the condition worth seeing. `announcedToday: 0`
 * beside `withheldToday: 17` is the whole diagnosis in two numbers.
 */
let withheldToday = 0;
let lastWithheld: string | null = null;

/**
 * Called once per scan with the finished board. Never throws — an alert channel must not be able
 * to fail the scan that produced it.
 *
 * Returns what was announced, for the tests and the tools.
 */
export async function onScan(
  rows: MomentumRow[],
  /**
   * The trend-mode plan per symbol, built by the engine from the same inputs the row's own signal
   * came from. See the note at its call site: the row's `signal.plan` is only in trend mode when
   * the state machine happens to be `Trending`, and a stock is usually `Quiet` at the moment its
   * conviction is confirmed.
   */
  trendPlans: Map<string, TrendDayPlan>,
  cfg: MomentumConfig,
  nowMs: number,
  /**
   * Whether the scan had an ATR baseline at all.
   *
   * The alert cannot be built without one — every level in the message is a multiple of ATR — and
   * the scan runs on its own fifteen-second timer while the baseline is still building, so this
   * window is reached on every boot and after every restart. It used to announce straight through
   * it. See `suppressionNotice`.
   */
  baselineReady: boolean,
): Promise<TrendDayAlert[]> {
  if (!enabled()) return [];

  try {
    const day = istDay(nowMs);
    const state = await load(day);
    const announced = new Set(state.announced);

    // NO BASELINE, NO ALERT. Sending anyway is what produced the 2026-08-13 batch: seventeen
    // confirmations with no stop, no target, no contract and no lot, each of them recorded as
    // announced and therefore unrepeatable for the rest of the day. Withholding costs nothing —
    // a confirmation that is real is still Confirmed when the baseline lands, and the freshness
    // window is ten minutes — while sending costs the whole day's alerts on that symbol.
    if (!baselineReady) {
      await noticeOnce(state, nowMs);
      return [];
    }

    // Whatever displacement has already bought this morning is not available to be bought again.
    // Read every scan rather than cached: displacement's window overlaps the early part of this
    // one, so the set can still grow between two ticks of this channel.
    const fresh = newlyConfirmed(
      rows, announced, nowMs, minConviction(), await displacementTaken(day),
    );
    if (!fresh.length) return [];

    const alerts: TrendDayAlert[] = fresh
      .map((r) => {
        const dir: 1 | -1 = r.conviction!.direction === 'Bullish' ? 1 : -1;
        const built = trendPlans.get(r.symbol);
        return {
          symbol: r.symbol,
          direction: dir,
          price: r.price,
          changePct: r.changePct,
          conviction: r.conviction as ConvictionSummary,
          // Trend-mode plan first — the VWAP stop is the one this signal is actually defended at.
          // The row's own plan is the fallback for the rare case where the trend build could not
          // produce one (no ATR baseline), which is also the case where it names no contract.
          plan: built?.plan ?? r.signal?.plan ?? null,
          strike: built?.strike ?? r.signal?.strike ?? null,
          minutesSinceExtreme: r.signal?.pulse?.minutesSinceExtreme ?? null,
          atrUsed: r.signal?.extension?.atrUsed ?? null,
          // The lot comes off the futures contract and is the same for that underlying's options,
          // so it is available even when the chain is not — which is what lets a contract be
          // priced for a row the shortlist skipped.
          lotSize: built?.strike?.lotSize ?? r.signal?.strike?.lotSize ?? null,
        };
      })
      // Strongest first, so a split batch fills its first message with the ones worth reading.
      .sort((a, b) => b.conviction.score - a.conviction.score);

    // A LAST GATE, on the one thing the message cannot do without.
    //
    // `baselineReady` above catches the whole baseline being absent; this catches the individual
    // symbol the build could not cover, which is the same hole one stock wide and produces the
    // identical unusable alert. The test is deliberately "no plan AND no ATR" rather than "no
    // plan": a confirmed day that has stopped making new extremes also has no plan, and that one
    // is the model declining to size a target rather than a gap in the data. It has real levels
    // behind it, the message says so in its own words, and it is worth sending.
    const usable = alerts.filter((a) => a.plan !== null || a.atrUsed !== null);
    const withheld = alerts.filter((a) => !usable.includes(a));
    // Reported on its own field rather than through `lastError`. A tick that withholds two rows
    // and sends five would otherwise record the withholding and then have `deliver` clear it on
    // a successful send, which is the same silence this whole change is about.
    if (withheld.length) {
      withheldToday += withheld.length;
      lastWithheld = `no ATR for ${withheld.map((a) => a.symbol).join(', ')} — POST /momentum/baseline/rebuild`;
    }
    if (!usable.length) return [];

    // Recorded BEFORE the send, exactly as the session bells do it: a channel slower than the
    // scan interval would otherwise be handed the same batch again on the next tick, and a
    // duplicate stampede is a worse failure than one batch lost to a channel that was down.
    //
    // Only what is actually being sent is recorded. A withheld symbol stays unannounced, so the
    // next tick that finds it still confirmed — and by then priced — announces it properly. The
    // old code recorded the whole batch before filtering anything, which is why a symbol that
    // went out blank at 10:30 could never go out again with levels at 10:31.
    state.announced = [...announced, ...usable.map((a) => key(a.symbol, a.direction))];
    await store.write(STORE_KEYS.trendAlerts, state);
    announcedToday = state.announced.length;

    await priceContracts(usable, cfg, nowMs);
    await deliver(usable, nowMs);
    await recordEntries('trend-day', usable.map((a) => ({
      symbol: a.symbol,
      direction: a.direction,
      spot: a.price,
      minute: minuteOfSession(nowMs),
      lotSize: a.lotSize,
      strike: a.strike,
      readings: {
        conviction: a.conviction?.score ?? null,
        changePct: a.changePct,
        atrUsed: a.atrUsed,
        minutesSinceExtreme: a.minutesSinceExtreme,
      },
    })), nowMs);
    return usable;
  } catch (e) {
    lastError = String((e as Error).message);
    return [];
  }
}

/**
 * Tell the phone, once, that alerts are being withheld.
 *
 * The failure this exists for was silent for a whole session: the board carried its warning, the
 * status endpoint carried it, and the only thing anybody looks at during market hours — the
 * phone — carried alerts that appeared to be working. One message a day is the smallest thing
 * that closes that gap, and the persisted flag is what keeps a fifteen-second scan from turning
 * it into two hundred and forty.
 */
async function noticeOnce(state: AlertState, nowMs: number): Promise<void> {
  if (state.suppressionNotice) return;
  state.suppressionNotice = true;
  await store.write(STORE_KEYS.trendAlerts, state);

  const text = (m: Markup): string =>
    [
      `⚠️ ${m.bold('TREND DAY ALERTS SUPPRESSED')}`,
      m.italic(`${istClock(nowMs)} IST`),
      '',
      m.escape(
        `There is no ATR baseline for ${state.day}, so no stop, target, contract or lot can be sized. ` +
          'Confirmations are being withheld rather than sent without levels.',
      ),
      '',
      m.escape('POST /momentum/baseline/rebuild — then alerts resume on their own.'),
      '',
      m.italic('Sent once a day.'),
    ].join('\n');

  const jobs: Promise<boolean>[] = [];
  if (telegramConfigured()) jobs.push(sendTelegram(text(HTML)));
  if (discordConfigured()) jobs.push(sendDiscord(text(MARKDOWN)));
  await Promise.all(jobs);
  lastError = `no ATR baseline for ${state.day} — trend-day alerts are suppressed`;
}

async function deliver(alerts: TrendDayAlert[], nowMs: number): Promise<void> {
  if (!telegramConfigured() && !discordConfigured()) {
    lastError = 'no phone channel is configured';
    return;
  }

  // Pages go out IN ORDER within a channel and the two channels go in parallel. Sequential
  // within a channel because "(2/3)" arriving before "(1/3)" is a worse read than a second's
  // extra latency, and parallel across them because the whole point of having two is that
  // neither waits on the other's outage.
  const send = async (pages: string[], one: (text: string) => Promise<boolean>): Promise<boolean> => {
    let ok = true;
    for (const page of pages) ok = (await one(page)) && ok;
    return ok;
  };

  const jobs: Promise<boolean>[] = [];
  if (telegramConfigured()) jobs.push(send(buildMessages(alerts, HTML, nowMs), sendTelegram));
  if (discordConfigured())
    jobs.push(send(buildMessages(alerts, MARKDOWN, nowMs), (t) => sendDiscord(t, alerts[0].direction)));

  const results = await Promise.all(jobs);
  lastError = results.every(Boolean) ? null : 'a configured channel refused the message';
  lastSentAt = nowMs;
  lastCount = alerts.length;
}

/** Reported on `/momentum/status`. */
export const trendAlertStatus = () => ({
  enabled: enabled(),
  minConviction: minConviction(),
  maxConfirmAgeMin: MAX_CONFIRM_AGE_MS / 60_000,
  announcedToday,
  lastSentAt,
  lastCount,
  lastError,
  // Non-zero here means the baseline has a hole in it and confirmations are being held back
  // rather than sent blank. It is the field to watch on a morning that feels too quiet.
  withheldToday,
  lastWithheld,
});

/** Test seam. */
export const resetTrendAlerts = async (): Promise<void> => {
  lastSentAt = null;
  lastCount = 0;
  lastError = null;
  announcedToday = 0;
  withheldToday = 0;
  lastWithheld = null;
  await store.write(STORE_KEYS.trendAlerts, { ...EMPTY });
};

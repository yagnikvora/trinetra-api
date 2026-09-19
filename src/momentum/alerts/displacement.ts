// The First-Hour Displacement signal — the third alert channel, and the only one that fires
// before the first half hour is out.
//
// WHY IT EXISTS, given there are already two.
//
// `trend-day.ts` cannot speak before 10:30: `minMinutesConfirmed` is 75, so the conviction layer
// is not allowed to confirm a day until the second hour, and in practice a great many stocks
// confirm at exactly minute 75 because that is the first legal minute. `ignition.ts` fires early
// but off `entryQuality`, and measured over 2,886 stock-days that number is anti-predictive at
// its top end — 60% of its weight is freshness plus pulse, and both peak at the exhaustion tick
// of a thrust.
//
// This channel is keyed off neither. It asks one question at 09:27 — has this stock already done
// a full normal day's range on extreme volume, and is it still at the front of that move — and
// then says nothing for the rest of the session.
//
// WHAT THE EVIDENCE ACTUALLY SAYS, because the numbers below are the whole justification and the
// caveats travel with them. Measured over 35 sessions of the full F&O universe, 3 Jul to 20 Aug
// 2026, on cached 1-minute bars (`research/` in this repo):
//
//   98 signals, 2.8 a day. 60% of trades ended profitable, 43% reached the first target,
//   10% ran to the second, 9% hit the hard stop. Average +4.9% of premium per trade.
//
//   THE CONTROL IS THE IMPORTANT NUMBER. Buying the at-the-money monthly option on every liquid
//   F&O name at 09:46 and holding to the close returns −7.4% (t = −27, n = 5,220). Half spread,
//   half decay. So a signal is only worth having when it beats −7.4%, not when it beats zero,
//   and +4.9% is about twelve points of edge rather than five.
//
//   IT IS NOT STATISTICALLY PROVEN. t = 1.57 on 98 trades. Consistent with a real edge and also
//   consistent with luck. The profitable RATE is the stable half — 61% on the 19 sessions the
//   rule was never fitted on, 59% on the 14 it was — while the average return is not: +8.6%
//   against +1.2% across those same halves.
//
//   IT HAS 0-FOR-4 DAYS. 16 Jul and 14 Aug each produced four signals and lost on all four, and
//   the morning readings on those days were indistinguishable from 23 Jul, which went four for
//   four. Four signals a day means four correlated positions on one kind of morning; that is the
//   risk this channel carries and no filter in it addresses.
//
// FIDELITY TO THE RESEARCH, where live and replay could not be identical:
//
//   ARRIVAL ORDER. The study ranked each session's qualifying names by relative volume and took
//   the top four. A live scan cannot know the morning's top four in advance — it fires in the
//   order conditions are met. Checked rather than assumed: the two selections pick the same set
//   on 77% of sessions, and arrival order scored slightly BETTER over the 35 (+5.1% against
//   +4.6%), so nothing is being given up. The cap binds on only 26% of days anyway.
//
//   TURNOVER. The study used the median daily traded value over the prior 20 sessions; the live
//   baseline publishes `avgDailyValueCr`, a mean. A mean runs above a median on a series with
//   spike days, so this gate is marginally looser live than in the study. It is a liquidity gate
//   rather than a performance one — the edge dies at 6% spreads — so looser is the wrong
//   direction and `DISPLACEMENT_MIN_TURNOVER_CR` is the knob if it wants raising.
//
// The knobs are environment variables rather than momentum config, matching the two channels
// beside it. That is deliberate: `PUT /momentum/config` is served over HTTP, and an alert that
// spends real money should not be retunable by anything that can reach the API.

import { istDay, minuteOfSession } from '../session.js';
import { store, STORE_KEYS } from '../store.js';
import { stockChain } from '../data/option-chain.js';
import { universe } from '../data/universe.js';
import { selectStrike } from '../services/strike.service.js';
import type { MomentumConfig, StrikeChoice } from '../types.js';
import type { MomentumQuote } from '../data/quotes.js';
import { recordEntries } from '../journal/journal.js';
import { flushCandidates, markTaken, observeCandidates } from './candidates.js';
import { HTML, istClock, MARKDOWN, type Markup } from '../../alerts/markup.js';
import { discordConfigured, sendDiscord } from '../../alerts/discord.js';
import { sendTelegram, telegramConfigured } from '../../alerts/telegram.js';

/* ------------------------------------------------------------------------ the gate --- */

const enabled = (): boolean => (process.env.DISPLACEMENT_ALERTS ?? '').trim().toLowerCase() === 'on';

const num = (name: string, fallback: number, lo: number, hi: number): number => {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= lo && raw <= hi ? raw : fallback;
};

/**
 * The rule, as numbers.
 *
 * Every default is the value the 35-session study settled on, and each one was tested with a
 * neighbourhood around it rather than as a lone point — RVOL 4 through 8 and range 0.8 through
 * 1.2 were all positive, so none of these is a spike that happens to fit.
 */
export const rule = () => ({
  /** Median daily traded value. The option has to be quotable; the edge dies at 6% spreads. */
  minTurnoverCr: num('DISPLACEMENT_MIN_TURNOVER_CR', 100, 0, 100_000),
  /** Volume so far against this stock's own normal for this minute. */
  minRvol: num('DISPLACEMENT_MIN_RVOL', 5, 1, 1000),
  /** Above this is a corporate action or a data artefact, not a trade. POLICYBZR printed 238x. */
  maxRvol: num('DISPLACEMENT_MAX_RVOL', 50, 1, 100_000),
  /** Intraday high minus low, in ATR. The condition doing the most work: it selects news days. */
  minRangeAtr: num('DISPLACEMENT_MIN_RANGE_ATR', 1.0, 0, 10),
  /** Distance from the open in the trade's direction. A wide range going nowhere is a fight. */
  minMoveAtr: num('DISPLACEMENT_MIN_MOVE_ATR', 0.5, 0, 10),
  /** How far back off the day's extreme price may be. Small on purpose — see the note below. */
  maxOffExtremeAtr: num('DISPLACEMENT_MAX_OFF_EXTREME_ATR', 0.35, 0, 10),
  /** 09:27. Twelve minutes is the least that makes a range and a volume reading meaningful. */
  fromMinute: num('DISPLACEMENT_FROM_MIN', 12, 1, 375),
  /** 10:00. Past this the base rate of a 1 ATR move falls away — 8.6% against 14.2% at 09:25. */
  toMinute: num('DISPLACEMENT_TO_MIN', 45, 1, 375),
  maxPerDay: num('DISPLACEMENT_MAX_PER_DAY', 4, 1, 50),
});

/**
 * Whether to fire on a symbol whose baseline was carried forward from an earlier day.
 *
 * Off by default, and the default is the whole point — see `baselineCarriedFrom`. Turn it on only
 * to see what a stale-baseline morning WOULD have produced, never to get more signals.
 */
const allowCarried = (): boolean =>
  (process.env.DISPLACEMENT_ALLOW_CARRIED_BASELINE ?? '').trim().toLowerCase() === 'on';

/**
 * Take-profit, checkpoint and stop, as multiples of what the contract cost.
 *
 * THE CHECKPOINT REPLACED A SCALE-OUT (2026-08-30). This message used to say "sell half at +30%,
 * stop to breakeven, rest to +80%". Graded on all 78 journalled trades against their own contracts'
 * minute candles, that instruction is the worst of the shapes tested — ₹45,310 against ₹59,166 for
 * simply holding to +80/−50, because booking half caps the rare full winners that carry the book
 * and pays a second lot of charges for the privilege.
 *
 * What replaced it: hold the whole position, and once it has been up `armAt`, move the stop once to
 * `lock` and leave it there. That netted ₹79,147 on the same 78 trades.
 *
 * AND THAT WAS SWITCHED OFF TOO (2026-09-19). On all 194 trades from 1 Jul to 18 Sep the checkpoint
 * nets ₹1,52,977 against ₹1,70,226 for plain +80/−50, so the message now says only: sell all at
 * +80% or 15:15, hard stop −50%. `armAt` defaults to 0 here and in `journalConfig`, and the two
 * must stay equal, or the journal grades a rule the alert never told anyone to follow.
 */
export const exits = () => ({
  second: num('DISPLACEMENT_TP2_PCT', 80, 1, 1000) / 100,
  stop: num('DISPLACEMENT_SL_PCT', 50, 1, 99) / 100,
  /** Once up this much, the stop moves once — to `lock` — and never moves again. 0 switches it off. */
  armAt: num('DISPLACEMENT_ARM_AT_PCT', 0, 0, 1000) / 100,
  /**
   * Where the stop parks once armed. Comfortably above cost, so a checkpoint exit is a small win
   * rather than a scratch. See `journalConfig` for the grading behind the number and for why this
   * one is fitted to 78 trades where `armAt` is a genuine plateau.
   */
  lock: num('DISPLACEMENT_LOCK_PCT', 6, -99, 1000) / 100,
});

/* --------------------------------------------------------------------- the readings --- */

/**
 * One symbol's live state, assembled by the caller.
 *
 * Deliberately not `MomentumRow`: the row carries neither the session open nor the day's
 * extremes, and widening the public row type to decorate one alert would be a change to the
 * board's API for the sake of this file. The engine builds these from the same stage-one
 * objects the board is built from, so the two cannot disagree about a price.
 */
export interface DisplacementInput {
  symbol: string;
  equityKey: string;
  quote: MomentumQuote;
  /** Wilder ATR in rupees, from the pre-open baseline. Null disqualifies the symbol. */
  atr: number | null;
  /** Mean daily traded value, ₹ crore, from the baseline. */
  avgDailyValueCr: number | null;
  /** Cumulative volume against the minute-of-session profile. Null disqualifies. */
  rvol: number | null;
  lotSize: number | null;
  /**
   * Set when this symbol's baseline reading was carried over from an earlier day because the
   * morning build could not reach it. See `SymbolBaseline.carriedFrom`.
   *
   * It matters more here than anywhere else in the module. Every gate in this rule is a multiple
   * of ATR, so a carried ATR silently moves all four thresholds at once — and it is not a small
   * effect: measured against the baseline on disk for 2026-08-20, symbols built that morning
   * agreed with an independently computed ATR to a median 0.6%, while carried symbols were out by
   * a median 4.3% and 86% of them by more than 2%. That was enough to delete a real signal.
   *
   * 128 of 208 symbols were carried on that date, so this is the common case rather than the edge
   * one, and firing on a stale ATR is the wrong trade to make: fewer signals beats signals whose
   * levels are scaled by the wrong number.
   */
  baselineCarriedFrom?: string | null;
}

export interface DisplacementCandidate {
  symbol: string;
  equityKey: string;
  direction: 1 | -1;
  entry: number;
  atr: number;
  rvol: number;
  rangeAtr: number;
  moveAtr: number;
  offExtremeAtr: number;
  vwap: number;
  open: number;
  prevClose: number;
  changePct: number;
  dayHigh: number;
  dayLow: number;
  turnoverCr: number;
  lotSize: number | null;
  /** Minute of session the conditions were first met. */
  minute: number;
}

/**
 * Which symbols qualify, right now — pure, so the live channel and any replay of it cannot
 * drift apart. Nothing here reads a clock beyond the `minute` handed in.
 */
export function selectDisplacement(
  inputs: DisplacementInput[],
  announced: Set<string>,
  minute: number,
  r: ReturnType<typeof rule>,
): DisplacementCandidate[] {
  if (minute < r.fromMinute || minute > r.toMinute) return [];

  const out: DisplacementCandidate[] = [];
  for (const i of inputs) {
    const { quote: q, atr, rvol } = i;
    if (atr === null || !(atr > 0) || rvol === null) continue;
    if (i.baselineCarriedFrom && !allowCarried()) continue;
    if (!(q.ltp > 0) || !(q.vwap > 0) || !(q.open > 0)) continue;
    if ((i.avgDailyValueCr ?? 0) < r.minTurnoverCr) continue;
    if (rvol < r.minRvol || rvol > r.maxRvol) continue;

    // Direction is the side of VWAP, which is what the study used. Not the day's change: a
    // stock can be red on the day and trading above the average price paid for it all morning,
    // and it is the second fact that says which way the session is going.
    const direction: 1 | -1 = q.ltp > q.vwap ? 1 : -1;

    if ((q.high - q.low) / atr < r.minRangeAtr) continue;
    if (((q.ltp - q.open) / atr) * direction < r.minMoveAtr) continue;

    // Still at the front of the move. Counter-intuitive, and it is what the data said: on these
    // specific days, waiting for a deep pullback did worse than taking them near the extreme,
    // because a dip that goes deep on a news day usually keeps going. It is also the condition
    // whose removal changed the out-of-sample result least, so it is the first one to drop if
    // a future sample disagrees.
    const off = (direction === 1 ? q.high - q.ltp : q.ltp - q.low) / atr;
    if (off > r.maxOffExtremeAtr) continue;

    if (announced.has(i.symbol)) continue;

    out.push({
      symbol: i.symbol,
      equityKey: i.equityKey,
      direction,
      entry: q.ltp,
      atr,
      rvol,
      rangeAtr: +((q.high - q.low) / atr).toFixed(2),
      moveAtr: +((((q.ltp - q.open) / atr) * direction)).toFixed(2),
      offExtremeAtr: +off.toFixed(2),
      vwap: q.vwap,
      open: q.open,
      prevClose: q.prevClose,
      changePct: q.changePct,
      dayHigh: q.high,
      dayLow: q.low,
      turnoverCr: q.turnoverCr,
      lotSize: i.lotSize,
      minute,
    });
  }

  // Strongest first within the tick, which is the only ranking a live scan can honestly apply.
  // Across sessions this is arrival order, and that was measured to be no worse than ranking a
  // whole session by relative volume — see the note at the top of this file.
  return out.sort((a, b) => b.rvol - a.rvol);
}

/* ----------------------------------------------------------------------- the state --- */

interface AlertState {
  day: string;
  /** Symbols announced today, in either direction. One alert per stock per day. */
  announced: string[];
}

const EMPTY: AlertState = { day: '', announced: [] };

async function load(day: string): Promise<AlertState> {
  const saved = await store.read<AlertState>(STORE_KEYS.displacementAlerts);
  return saved && saved.day === day ? { day, announced: saved.announced ?? [] } : { ...EMPTY, day };
}

/**
 * The symbols this channel has already spent the day on — read by the OTHER channels, so one
 * stock cannot be bought twice on one morning under two different names.
 *
 * Displacement is the one that gets to claim a symbol, because it is the one that fires first:
 * its window closes at 10:00 and a trend day cannot confirm before 10:30. By the time trend-day
 * looks, this answer is final for the day.
 *
 * Reads the announced set rather than the journal on purpose. That set is written BEFORE the
 * message is sent, so it is true even for an alert whose contract could not be resolved — which
 * still cost the alert and still named the stock.
 */
export async function displacementTaken(day: string): Promise<Set<string>> {
  return new Set((await load(day)).announced);
}

/* ---------------------------------------------------------------------- the message --- */

const inr = (v: number): string => `₹${Math.round(v).toLocaleString('en-IN')}`;
const px = (v: number): string =>
  `₹${v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pct = (v: number): string => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}%`;

/**
 * The approximate underlying price at which the contract is worth `mult` of its cost.
 *
 * First-order in delta and stated as approximate, because that is what it is: it ignores gamma,
 * decay over the hold and any change in implied volatility. It is here so a chart alert can be
 * set, not so the exit can be taken off it — the exit is the PREMIUM level on the line above,
 * which needs no model at all.
 */
function approxSpotFor(c: DisplacementCandidate, s: StrikeChoice, mult: number): number | null {
  const delta = Math.abs(s.delta);
  if (!(delta > 0.05) || !(s.entryCost > 0)) return null;
  return c.entry + c.direction * ((mult - 1) * s.entryCost) / delta;
}

export function buildMessage(
  c: DisplacementCandidate,
  strike: StrikeChoice | null,
  m: Markup,
  nowMs: number,
): string {
  const e = exits();
  const arrow = c.direction === 1 ? '🟢' : '🔴';
  const word = c.direction === 1 ? 'BULLISH' : 'BEARISH';

  const out: string[] = [
    `🚀 ${m.bold(`${m.escape(c.symbol)} — ${word} FIRST-HOUR DISPLACEMENT`)}`,
    m.italic(`${istClock(nowMs)} IST · minute ${c.minute} of the session`),
    '',
    `${arrow} ${m.bold(px(c.entry))}  ${pct(c.changePct)}  ·  ${m.bold(`RVOL ${c.rvol.toFixed(1)}×`)}`,
    `    ${m.bold(c.rangeAtr.toFixed(2))} ATR of range already made · ${m.bold(c.moveAtr.toFixed(2))} ATR from the open ${px(c.open)} · ${c.offExtremeAtr.toFixed(2)} ATR off the ${c.direction === 1 ? 'high' : 'low'} ${px(c.direction === 1 ? c.dayHigh : c.dayLow)}`,
    `    ${m.italic(`prev close ${px(c.prevClose)} · VWAP ${px(c.vwap)} · ATR ${px(c.atr)} (${((100 * c.atr) / c.entry).toFixed(2)}%) · ₹${c.turnoverCr.toFixed(0)}cr traded`)}`,
  ];

  if (strike) {
    const cost = strike.entryCost;
    out.push('');
    out.push(
      `    🎟 ${m.bold(`BUY ${m.escape(strike.label)}`)} ${m.italic(`(${m.escape(strike.expiry)}, ${strike.expiryDays}d)`)}` +
        ` — ${m.bold(px(cost))} × ${strike.lotSize ?? '?'} = ${m.bold(strike.costPerLot === null ? '—' : inr(strike.costPerLot))} per lot`,
    );
    // The exits are PREMIUM prices. No model, nothing to disagree with, and they are what the
    // order book will actually show — which is the whole reason they are stated this way.
    const spotArm = approxSpotFor(c, strike, 1 + e.armAt);
    const spot2 = approxSpotFor(c, strike, 1 + e.second);
    const spotS = approxSpotFor(c, strike, 1 - e.stop);
    if (e.armAt > 0) {
      // Assembled before it is styled, for the same reason line ③ is: `_a__b_` collapses into a
      // bold marker in Discord markdown and renders as `</i><i>` on Telegram.
      out.push(
        `       ① ${m.italic(
          `if it touches ${px(cost * (1 + e.armAt))} (+${(100 * e.armAt).toFixed(0)}%)`
          + (spotArm === null ? '' : ` — stock ≈ ${px(spotArm)}`),
        )}`,
      );
      out.push(
        `       ② ${m.bold(`MOVE STOP to ${px(cost * (1 + e.lock))}`)} ` +
          m.italic(`(${e.lock >= 0 ? '+' : ''}${(100 * e.lock).toFixed(0)}%) — then leave it there`),
      );
    }
    // One italic span, not two concatenated: `_a__b_` collapses into a bold marker in Discord
    // markdown and renders as `</i><i>` on Telegram, so the tail is assembled before it is styled.
    out.push(
      `       ${e.armAt > 0 ? '③' : '①'} ${m.bold(`SELL ALL at ${px(cost * (1 + e.second))}`)} (+${(100 * e.second).toFixed(0)}%)` +
        m.italic(`${spot2 === null ? '' : ` — stock ≈ ${px(spot2)}`}, or close by 15:15`),
    );
    out.push(
      `       🛑 ${m.bold(`STOP at ${px(cost * (1 - e.stop))}`)} (−${(100 * e.stop).toFixed(0)}%)` +
        (spotS === null ? '' : m.italic(` — stock ≈ ${px(spotS)}`)),
    );
    for (const w of strike.warnings.slice(0, 2)) out.push(`       ⚠️ ${m.escape(w)}`);
  } else {
    out.push('');
    out.push(
      `    ${m.italic(
        `No option chain this cycle — pick the at-the-money monthly yourself${c.lotSize ? `, lot is ${c.lotSize}` : ''}. ` +
        (e.armAt > 0
          ? `Then: hold it all, and once up +${(100 * e.armAt).toFixed(0)}% move the stop to ${e.lock >= 0 ? '+' : ''}${(100 * e.lock).toFixed(0)}% and leave it. `
          : 'Then: ') +
        `Sell all at +${(100 * e.second).toFixed(0)}% or 15:15, hard stop −${(100 * e.stop).toFixed(0)}%.`,
      )}`,
    );
  }

  // SAID EVERY TIME. This channel wins on about three trades in five and its losers are the
  // full stop, and a reader who forgets that will size the next one wrong.
  out.push('');
  out.push(
    m.italic(
      'Tested over 35 sessions: 60% of these end profitable, 9% hit the hard stop, average +4.9% of premium. ' +
      'Not statistically proven (t=1.57, n=98). Four of these can lose together on the same morning — size for the day, not the trade. Nothing here is advice.',
    ),
  );
  return out.join('\n');
}

/* ------------------------------------------------------------------------ the drive --- */

let lastSentAt: number | null = null;
let lastError: string | null = null;
let announcedToday = 0;
let lastScanMinute: number | null = null;
/**
 * Symbols the last in-window scan refused because their baseline reading was carried forward.
 *
 * Surfaced rather than counted silently: 128 of 208 symbols were carried on 2026-08-20, so a
 * morning where this number is most of the universe is a morning the 08:00 baseline build failed,
 * and the channel being quiet is a data problem rather than a quiet tape.
 */
let skippedStaleBaseline = 0;

/**
 * Called once per scan with the live readings. Never throws — an alert channel must not be able
 * to fail the scan that produced it.
 */
export async function onScan(
  inputs: DisplacementInput[],
  cfg: MomentumConfig,
  nowMs: number,
  baselineReady: boolean,
): Promise<DisplacementCandidate[]> {
  if (!enabled()) return [];

  try {
    // Every level in the message is a multiple of ATR or of a quoted premium, and ATR comes only
    // from the baseline. Without it there is nothing to send.
    if (!baselineReady) return [];

    const r = rule();
    const minute = minuteOfSession(nowMs);
    lastScanMinute = minute;
    if (minute < r.fromMinute || minute > r.toMinute) return [];
    skippedStaleBaseline = allowCarried() ? 0 : inputs.filter((i) => i.baselineCarriedFrom).length;

    const day = istDay(nowMs);
    const state = await load(day);

    // Logged BEFORE the cap check, on purpose: the candidates a full cap turns away are exactly
    // the ones a capacity study needs, and returning early here is what threw them away before.
    observeCandidates(inputs, minute, r, nowMs);

    if (state.announced.length >= r.maxPerDay) return [];

    const announced = new Set(state.announced);
    const picked = selectDisplacement(inputs, announced, minute, r)
      .slice(0, r.maxPerDay - state.announced.length);
    if (!picked.length) return [];

    // Recorded BEFORE the send, exactly as the two channels beside it do: a webhook slower than
    // the fifteen-second scan would otherwise be handed the same symbols on the next tick.
    state.announced = [...state.announced, ...picked.map((p) => p.symbol)];
    await store.write(STORE_KEYS.displacementAlerts, state);
    announcedToday = state.announced.length;

    const strikes = await priceContracts(picked, cfg, nowMs);
    await deliver(picked, strikes, nowMs);
    // After the send, never before it. The journal is bookkeeping and must not be able to delay
    // or fail the one thing on this path that matters.
    await recordEntries('displacement', picked.map((c) => ({
      symbol: c.symbol,
      direction: c.direction,
      spot: c.entry,
      minute: c.minute,
      lotSize: c.lotSize,
      strike: strikes.get(c.symbol) ?? null,
      readings: {
        rvol: c.rvol, rangeAtr: c.rangeAtr, moveAtr: c.moveAtr,
        offExtremeAtr: c.offExtremeAtr, atr: c.atr, turnoverCr: c.turnoverCr, changePct: c.changePct,
      },
    })), nowMs);
    markTaken(picked.map((c) => ({ symbol: c.symbol, minute: c.minute })), nowMs);
    return picked;
  } catch (e) {
    lastError = String((e as Error).message);
    return [];
  }
}

/**
 * Write the candidate log, once the window it describes has closed.
 *
 * Called from the scheduler rather than from `onScan`, because the log's `taken` column is only
 * true once the last in-window tick has delivered — flushing on the final tick itself would record
 * that minute's picks as "not taken", which is a lie in the one column a capacity study reads.
 * Idempotent: the day's log flushes once and then ignores further calls.
 */
export async function flushCandidateLog(nowMs = Date.now()): Promise<number> {
  const r = rule();
  if (minuteOfSession(nowMs) <= r.toMinute) return 0;
  return flushCandidates(nowMs);
}

/**
 * One chain per candidate, at most `maxPerDay` a session.
 *
 * The enrichment shortlist is ranked by provisional score and entry quality, and a stock that
 * gapped and ran before 09:30 is often on it — but not reliably, and a message naming no contract
 * is most of the message missing. Four requests a day against the ~28 the enrichment tier already
 * spends every minute is not a budget question.
 */
async function priceContracts(
  picked: DisplacementCandidate[],
  cfg: MomentumConfig,
  nowMs: number,
): Promise<Map<string, StrikeChoice | null>> {
  const out = new Map<string, StrikeChoice | null>();
  const uni = await universe(nowMs).catch(() => null);

  await Promise.all(
    picked.map(async (c) => {
      out.set(c.symbol, null);
      try {
        c.lotSize ??= uni?.bySymbol.get(c.symbol)?.future?.lotSize ?? null;
        const chain = await stockChain(c.symbol, c.equityKey, nowMs);
        // At the money, and that is a finding rather than a default: 2% in through 3% out all
        // landed within 0.3 points of each other over the 35 sessions, so there is nothing to
        // buy by walking out to a cheaper strike and a thinner book to pay for it. The target
        // handed to the picker is the second exit expressed in the underlying, via ATR, because
        // that is the move the contract has to survive.
        const target = c.entry + c.direction * 1.5 * c.atr;
        out.set(
          c.symbol,
          selectStrike({
            chain,
            direction: c.direction,
            spot: c.entry,
            targetPrice: target,
            lotSize: c.lotSize,
            preferDelta: { min: 0.4, max: 0.6 },
            maxThetaPctPerHour: 4,
            config: cfg,
          }),
        );
      } catch {
        // Left null. The alert is worth sending without a contract; it is not worth failing over.
      }
    }),
  );
  return out;
}

async function deliver(
  picked: DisplacementCandidate[],
  strikes: Map<string, StrikeChoice | null>,
  nowMs: number,
): Promise<void> {
  if (!telegramConfigured() && !discordConfigured()) {
    lastError = 'no phone channel is configured';
    return;
  }

  const results: boolean[] = [];
  for (const c of picked) {
    const s = strikes.get(c.symbol) ?? null;
    const jobs: Promise<boolean>[] = [];
    if (telegramConfigured()) jobs.push(sendTelegram(buildMessage(c, s, HTML, nowMs)));
    if (discordConfigured()) jobs.push(sendDiscord(buildMessage(c, s, MARKDOWN, nowMs), c.direction));
    results.push(...(await Promise.all(jobs)));
  }

  lastError = results.every(Boolean) ? null : 'a configured channel refused the message';
  lastSentAt = nowMs;
}

/** Reported on `/momentum/status`. */
export const displacementAlertStatus = () => ({
  enabled: enabled(),
  rule: rule(),
  exits: exits(),
  /** Where in the session the last scan landed, so a silent channel can be told from a stuck one. */
  lastScanMinute,
  windowOpen:
    lastScanMinute !== null && lastScanMinute >= rule().fromMinute && lastScanMinute <= rule().toMinute,
  announcedToday,
  /** How much of the universe the last in-window scan could not trust. See the field's own note. */
  skippedStaleBaseline,
  allowCarriedBaseline: allowCarried(),
  lastSentAt,
  lastError,
});

/** Test seam. */
export const resetDisplacementAlerts = async (): Promise<void> => {
  lastSentAt = null;
  lastError = null;
  announcedToday = 0;
  lastScanMinute = null;
  skippedStaleBaseline = 0;
  await store.write(STORE_KEYS.displacementAlerts, { ...EMPTY });
};

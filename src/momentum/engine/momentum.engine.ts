// The engine. Two stages, because the rate limit only allows two stages.
//
// Upstox allows 2000 requests per 30 minutes PER API PER USER. Scoring 208 F&O stocks on
// every factor every cycle would need 208 option-chain calls per cycle — 12,480 per
// 30 minutes against that endpoint, six times the ceiling. The scanner would work for four
// minutes and then be throttled off for the rest of the session.
//
// So:
//
//   STAGE 1 — every symbol, every cycle, THREE requests total.
//     One batched quote call covers 208 shares, 208 futures, the sector indices, the Nifty,
//     its future and the VIX. Nine of the twelve factors come out of that plus the daily
//     baseline: momentum pulse, volume, liquidity, relative strength, VWAP, ATR, sector,
//     breadth, trend. Futures open interest rides along too, so the build-up classification
//     is available universe-wide even before enrichment.
//
//     The momentum pulse — and with it the whole timing layer — costs nothing extra here:
//     it is measured from successive readings of this same poll. That is what makes an
//     early signal available on all 208 stocks rather than on the shortlist, which matters
//     because the stock about to move is by definition not yet a highly-ranked one.
//
//   STAGE 2 — the top N only, one request each.
//     Ranked by the stage-1 score, the shortlist gets its option chain: greeks, implied
//     volatility, call/put OI skew, option turnover. At the default 40 a minute that is
//     ~1200 per 30 minutes — 60% of the ceiling for that endpoint, with the quote endpoint
//     untouched at 3%.
//
// A row that did not make the shortlist is not penalised for it: the score is a weighted
// mean over AVAILABLE weight, and `enrichment: 'quote'` says which read it was. Enrichment
// results are cached for their own TTL and reused across stage-1 cycles, so a stock that
// drops out of the shortlist for one cycle keeps its option data until it goes stale.
//
// HOW THE SHORTLIST IS CHOSEN, AND WHY IT CHANGED. Ranking it by the stage-1 score alone
// meant the option chain only ever reached stocks that had ALREADY moved — the score is
// built from cumulative readings, so the shortlist was a list of finished moves and the one
// stock igniting at 11:04 could not get enriched until it had climbed a ranking built on the
// previous four hours. `signal.enrichReservedSlots` of the shortlist is now taken by the
// freshest timing signals instead, whatever they score. The cost is unchanged: the same
// number of chain requests, pointed at stocks where the move is still in front.

import type {
  FactorOutcome, MomentumBoard, MomentumConfig, MomentumRow, MomentumSignal,
} from '../types.js';
import { marketOpen, minuteOfSession, sessionFraction, istDay } from '../session.js';
import { getBaseline, type SymbolBaseline } from '../data/baseline.js';
import { quoteSnapshot, type MomentumQuote, type QuoteSnapshot } from '../data/quotes.js';
import { stockChain, type StockChain } from '../data/option-chain.js';
import { inBatches } from '../data/candles.js';
import {
  flushSessionState, holdDirection, observe, observeEnrichment, sessionState, smoothScore,
  type SessionState, type SymbolSessionState,
} from '../data/session-state.js';
import { historyRepository } from '../data/history.repository.js';
import { universe, type UniverseMember } from '../data/universe.js';
import { computeRvol, rvolFactor } from '../services/rvol.service.js';
import { computeLiquidity, liquidityFactor } from '../services/liquidity.service.js';
import { computeRelativeStrength, relativeStrengthFactor } from '../services/relative-strength.service.js';
import { computeVwap, vwapFactor } from '../services/vwap.service.js';
import { computeAtr, atrFactor } from '../services/atr.service.js';
import { computeTrend, trendFactor } from '../services/trend.service.js';
import { computeSector, sectorFactor } from '../services/sector.service.js';
import { computeBreadth, breadthFactor, marketContext, type BreadthReading } from '../services/breadth.service.js';
import { computeOptionFlow, optionFlowFactor, type OptionFlowReading } from '../services/option-analytics.service.js';
import { computeGreeks, greeksFactor, type GreeksReading } from '../services/greeks.service.js';
import { computeIv, ivFactor, type IvReading } from '../services/iv.service.js';
import { computePulse, pulseFactor, type PulseReading } from '../services/pulse.service.js';
import {
  computeConviction, convictionFactor, convictionSummary,
} from '../services/conviction.service.js';
import { onScan } from '../alerts/trend-day.js';
import { onScan as onIgnition } from '../alerts/ignition.js';
import { onScan as onDisplacement, type DisplacementInput } from '../alerts/displacement.js';
import { ensureAlertOverrides } from '../alerts/settings.js';
import type { ConvictionReading } from '../types.js';
import { buildSignal, buildTrendDayPlan, gateTradeType, type SignalInputs } from './signal.service.js';
import { institutionalActivity, scoreRow } from './score.service.js';
import { cache } from '../cache.js';

/** Concurrency for the chain fetches. Matches what upstox.ts measured safe for the ladder. */
const ENRICH_BATCH = 8;

/** Cached option enrichment for one symbol. */
interface Enrichment {
  at: number;
  chain: StockChain | null;
  error?: string;
}

const enrichKey = (symbol: string) => `momentum:enrich:${symbol}`;

/** The entry, stop, target and contract a confirmed trend day is announced with. */
export type TrendDayPlan = NonNullable<ReturnType<typeof buildTrendDayPlan>>;

/**
 * The trend-mode plans from the most recent scan, keyed by symbol.
 *
 * Held here so `GET /momentum/alerts/test` can preview the SAME numbers the live alert would send.
 * Without it the preview fell back to `row.signal.plan`, which is null for most of the board —
 * `buildSignal` returns early with no plan whenever the pulse ring is not yet ready — so the test
 * message showed "no price plan" for stocks the live alert would have priced perfectly well. A test
 * that understates the real thing is worse than no test, because it sends you looking for a bug
 * that is not there.
 */
let lastTrendPlans = new Map<string, TrendDayPlan>();
export const latestTrendPlans = (): Map<string, TrendDayPlan> => lastTrendPlans;

/* --------------------------------------------------------------- stage 1: the board --- */

interface StageOne {
  member: UniverseMember;
  quote: MomentumQuote;
  future: MomentumQuote | undefined;
  baseline: SymbolBaseline | undefined;
  symState: SymbolSessionState | undefined;
  factors: FactorOutcome[];
  liquidityScore: number | null;
  rvol: number | null;
  optionFlow: OptionFlowReading;
  provisionalScore: number;
  pulse: PulseReading;
  /** The session-shape read. Computed once in stage 1 and reused, because the phase machine
   *  it advances is stateful — computing it twice a cycle would age every trend day twice. */
  conviction: ConvictionReading;
  /**
   * The timing read, built before enrichment so it can decide who GETS enriched.
   *
   * Rebuilt in `buildRow` once the chain is in hand — the trigger it records is deduplicated
   * inside the cooldown, so the second build returns the first firing's timestamp rather
   * than re-stamping the signal as brand new every cycle.
   */
  signal: MomentumSignal;
  metricsCarry: {
    vwap: ReturnType<typeof computeVwap>;
    trend: ReturnType<typeof computeTrend>;
    relStrength: ReturnType<typeof computeRelativeStrength> | null;
    sector: ReturnType<typeof computeSector>;
    atr: ReturnType<typeof computeAtr>;
    liquidity: ReturnType<typeof computeLiquidity>;
    rvolReading: ReturnType<typeof computeRvol>;
  };
}

/** Filters applied before any scoring, so a penny stock cannot occupy a shortlist slot. */
function passesUniverseFilter(q: MomentumQuote, cfg: MomentumConfig): boolean {
  if (cfg.universe.exclude.includes(q.symbol)) return false;
  if (q.ltp < cfg.universe.minPrice) return false;
  // Turnover is cumulative for the day, so this only bites once there has been some trade.
  // Before the open every stock reads zero, and filtering then would empty the board.
  if (q.turnoverCr > 0 && q.turnoverCr < cfg.universe.minTurnoverCr) return false;
  return true;
}

function stageOne(
  member: UniverseMember,
  snap: QuoteSnapshot,
  baseline: SymbolBaseline | undefined,
  state: SessionState,
  breadth: BreadthReading,
  cfg: MomentumConfig,
  nowMs: number,
): StageOne | null {
  const quote = snap.equity.get(member.symbol);
  if (!quote || !passesUniverseFilter(quote, cfg)) return null;

  const future = snap.futures.get(member.symbol);
  const symState = state.symbols[member.symbol];
  const minute = minuteOfSession(nowMs);
  const fraction = sessionFraction(nowMs);

  const rvolReading = computeRvol(quote, baseline, minute, cfg);
  const liquidityReading = computeLiquidity({ quote, baseline }, cfg);
  const relStrength = snap.nifty
    ? computeRelativeStrength(quote.changePct, snap.nifty.changePct, baseline, cfg)
    : null;
  const vwapReading = computeVwap(quote, symState);
  const atrReading = computeAtr(quote, baseline, fraction, cfg);
  const trendReading = computeTrend(quote, baseline, symState?.openingRange ?? null, cfg);
  const sectorReading = computeSector(
    quote.changePct,
    member.sector,
    member.sectorIndexName,
    member.sectorIndexName ? snap.sectors.get(member.sectorIndexName) : undefined,
    snap.nifty?.changePct ?? null,
  );
  // Futures OI is on the Tier-A quote, so the build-up class is known for the whole
  // universe. Only the chain half of this factor waits for enrichment.
  const optionFlow = computeOptionFlow(future, baseline, null);
  // The timing read, from the ring the quote poll has been filling. No request, so it is
  // available on every stock in the universe rather than on the enrichment shortlist —
  // which is the point, since the stock about to move is not yet a highly-ranked one.
  const pulseReading = computePulse(quote, symState, baseline, cfg, nowMs);
  // The session-shape read, from the same accumulators the quote poll has been filling. Like
  // the pulse it costs no upstream call, which is what makes it affordable on the whole
  // universe — and being universe-wide matters more here than anywhere else in the module,
  // because a stock that has quietly walked one direction since 09:30 is by construction NOT
  // near the top of a momentum ranking and would never survive a shortlist to be measured.
  const convictionReading = computeConviction(symState, baseline, cfg, nowMs);

  const factors: FactorOutcome[] = [
    pulseFactor(pulseReading, cfg),
    convictionFactor(convictionReading, cfg),
    rvolFactor(rvolReading, cfg),
    liquidityFactor(liquidityReading, cfg),
    relativeStrengthFactor(relStrength, cfg),
    vwapFactor(vwapReading, cfg),
    atrFactor(atrReading, cfg),
    sectorFactor(sectorReading, cfg),
    trendFactor(trendReading, cfg),
    optionFlowFactor(optionFlow, cfg),
  ];

  // Breadth needs the row's own direction, so it is scored after the others have voted.
  const provisionalDirection = directionOf(factors);
  factors.push(breadthFactor(breadth, provisionalDirection, cfg));

  const provisional = scoreRow({ factors, liquidityScore: liquidityReading.score, config: cfg });

  const signal = buildSignal({
    quote,
    pulse: pulseReading,
    pulseScore: factors.find((f) => f.key === 'momentumPulse')?.score ?? null,
    symState,
    baseline,
    openingRange: symState?.openingRange ?? null,
    // No chain yet — the plan is priced off ATR and names no strike until enrichment lands.
    greeks: null,
    chain: null,
    lotSize: member.future?.lotSize ?? null,
    direction: provisional.direction,
    conviction: convictionReading,
    liquidityScore: liquidityReading.score,
    config: cfg,
    nowMs,
  });

  return {
    member,
    quote,
    future,
    baseline,
    symState,
    factors,
    liquidityScore: liquidityReading.score,
    rvol: rvolReading.rvol,
    optionFlow,
    provisionalScore: provisional.score,
    pulse: pulseReading,
    conviction: convictionReading,
    signal,
    metricsCarry: {
      vwap: vwapReading,
      trend: trendReading,
      relStrength,
      sector: sectorReading,
      atr: atrReading,
      liquidity: liquidityReading,
      rvolReading,
    },
  };
}

/** The directional vote so far — used to score breadth before the full score exists. */
function directionOf(factors: FactorOutcome[]): number {
  let num = 0;
  let den = 0;
  for (const f of factors) {
    if (!f.available || f.score === null || f.bias === 0) continue;
    const strength = f.score / 100;
    num += f.bias * f.weight * strength;
    den += f.weight * strength;
  }
  return den > 0 ? num / den : 0;
}

/* -------------------------------------------------------------- shortlist policy --- */

/**
 * Who gets the option chain this cycle.
 *
 * Two lists, merged. The first is the old one — highest provisional score — and it is still
 * most of the shortlist, because a board that dropped it would lose the ability to say
 * anything about the stocks people are actually watching.
 *
 * The second is the fix. `enrichReservedSlots` go to the rows the TIMING layer likes most,
 * ranked by entry quality, taken from whatever is left after the score has had its pick.
 * Without it the enrichment tier had a structural blind spot: option data only reached
 * stocks that had already climbed a ranking built entirely from cumulative readings, so the
 * stock igniting right now was always the one being scored without its Greeks — and the
 * missing Greeks are 9 of the weight, which pushed it further down the very ranking that
 * decides who gets enriched.
 */
export function chooseShortlist(staged: StageOne[], cfg: MomentumConfig): StageOne[] {
  const size = cfg.universe.shortlistSize;
  if (size <= 0 || !staged.length) return [];

  const reserved = cfg.signal.enabled ? Math.min(cfg.signal.enrichReservedSlots, Math.floor(size / 2)) : 0;
  const byScore = [...staged].sort((a, b) => b.provisionalScore - a.provisionalScore);

  const picked = byScore.slice(0, size - reserved);
  if (reserved <= 0) return picked;

  const taken = new Set(picked.map((s) => s.member.symbol));
  const byEntry = [...staged]
    .filter((s) => !taken.has(s.member.symbol) && s.signal.entryQuality > 0)
    .sort((a, b) => {
      // Igniting first whatever it scores — that is the whole reason these slots exist.
      const ai = a.signal.state === 'Igniting' ? 1 : 0;
      const bi = b.signal.state === 'Igniting' ? 1 : 0;
      return bi - ai || b.signal.entryQuality - a.signal.entryQuality;
    })
    .slice(0, reserved);

  return [...picked, ...byEntry];
}

/* ------------------------------------------------------------ stage 2: enrichment --- */

/**
 * Fetch (or reuse) the option chain for the shortlist.
 *
 * Failures are per-symbol and cached with the same TTL as successes. Without that, a stock
 * whose chain Upstox refuses would be retried on every cycle for the rest of the session,
 * burning requests against a call that has already said no — the same reasoning
 * `upstox.ts` applies to the PCR endpoint.
 */
async function enrich(shortlist: StageOne[], cfg: MomentumConfig, nowMs: number): Promise<Map<string, Enrichment>> {
  const out = new Map<string, Enrichment>();

  await inBatches(shortlist, ENRICH_BATCH, async (row) => {
    const key = enrichKey(row.member.symbol);
    const hit = await cache.get<Enrichment>(key);
    if (hit) {
      out.set(row.member.symbol, hit);
      return;
    }
    let value: Enrichment;
    try {
      value = { at: nowMs, chain: await stockChain(row.member.symbol, row.member.equityKey, nowMs) };
    } catch (e) {
      value = { at: nowMs, chain: null, error: String((e as Error).message) };
    }
    await cache.set(key, value, cfg.refresh.enrichMs);
    out.set(row.member.symbol, value);
  });

  return out;
}

/* --------------------------------------------------------------------- assembly --- */

function buildRow(
  s: StageOne,
  enrichment: Enrichment | undefined,
  ivReading: IvReading | null,
  breadth: BreadthReading,
  cfg: MomentumConfig,
  nowMs: number,
  /**
   * Collects the trend-mode plan for any row whose conviction is Confirmed, for the alert.
   *
   * An out-parameter rather than a second return value, because every other caller of this
   * function wants a `MomentumRow` and only the scan wants this. Omitted, nothing is built.
   */
  trendPlans?: Map<string, TrendDayPlan>,
): MomentumRow {
  const chain = enrichment?.chain ?? null;
  const carry = s.metricsCarry;

  // Rebuild the option-dependent factors now the chain is in hand. The quote-tier factors
  // are reused as computed — recomputing them would be identical work.
  let factors = s.factors;
  let optionFlow = s.optionFlow;
  let greeks: GreeksReading | null = null;
  let liquidityScore = s.liquidityScore;

  if (chain) {
    optionFlow = computeOptionFlow(s.future, s.baseline, chain);
    greeks = computeGreeks(chain, s.quote.ltp, s.quote.prevClose, s.symState);

    // Option turnover is a liquidity input, so liquidity is re-mixed once it is known.
    const liq = computeLiquidity(
      { quote: s.quote, baseline: s.baseline, optionValueCr: optionFlow.optionValueCr },
      cfg,
    );
    liquidityScore = liq.score;

    const replacements = new Map<string, FactorOutcome>([
      ['optionFlow', optionFlowFactor(optionFlow, cfg)],
      ['liquidity', liquidityFactor(liq, cfg)],
      ['greeks', greeksFactor(greeks, cfg)],
    ]);
    if (ivReading) replacements.set('impliedVolatility', ivFactor(ivReading, cfg));

    factors = s.factors.map((f) => replacements.get(f.key) ?? f);
    for (const [key, f] of replacements) if (!factors.some((x) => x.key === key)) factors.push(f);
  }

  // Breadth is direction-dependent, so it is re-scored against the final factor set.
  const withoutBreadth = factors.filter((f) => f.key !== 'marketBreadth');
  factors = [...withoutBreadth, breadthFactor(breadth, directionOf(withoutBreadth), cfg)];

  const result = scoreRow({ factors, liquidityScore, config: cfg });

  // The timing read, rebuilt against the final direction and — where the chain arrived —
  // against the delta and premium actually quoted, so the plan says what the option does
  // rather than only what the stock does. `recordTrigger` dedupes inside the cooldown, so
  // this does not restamp the trigger the stage-1 build already dated.
  const signalInputs: SignalInputs = {
    quote: s.quote,
    pulse: s.pulse,
    pulseScore: factors.find((f) => f.key === 'momentumPulse')?.score ?? null,
    symState: s.symState,
    baseline: s.baseline,
    openingRange: s.symState?.openingRange ?? null,
    greeks,
    // With the chain in hand the plan names a specific contract rather than pricing a
    // notional ATM one; the lot comes off the future, which NSE lists identically for
    // that underlying's options.
    chain,
    lotSize: s.member.future?.lotSize ?? null,
    direction: result.direction,
    conviction: s.conviction,
    liquidityScore,
    config: cfg,
    nowMs,
  };

  const signal = cfg.signal.enabled ? buildSignal(signalInputs) : null;

  // The plan a confirmed trend day deserves, for the alert.
  //
  // Built here rather than inside the alert because it must come from the SAME inputs object the
  // row's own signal was built from — a second construction of those inputs is how a message and
  // a board start quoting different stops for the same stock.
  //
  // It is a separate build rather than `signal.plan` because that one is only in trend mode when
  // the state machine happens to be `Trending`, which is a claim about the last three minutes. A
  // stock is very often `Quiet` at the instant its conviction is confirmed, and the plan then
  // carries the ignition stop instead of the VWAP one — and VWAP is the level a one-sided day is
  // actually defended at, so it is the honest stop for this signal.
  if (trendPlans && cfg.signal.enabled && s.conviction.phase === 'Confirmed') {
    const dir = s.conviction.direction === 'Bullish' ? 1 : s.conviction.direction === 'Bearish' ? -1 : null;
    const built = dir === null ? null : buildTrendDayPlan(signalInputs, dir);
    if (built) trendPlans.set(s.member.symbol, built);
  }

  // The ordering key. Smoothed, because the board was previously sorted on a number recomputed
  // every fifteen seconds with a 16-weight three-minute factor inside it — so a row moved
  // dozens of places on one wobble and the list could not be read, let alone acted on. A
  // fraction of conviction is blended in so a stock that has been walking one direction for
  // four hours does not sit below one that spiked ninety seconds ago.
  const smoothed = s.symState
    ? smoothScore(s.symState, result.score, cfg.ranking.smoothingHalfLifeMin, nowMs)
    : result.score;
  const convictionPull = s.conviction.ready ? s.conviction.score : smoothed;
  const rankScore =
    smoothed * (1 - cfg.ranking.convictionWeight) + convictionPull * cfg.ranking.convictionWeight;
  const heldMin = s.symState ? holdDirection(s.symState, result.direction, nowMs) : null;

  const activity = institutionalActivity(
    {
      rvol: s.rvol,
      turnoverCr: s.quote.turnoverCr,
      avgDailyValueCr: s.baseline?.avgDailyValueCr ?? null,
      optionValueCr: optionFlow.optionValueCr,
      futuresOiChangePct: optionFlow.futuresOiChangePct,
    },
    cfg,
  );

  const enrichmentLevel = chain ? 'full' : enrichment?.error ? 'partial' : 'quote';

  return {
    rank: 0, // assigned after sorting
    symbol: s.member.symbol,
    sector: s.member.sector,
    price: s.quote.ltp,
    prevClose: s.quote.prevClose,
    changePct: s.quote.changePct,
    volume: s.quote.volume,
    turnoverCr: s.quote.turnoverCr,

    score: result.score,
    rawScore: result.rawScore,
    coverage: result.coverage,
    confidence: result.confidence,
    direction: result.direction,
    // The headline label is only allowed to say Buy/Sell when the timing layer agrees the
    // entry is still there. Everything else the model liked becomes Watch.
    tradeType: gateTradeType(result.tradeType, signal, cfg),
    institutionalActivity: activity.level,
    signal,
    conviction: cfg.thresholds.conviction.enabled ? convictionSummary(s.conviction) : null,
    stability: {
      rankScore: +rankScore.toFixed(2),
      drift: +(result.score - smoothed).toFixed(2),
      heldMin,
    },

    liquidity: { score: liquidityScore, grade: carry.liquidity.grade },
    rvol: { value: s.rvol, grade: carry.rvolReading.grade },
    vwap: { value: carry.vwap.vwap, distancePct: carry.vwap.distancePct, rising: carry.vwap.rising },
    relativeStrengthPct: carry.relStrength?.relativeStrengthPct ?? null,
    sectorStrengthPct: carry.sector?.sectorVsNiftyPct ?? null,
    atrExpansion: carry.atr.expansion,
    oiBuildUp: optionFlow.buildUp,
    oi: {
      futuresOi: optionFlow.futuresOi,
      futuresOiChangePctIntraday: optionFlow.futuresOiChangePct,
      pcrOi: optionFlow.pcrOi,
      pcrVolume: optionFlow.pcrVolume,
      maxPain: optionFlow.maxPain,
      optionValueCr: optionFlow.optionValueCr,
      expiry: optionFlow.expiry,
    },
    greeksSummary: greeks
      ? {
          delta: greeks.callDelta,
          deltaShift: greeks.deltaShift,
          gamma: greeks.gammaPer1Pct,
          thetaBurnPct: greeks.thetaBurnPct,
        }
      : null,
    ivSummary: ivReading
      ? { atmIv: ivReading.atmIv, ivRank: ivReading.ivRank, ivPercentile: ivReading.ivPercentile, basis: ivReading.basis }
      : null,
    expectedMove: greeks?.expectedMove ?? null,
    trend: {
      higherHigh: carry.trend.higherHigh,
      higherLow: carry.trend.higherLow,
      breakout: carry.trend.breakout,
      orb: carry.trend.orb,
    },

    enrichment: enrichmentLevel,
    reasons: result.reasons,
    factors,
  };
}

/* ------------------------------------------------------------------------ public --- */

export interface EngineResult {
  board: MomentumBoard;
}

/**
 * One full scan.
 *
 * Called by the scheduler on the quote interval and by the controller on a cache miss.
 * Every upstream call it makes is counted in the header comment; if you add one, update it.
 */
export async function runScan(cfg: MomentumConfig, nowMs = Date.now()): Promise<MomentumBoard> {
  const warnings: string[] = [];

  const [uni, snap, baselineResult, state] = await Promise.all([
    universe(nowMs),
    quoteSnapshot(nowMs),
    getBaseline(nowMs),
    sessionState(nowMs),
  ]);

  const baseline = baselineResult.baseline;
  if (!baseline) {
    warnings.push(
      'No daily baseline yet — relative volume, ATR expansion, beta and trend structure are unavailable until it builds. ' +
      'POST /momentum/baseline/rebuild, or wait for the scheduled build.',
    );
  } else if (baselineResult.stale) {
    warnings.push(`Baseline is from ${baseline.day}, not ${istDay(nowMs)} — RVOL and ATR are measured against a stale profile.`);
  }
  // COUNTED ON WHAT A SYMBOL ACTUALLY HAS, not on what today's build failed to fetch. Those were
  // the same number until readings started being carried forward from the previous baseline: a
  // symbol Upstox refused this morning is in `failures` AND holds a perfectly usable ATR from
  // yesterday, and reporting it as having "no baseline" sent a reader to fix something that was
  // working. The two states want different responses, so they are two different warnings.
  const missing = baseline
    ? uni.members.filter((m) => !baseline.symbols[m.symbol]).length
    : 0;
  if (missing > 0)
    warnings.push(`${missing} symbols have no baseline (Upstox would not serve their history).`);

  const carried = baseline ? Object.values(baseline.symbols).filter((s) => s.carriedFrom).length : 0;
  if (carried > 0)
    warnings.push(
      `${carried} symbols are on a carried-forward baseline — today's build could not reach them, ` +
      'so their RVOL and ATR come from an earlier session. Rebuild with a clean request budget to refresh them.',
    );

  // Fold this reading into the session state before anything reads it, so the VWAP slope,
  // the opening range and the price ring all include the current tick.
  //
  // The reversal distance handed to the leg tracker is ATR-scaled per symbol: what counts as
  // "it turned" is a fraction of that stock's own daily range, not a fixed percentage that
  // would end a leg on every wobble in a heavy name and never end one in a volatile midcap.
  const openingMinutes = cfg.thresholds.trendStructure.openingRangeMinutes;
  const p = cfg.thresholds.pulse;
  const conv = cfg.thresholds.conviction;
  for (const q of snap.equity.values()) {
    const atr = baseline?.symbols[q.symbol]?.atr ?? 0;
    const reversal = atr > 0 ? atr * p.legReversalAtr : q.ltp * (p.legReversalPctFloor / 100);
    // ATR goes in so the session-shape accumulators can scale their VWAP-side buffer per
    // symbol: what counts as "on a side of VWAP" has to be a fraction of that stock's own
    // range, or a ₹39,000 stock registers a crossing on every rounding tick and the single
    // best one-sidedness reading in the model becomes noise.
    observe(state, q, openingMinutes, nowMs, reversal, {
      atr,
      vwapSideBufferAtr: conv.vwapSideBufferAtr,
      spineIntervalMin: conv.spineIntervalMin,
    });
  }

  const breadth = computeBreadth(snap);

  // ---- stage 1 ----
  const staged: StageOne[] = [];
  for (const member of uni.members) {
    const s = stageOne(member, snap, baseline?.symbols[member.symbol], state, breadth, cfg, nowMs);
    if (s) staged.push(s);
  }

  // ---- stage 2 ----
  const shortlist = chooseShortlist(staged, cfg);

  const enrichments = shortlist.length ? await enrich(shortlist, cfg, nowMs) : new Map<string, Enrichment>();
  const enrichFailures = [...enrichments.values()].filter((e) => e.error).length;
  if (enrichFailures) warnings.push(`${enrichFailures} of ${shortlist.length} shortlisted symbols had no option chain this cycle.`);

  // IV needs the recorded history, read once per shortlisted symbol.
  const ivReadings = new Map<string, IvReading>();
  for (const s of shortlist) {
    const e = enrichments.get(s.member.symbol);
    const history = await historyRepository.forSymbol(s.member.symbol);
    ivReadings.set(s.member.symbol, computeIv(e?.chain ?? null, s.baseline, history, cfg));
  }

  // Sorted on the SMOOTHED key, not the raw score. `score` is still the number the row
  // reports and the number every threshold is measured against — this changes only the order
  // rows are presented in, which is the difference between a board that can be read and one
  // that reshuffles under the cursor.
  const trendPlans = new Map<string, TrendDayPlan>();
  const rows = staged
    .map((s) =>
      buildRow(s, enrichments.get(s.member.symbol), ivReadings.get(s.member.symbol) ?? null, breadth, cfg, nowMs, trendPlans))
    .filter((r) => r.coverage >= cfg.scoring.minCoverage)
    .sort((a, b) => b.stability.rankScore - a.stability.rankScore || b.score - a.score);

  rows.forEach((r, i) => { r.rank = i + 1; });

  // Published for the preview endpoint, whether or not the market is open — checking the message
  // format is exactly the thing you want to do out of hours.
  lastTrendPlans = trendPlans;

  // Record what the enrichment pass learned, both for the next pass's measured delta shift
  // and for the IV history that IV Rank will eventually be built on.
  await persistSessionLearning(shortlist, enrichments, ivReadings, rows, nowMs);

  const open = marketOpen(nowMs);

  // Announce anything whose conviction has just been CONFIRMED.
  //
  // Here rather than in the scheduler because this is the only place the finished board exists,
  // and the alert has to be keyed off the same rows the board serves — a second pass over a
  // re-read snapshot could announce a confirmation the board no longer shows.
  //
  // Gated on the market being open: `currentBoard()` runs a full scan on demand for any HTTP
  // request whose cache has expired, at any hour, and the phase machine's `confirmedAt` survives
  // in the session file. Without this an evening page load could re-announce the day. Awaited so
  // a failure is caught by `runScan`'s own caller rather than becoming an unhandled rejection —
  // `onScan` never throws, and its own channels are fire-and-forget inside it.
  //
  // The baseline's presence goes with it. Every level in that message is a multiple of ATR, and
  // ATR comes only from here — so a scan that ran during the morning build, or after a restart
  // that found no baseline on disk, can produce Confirmed rows it cannot price. The alert decides
  // what to do about that; what this call has to do is stop pretending the question never arose.
  // Whatever the UI has set these channels to, before any of them is asked whether it is on.
  // A disk read once per process; see alerts/settings.ts for why it is here and not at boot.
  if (open) await ensureAlertOverrides();

  if (open) await onScan(rows, trendPlans, cfg, nowMs, baseline !== null);

  // And anything whose move has just STARTED. Separate call rather than a branch inside the one
  // above, because the two answer different questions off the same board: `onScan` fires on the
  // conviction layer confirming a DAY — which cannot happen before minute 75 — and this fires on
  // the timing layer offering an ENTRY, which is live from the first few minutes of the session.
  // Replayed against 2026-08-14 that gap was the difference between IDEA at 13.67 and at 14.08.
  //
  // Same gating and same ordering: market open only, baseline required, awaited so a failure
  // surfaces here rather than as an unhandled rejection. It is off unless IGNITION_ALERTS=on.
  if (open) await onIgnition(rows, cfg, nowMs, baseline !== null);

  // And the third channel, which fires in the first half hour or not at all.
  //
  // Built from `staged` rather than from `rows` because the readings it needs — the session open
  // and the day's running extremes — are on the quote and not on the public row type, and
  // widening `MomentumRow` to decorate one alert would change the board's API for the sake of
  // this call. Same source objects the board is built from, so the two cannot disagree.
  //
  // Not filtered by `coverage` the way `rows` is: this rule reads volume, range and ATR only, all
  // of which are present or absent as a unit, and a stock whose OPTION-FLOW factor failed is not
  // a stock whose morning range is unknown. The alert's own gates reject anything unmeasurable.
  if (open) {
    const displacementInputs: DisplacementInput[] = staged.map((s) => ({
      symbol: s.member.symbol,
      equityKey: s.member.equityKey,
      quote: s.quote,
      atr: s.baseline?.atr ?? null,
      avgDailyValueCr: s.baseline?.avgDailyValueCr ?? null,
      rvol: s.rvol,
      lotSize: s.member.future?.lotSize ?? null,
      baselineCarriedFrom: s.baseline?.carriedFrom ?? null,
    }));
    await onDisplacement(displacementInputs, cfg, nowMs, baseline !== null);
  }

  // A restart mid-session leaves the price ring empty, and the timing layer is dark until it
  // refills. That is a real state and is said out loud rather than looking like "nothing is
  // igniting today" — the two are indistinguishable on screen and opposite in meaning.
  const pulseWarming = rows.filter((r) => r.signal && !r.signal.pulse.ready).length;
  if (pulseWarming > rows.length * 0.5 && rows.length > 0)
    warnings.push(
      `The timing layer is warming up for ${pulseWarming} of ${rows.length} rows — it measures the last ` +
      `${cfg.thresholds.pulse.fastWindowMin} minutes from the quote poll, so it needs about that long after a restart ` +
      'before it can call an entry.',
    );

  const ivWarming = [...ivReadings.values()].filter((r) => r.basis === 'hv-proxy').length;
  if (ivWarming)
    warnings.push(
      `IV Rank is standing in from realised volatility for ${ivWarming} symbols — Upstox publishes no IV history, ` +
      `so a true rank needs ${cfg.thresholds.impliedVolatility.minSessionsForIvRank} recorded sessions.`,
    );

  return {
    asOf: nowMs,
    configVersion: cfg.version,
    universeSize: uni.members.length,
    scored: rows.length,
    shortlisted: shortlist.length,
    igniting: rows.filter((r) => r.signal?.state === 'Igniting').length,
    entrable: rows.filter((r) => r.signal?.action === 'Buy Call' || r.signal?.action === 'Buy Put').length,
    trendConfirmed: rows.filter((r) => r.conviction?.phase === 'Confirmed').length,
    trendForming: rows.filter((r) => r.conviction?.phase === 'Forming').length,
    trendFaded: rows.filter((r) => r.conviction?.phase === 'Faded').length,
    market: marketContext(snap, breadth, open, sessionFraction(nowMs), minuteOfSession(nowMs)),
    rows,
    warnings,
  };
}

/**
 * Write what only this pass knows.
 *
 * The IV row is upserted per session, so re-running the scan through the day overwrites the
 * same record rather than appending — what the history needs is one representative reading
 * per session, and the last one of the day is the settled one.
 */
async function persistSessionLearning(
  shortlist: StageOne[],
  enrichments: Map<string, Enrichment>,
  ivReadings: Map<string, IvReading>,
  rows: MomentumRow[],
  nowMs: number,
): Promise<void> {
  const state = await sessionState(nowMs);
  const day = istDay(nowMs);
  const bySymbol = new Map(rows.map((r) => [r.symbol, r]));

  const records = [];
  for (const s of shortlist) {
    const chain = enrichments.get(s.member.symbol)?.chain ?? null;
    const iv = ivReadings.get(s.member.symbol);
    const greeks = chain ? computeGreeks(chain, s.quote.ltp, s.quote.prevClose, s.symState) : null;

    observeEnrichment(
      state,
      s.member.symbol,
      { atmDelta: greeks?.callDelta ?? null, futuresOi: s.future?.openInterest ?? null },
      nowMs,
    );

    const row = bySymbol.get(s.member.symbol);
    if (!row) continue;
    records.push({
      symbol: s.member.symbol,
      day,
      close: s.quote.ltp,
      score: row.score,
      direction: row.direction,
      rvol: s.rvol,
      atmIv: iv?.atmIv ?? null,
      hv20: s.baseline?.hv20 ?? null,
      futuresOi: s.future?.openInterest ?? null,
    });
  }

  await historyRepository.upsertMany(records);
  await flushSessionState();
}

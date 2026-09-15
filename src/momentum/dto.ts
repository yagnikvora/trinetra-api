// Request validation. Hand-rolled rather than reached for Zod, because this app has two
// runtime dependencies and adding a third for four endpoints is not a trade worth making.
//
// The config endpoint is the one that matters: it is an admin surface that rewrites the
// scoring model, and a bad patch reaching the engine produces a board full of NaN rather
// than an error anyone can act on. So a patch is validated STRUCTURALLY here — is this
// shape a config patch at all — and the result is then sanitised in the repository, which
// is a different check: a patch can be individually well-formed and still leave every
// weight at zero.

import type { AlertSettingsPatch } from './alerts/settings.js';
import type { DeepPartial } from './config/config.repository.js';
import type {
  FactorKey, MomentumConfig, MomentumRow, SignalAction, SignalState, TrendPhase,
} from './types.js';
import { FACTOR_KEYS } from './types.js';

export class ValidationError extends Error {
  constructor(readonly issues: string[]) {
    super(issues.join('; '));
    this.name = 'ValidationError';
  }
}

export interface BoardQuery {
  limit: number;
  minScore: number;
  direction: 'Bullish' | 'Bearish' | 'Neutral' | null;
  tradeType: 'Momentum Buy' | 'Momentum Sell' | 'Watch' | 'Avoid' | null;
  confidence: 'High' | 'Medium' | 'Low' | null;
  sector: string | null;
  /** Include the full thirteen-factor breakdown on every row. Heavy — off by default. */
  includeFactors: boolean;
  /** Timing-layer filters. `state`/`action` are exact; `minEntryQuality` is a floor. */
  state: SignalState | null;
  action: SignalAction | null;
  minEntryQuality: number;
  /** Only rows with a trigger inside `signal.maxTriggerAgeMin`. */
  freshOnly: boolean;
  /** Conviction-layer filters — what the Trend Day view is built on. */
  phase: TrendPhase | null;
  minConviction: number;
  /** Shorthand for `phase in (Forming, Confirmed)`, which is the useful default. */
  trendOnly: boolean;
  /** Sort key. `conviction` is what the trend view ranks by; the board defaults to rank. */
  sort: 'rank' | 'score' | 'conviction' | 'entryQuality';
}

const SIGNAL_STATES = ['Igniting', 'Trending', 'Extending', 'Extended', 'Stalling', 'Reversing', 'Quiet'] as const;
const SIGNAL_ACTIONS = ['Buy Call', 'Buy Put', 'Watch', 'Stand Aside'] as const;
const TREND_PHASES = ['None', 'Forming', 'Confirmed', 'Faded'] as const;
const SORTS = ['rank', 'score', 'conviction', 'entryQuality'] as const;

const asInt = (v: unknown, fallback: number, lo: number, hi: number): number => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, Math.round(n)));
};

const oneOf = <T extends string>(v: unknown, allowed: readonly T[]): T | null => {
  const s = String(v ?? '').trim();
  return (allowed as readonly string[]).includes(s) ? (s as T) : null;
};

const asBool = (v: unknown): boolean => v === true || v === 'true' || v === '1';

export function parseBoardQuery(q: Record<string, unknown>, cfg: MomentumConfig): BoardQuery {
  return {
    limit: asInt(q.limit, cfg.output.limit, 1, 500),
    minScore: asInt(q.minScore, cfg.output.minScore, 0, cfg.scoring.maxScore),
    direction: oneOf(q.direction, ['Bullish', 'Bearish', 'Neutral'] as const),
    tradeType: oneOf(q.tradeType, ['Momentum Buy', 'Momentum Sell', 'Watch', 'Avoid'] as const),
    confidence: oneOf(q.confidence, ['High', 'Medium', 'Low'] as const),
    sector: q.sector ? String(q.sector).toUpperCase() : null,
    includeFactors: asBool(q.includeFactors),
    state: oneOf(q.state, SIGNAL_STATES),
    action: oneOf(q.action, SIGNAL_ACTIONS),
    minEntryQuality: asInt(q.minEntryQuality, 0, 0, 100),
    freshOnly: asBool(q.freshOnly),
    phase: oneOf(q.phase, TREND_PHASES),
    minConviction: asInt(q.minConviction, 0, 0, 100),
    trendOnly: asBool(q.trendOnly),
    sort: oneOf(q.sort, SORTS) ?? 'rank',
  };
}

/** Apply the timing- and conviction-layer filters. Shared by the board and the feeds. */
export function applySignalFilters(rows: MomentumRow[], q: BoardQuery, cfg: MomentumConfig): MomentumRow[] {
  let out = rows;
  if (q.state) out = out.filter((r) => r.signal?.state === q.state);
  if (q.action) out = out.filter((r) => r.signal?.action === q.action);
  if (q.minEntryQuality > 0) out = out.filter((r) => (r.signal?.entryQuality ?? 0) >= q.minEntryQuality);
  if (q.freshOnly)
    out = out.filter((r) => r.signal?.trigger != null && r.signal.trigger.ageMin <= cfg.signal.maxTriggerAgeMin);

  if (q.phase) out = out.filter((r) => r.conviction?.phase === q.phase);
  // `Faded` is deliberately excluded from `trendOnly`. It IS a trend day and it is the most
  // dangerous row on the board, but it is not one to open a position in — it belongs in a
  // warning list, not a candidate list.
  if (q.trendOnly)
    out = out.filter((r) => r.conviction?.phase === 'Forming' || r.conviction?.phase === 'Confirmed');
  if (q.minConviction > 0) out = out.filter((r) => (r.conviction?.score ?? 0) >= q.minConviction);

  return sortRows(out, q.sort);
}

/**
 * Order the rows.
 *
 * `rank` is the engine's own smoothed ordering and is left alone — re-sorting on the raw score
 * here would undo the whole point of smoothing it there. The other three are explicit user
 * choices, and `conviction` is what the Trend Day view is built on: it puts the stock that has
 * walked one direction for four hours above the one that spiked ninety seconds ago, which is
 * the opposite of what the momentum board is for and exactly what that view is for.
 */
function sortRows(rows: MomentumRow[], sort: BoardQuery['sort']): MomentumRow[] {
  if (sort === 'rank') return rows;
  const out = [...rows];
  if (sort === 'score') out.sort((a, b) => b.score - a.score);
  else if (sort === 'entryQuality')
    out.sort((a, b) => (b.signal?.entryQuality ?? 0) - (a.signal?.entryQuality ?? 0));
  else
    out.sort((a, b) => {
      // Confirmed above Forming above everything, then by conviction, then by how long it has
      // held — because on two equally one-sided days the older one has proved more.
      const rank = (r: MomentumRow): number =>
        r.conviction?.phase === 'Confirmed' ? 2 : r.conviction?.phase === 'Forming' ? 1 : 0;
      return (
        rank(b) - rank(a) ||
        (b.conviction?.score ?? 0) - (a.conviction?.score ?? 0) ||
        (b.conviction?.heldMin ?? 0) - (a.conviction?.heldMin ?? 0)
      );
    });
  return out;
}

/** NSE symbols carry `&` (GVT&D) and `-` (BAJAJ-AUTO), so both are allowed. */
export function parseSymbol(raw: unknown): string {
  const s = String(raw ?? '').trim().toUpperCase();
  if (!s) throw new ValidationError(['symbol is required']);
  if (!/^[A-Z0-9&._-]{1,30}$/.test(s)) throw new ValidationError([`"${s}" is not a valid NSE symbol`]);
  return s;
}

/* ------------------------------------------------------------------ config patch --- */

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function checkKnots(path: string, v: unknown, issues: string[]): void {
  if (!Array.isArray(v)) {
    issues.push(`${path} must be an array of {at, score}`);
    return;
  }
  if (!v.length) {
    issues.push(`${path} must have at least one knot`);
    return;
  }
  v.forEach((k, i) => {
    if (!isPlainObject(k) || !Number.isFinite(Number(k.at)) || !Number.isFinite(Number(k.score)))
      issues.push(`${path}[${i}] must be {at: number, score: number}`);
    else if (Number(k.score) < 0 || Number(k.score) > 100)
      issues.push(`${path}[${i}].score must be 0–100`);
  });
}

/** A key whose value should be a knot list, wherever it appears in the thresholds tree. */
const looksLikeKnotList = (v: unknown): boolean =>
  Array.isArray(v) && v.length > 0 && isPlainObject(v[0]) && 'at' in (v[0] as object) && 'score' in (v[0] as object);

function walkThresholds(node: unknown, path: string, issues: string[]): void {
  if (!isPlainObject(node)) return;
  for (const [k, v] of Object.entries(node)) {
    const p = `${path}.${k}`;
    if (Array.isArray(v)) {
      if (looksLikeKnotList(v) || /knots|Bps|Cr|Pct|rank|premium|Notional|Shift$/i.test(k)) checkKnots(p, v, issues);
      else issues.push(`${p} is an unexpected array`);
    } else if (isPlainObject(v)) {
      walkThresholds(v, p, issues);
    } else if (typeof v === 'number' && !Number.isFinite(v)) {
      issues.push(`${p} must be a finite number`);
    } else if (typeof v !== 'number' && typeof v !== 'string' && typeof v !== 'boolean') {
      issues.push(`${p} has an unsupported type`);
    }
  }
}

/**
 * Every leaf under `node` must be a finite number or a boolean, at any depth.
 *
 * Recursive rather than one level deep, which is what it was: `signal.trend` nests two levels
 * (`signal.trend.strike.minDelta`) and a flat walk rejected the whole trend block as
 * "not a number" — a validation failure that would have looked like a server bug from an admin
 * panel and had nothing to do with the value being sent.
 */
function walkScalars(node: Record<string, unknown>, path: string, issues: string[], depth = 0): void {
  if (depth > 4) {
    issues.push(`${path} is nested too deeply to be a config value`);
    return;
  }
  for (const [k, v] of Object.entries(node)) {
    const at = `${path}.${k}`;
    if (isPlainObject(v)) walkScalars(v, at, issues, depth + 1);
    else if (typeof v === 'boolean') continue;
    else if (typeof v !== 'number' || !Number.isFinite(v))
      issues.push(`${at} must be a finite number or a boolean`);
  }
}

/**
 * Validate a PATCH — every field is optional, but any field present must be well-formed.
 *
 * Unknown top-level keys are rejected rather than ignored: a typo in an admin panel that
 * silently does nothing is worse than an error, because the operator believes the change
 * took effect and the ranking they are looking at is not the one they configured.
 */
export function parseConfigPatch(body: unknown): DeepPartial<MomentumConfig> {
  if (!isPlainObject(body)) throw new ValidationError(['body must be a JSON object']);

  const issues: string[] = [];
  const allowed = new Set([
    'weights', 'scoring', 'confidence', 'thresholds', 'universe', 'refresh', 'output', 'signal',
    'ranking',
    // Accepted and ignored: an admin panel that GETs the config and PUTs it back should not
    // be rejected for echoing the fields the server owns.
    'version', 'updatedAt', 'updatedBy',
  ]);

  for (const key of Object.keys(body)) if (!allowed.has(key)) issues.push(`unknown field "${key}"`);

  if ('weights' in body) {
    const w = body.weights;
    if (!isPlainObject(w)) issues.push('weights must be an object');
    else {
      let sum = 0;
      for (const [k, v] of Object.entries(w)) {
        if (!FACTOR_KEYS.includes(k as FactorKey)) { issues.push(`weights.${k} is not a factor`); continue; }
        const n = Number(v);
        if (!Number.isFinite(n) || n < 0) issues.push(`weights.${k} must be a number ≥ 0`);
        else sum += n;
      }
      // Weights need not total 100 — the engine normalises — but all-zero is not a model.
      if (Object.keys(w).length === FACTOR_KEYS.length && sum === 0)
        issues.push('weights cannot all be zero');
    }
  }

  if ('thresholds' in body) walkThresholds(body.thresholds, 'thresholds', issues);

  if ('scoring' in body && isPlainObject(body.scoring)) {
    const s = body.scoring;
    if ('maxScore' in s && (Number(s.maxScore) <= 0 || !Number.isFinite(Number(s.maxScore))))
      issues.push('scoring.maxScore must be > 0');
    if (isPlainObject(s.coherence) && 'maxPenalty' in s.coherence) {
      const p = Number(s.coherence.maxPenalty);
      if (!Number.isFinite(p) || p < 0 || p >= 1) issues.push('scoring.coherence.maxPenalty must be 0 ≤ p < 1');
    }
  }

  if ('universe' in body && isPlainObject(body.universe)) {
    const u = body.universe;
    if ('exclude' in u && !Array.isArray(u.exclude)) issues.push('universe.exclude must be an array of symbols');
    if ('shortlistSize' in u) {
      const n = Number(u.shortlistSize);
      if (!Number.isFinite(n) || n < 0) issues.push('universe.shortlistSize must be ≥ 0');
      // Not an error — the operator may know what they are doing — but the cost is linear
      // and the ceiling is real, so it is worth refusing the obviously unpayable.
      if (n > 208) issues.push('universe.shortlistSize cannot exceed the 208-stock F&O universe');
    }
  }

  if ('refresh' in body && isPlainObject(body.refresh)) {
    const r = body.refresh;
    if ('quoteMs' in r && Number(r.quoteMs) < 5000)
      issues.push('refresh.quoteMs below 5000 would exceed the Upstox rate limit');
    if ('enrichMs' in r && Number(r.enrichMs) < 15000)
      issues.push('refresh.enrichMs below 15000 would exceed the Upstox option-chain rate limit');
    // The timing layer's resolution is the poll interval. Said as an issue rather than
    // silently accepted, because a 3-minute ignition window sampled every 2 minutes is two
    // readings and every trigger it fires is already most of a window late.
    if ('quoteMs' in r && Number(r.quoteMs) > 60_000)
      issues.push('refresh.quoteMs above 60000 leaves the timing layer too few readings to detect an entry');
  }

  if ('signal' in body) {
    if (!isPlainObject(body.signal)) issues.push('signal must be an object');
    else walkScalars(body.signal, 'signal', issues);
  }

  if ('ranking' in body) {
    if (!isPlainObject(body.ranking)) issues.push('ranking must be an object');
    else {
      walkScalars(body.ranking, 'ranking', issues);
      const r = body.ranking;
      if ('convictionWeight' in r) {
        const n = Number(r.convictionWeight);
        if (!Number.isFinite(n) || n < 0 || n > 1) issues.push('ranking.convictionWeight must be 0 ≤ w ≤ 1');
      }
    }
  }

  if (issues.length) throw new ValidationError(issues);

  // The server owns provenance; a client cannot set its own version or author.
  const { version: _v, updatedAt: _a, updatedBy: _b, ...patch } = body as Record<string, unknown>;
  return patch as DeepPartial<MomentumConfig>;
}

/**
 * The alert panel's patch - four settings, and every one of them optional.
 *
 * Stricter than `parseConfigPatch` on purpose. That endpoint edits a scoring model whoever opens
 * it is expected to understand in detail, so it validates the shape and lets the repository
 * repair the values; this one is wired to two switches and two sliders, and a floor arriving as
 * "82%" or 8200 should come back as an error naming the field rather than as a channel that
 * quietly stops alerting. The gates ignore anything outside 0-100, so an accepted nonsense value
 * would not be obeyed - it would simply be invisible.
 */
export function parseAlertSettingsPatch(body: unknown): AlertSettingsPatch {
  if (!isPlainObject(body)) throw new ValidationError(['body must be a JSON object']);

  const issues: string[] = [];
  const patch: AlertSettingsPatch = {};

  for (const key of Object.keys(body))
    if (key !== 'trendDay' && key !== 'ignition') issues.push(`unknown field "${key}"`);

  const bool = (v: unknown, path: string): boolean | undefined => {
    if (v === undefined) return undefined;
    if (typeof v === 'boolean') return v;
    // 'on'/'off' accepted because that is what the env file uses, and anyone reaching this API
    // after reading .env will reach for them.
    const s = String(v).trim().toLowerCase();
    if (s === 'on' || s === 'true') return true;
    if (s === 'off' || s === 'false') return false;
    issues.push(`${path} must be true or false`);
    return undefined;
  };

  const floor = (v: unknown, path: string): number | undefined => {
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > 100) {
      issues.push(`${path} must be a number between 0 and 100`);
      return undefined;
    }
    // Rounded rather than refused: both scores are integers everywhere they are produced and
    // compared, so an 82.5 off a slider is a precision the model does not have, not an error.
    return Math.round(n);
  };

  if ('trendDay' in body) {
    const t = body.trendDay;
    if (!isPlainObject(t)) issues.push('trendDay must be an object');
    else {
      const enabled = bool(t.enabled, 'trendDay.enabled');
      const minConviction = floor(t.minConviction, 'trendDay.minConviction');
      patch.trendDay = {
        ...(enabled === undefined ? {} : { enabled }),
        ...(minConviction === undefined ? {} : { minConviction }),
      };
    }
  }

  if ('ignition' in body) {
    const g = body.ignition;
    if (!isPlainObject(g)) issues.push('ignition must be an object');
    else {
      const enabled = bool(g.enabled, 'ignition.enabled');
      const minEntryQuality = floor(g.minEntryQuality, 'ignition.minEntryQuality');
      patch.ignition = {
        ...(enabled === undefined ? {} : { enabled }),
        ...(minEntryQuality === undefined ? {} : { minEntryQuality }),
      };
    }
  }

  if (issues.length) throw new ValidationError(issues);
  return patch;
}

/** Re-exported for the controller's error mapping. */
export const isValidationError = (e: unknown): e is ValidationError => e instanceof ValidationError;

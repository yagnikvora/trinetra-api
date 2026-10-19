// The candidate log records what the displacement rule REFUSED, which is the half of the morning
// nothing else keeps. Two properties decide whether it is worth having at all, and both are here.
//
// It must agree with `selectDisplacement` on how a reading is computed — the log exists to be
// compared against the rule, and a log that measures RVOL or "off the extreme" differently is
// worse than none, because it would quietly answer a threshold question wrongly.
//
// And it must never be able to break a scan. Every entry point swallows its own errors, so the
// tests feed it malformed input and assert the scan-side call simply returns.

import { strict as assert } from 'node:assert';
import { beforeEach, describe, it } from 'node:test';

import {
  candidateState, markTaken, observeCandidates, resetCandidates, __readingsForTest,
} from '../src/momentum/alerts/candidates.js';
import { selectDisplacement, type DisplacementInput } from '../src/momentum/alerts/displacement.js';

const RULE = {
  fromMinute: 12, toMinute: 45,
  minRvol: 5, maxRvol: 50, minTurnoverCr: 100,
  minRangeAtr: 1.0, minMoveAtr: 0.5, maxOffExtremeAtr: 0.35,
  maxPerDay: 4,
};

/** 2026-08-27, 09:30 IST — inside the window. */
const NOW = Date.parse('2026-08-27T04:00:00Z');

function input(over: Partial<{ symbol: string; rvol: number; atr: number; turnover: number; ltp: number; open: number; high: number; low: number; vwap: number; adv: number }> = {}): DisplacementInput {
  const o = {
    symbol: 'TEST', rvol: 8, atr: 10, turnover: 400, ltp: 120, open: 100,
    high: 121, low: 99, vwap: 110, adv: 500, ...over,
  };
  return {
    symbol: o.symbol,
    equityKey: 'NSE_EQ|TEST',
    atr: o.atr,
    avgDailyValueCr: o.adv,
    rvol: o.rvol,
    lotSize: 100,
    quote: {
      symbol: o.symbol, ltp: o.ltp, open: o.open, high: o.high, low: o.low,
      vwap: o.vwap, turnoverCr: o.turnover, prevClose: 100, changePct: 5,
    },
  } as unknown as DisplacementInput;
}

describe('candidate log', () => {
  beforeEach(() => resetCandidates());

  it('records a symbol the rule refused, which is the whole point', () => {
    // Passes turnover and RVOL, fails "off the extreme" — so it never becomes a candidate.
    const far = input({ symbol: 'FARAWAY', ltp: 110, high: 130 });
    assert.equal(selectDisplacement([far], new Set(), 20, RULE as never).length, 0, 'rule should refuse it');

    observeCandidates([far], 20, RULE, NOW);
    assert.equal(candidateState().symbols, 1, 'the log should still have kept it');
  });

  it('agrees with selectDisplacement on the gate readings', () => {
    const i = input({ symbol: 'AGREE' });
    const picked = selectDisplacement([i], new Set(), 20, RULE as never);
    assert.equal(picked.length, 1);

    observeCandidates([i], 20, RULE, NOW);
    // [minute, rvol, rangeAtr, moveAtr, offExtremeAtr, turnoverCr, ltp, direction]
    const tick = (candidateState().symbols === 1) && logged('AGREE')[0];
    assert.ok(tick);
    assert.equal(tick[0], 20);
    assert.ok(Math.abs(tick[2] - picked[0].rangeAtr) < 0.01, 'rangeAtr must match the rule');
    assert.ok(Math.abs(tick[3] - picked[0].moveAtr) < 0.01, 'moveAtr must match the rule');
    assert.ok(Math.abs(tick[4] - picked[0].offExtremeAtr) < 0.01, 'offExtremeAtr must match the rule');
    assert.equal(tick[7], picked[0].direction, 'direction must match the rule');
  });

  it('keeps near misses below the floor so a threshold can be lowered too', () => {
    observeCandidates([input({ symbol: 'NEAR', rvol: 3.8 })], 20, RULE, NOW);   // 0.76x of 5
    observeCandidates([input({ symbol: 'FAR', rvol: 1.2 })], 20, RULE, NOW);    // nowhere near
    const syms = loggedSymbols();
    assert.ok(syms.includes('NEAR'), 'a near miss is the sample a threshold study needs');
    assert.ok(!syms.includes('FAR'), 'a stock at a quarter of the floor is noise');
  });

  it('drops anything below the turnover gate, whatever its RVOL', () => {
    observeCandidates([input({ symbol: 'ILLIQUID', adv: 20, rvol: 30 })], 20, RULE, NOW);
    assert.equal(candidateState().symbols, 0);
  });

  it('ignores ticks outside the window', () => {
    observeCandidates([input()], 5, RULE, NOW);
    observeCandidates([input()], 90, RULE, NOW);
    assert.equal(candidateState().symbols, 0);
  });

  it('marks what was taken, and keeps the first minute it fired', () => {
    observeCandidates([input({ symbol: 'TAKEN' })], 20, RULE, NOW);
    markTaken([{ symbol: 'TAKEN', minute: 20 }], NOW);
    markTaken([{ symbol: 'TAKEN', minute: 33 }], NOW);
    assert.equal(candidateState().taken, 1);
  });

  it('never throws, whatever it is handed', () => {
    assert.doesNotThrow(() => observeCandidates([null as never], 20, RULE, NOW));
    assert.doesNotThrow(() => observeCandidates(undefined as never, 20, RULE, NOW));
    assert.doesNotThrow(() => markTaken(undefined as never, NOW));
  });
});

/* --------------------------------------------------------------------------- helpers --- */
// `candidateState` deliberately exposes counts rather than the log itself, so these reach in
// through the same module rather than widening the public surface for a test.

import { __ticksForTest } from '../src/momentum/alerts/candidates.js';
const logged = (symbol: string) => __ticksForTest(symbol);
const loggedSymbols = () => __ticksForTest();

describe('candidate log — the readings', () => {
  beforeEach(() => resetCandidates());

  it('takes them on arrival, once more on first reaching the floor, and never after', () => {
    observeCandidates([input({ symbol: 'LATE', rvol: 4 })], 13, RULE, NOW);      // in contention, below 5
    assert.deepEqual(
      [__readingsForTest('LATE')?.minute, __readingsForTest('LATE')?.atFloor], [13, false],
    );
    observeCandidates([input({ symbol: 'LATE', rvol: 4.5 })], 14, RULE, NOW);    // still below: kept as is
    assert.equal(__readingsForTest('LATE')?.minute, 13);
    observeCandidates([input({ symbol: 'LATE', rvol: 6 })], 15, RULE, NOW);      // reaches the floor
    assert.deepEqual(
      [__readingsForTest('LATE')?.minute, __readingsForTest('LATE')?.atFloor], [15, true],
    );
    observeCandidates([input({ symbol: 'LATE', rvol: 9 })], 16, RULE, NOW);      // later: not retaken
    assert.equal(__readingsForTest('LATE')?.minute, 15);
  });

  it('carries the flow readings even when the tape has nothing for the symbol', () => {
    observeCandidates([input({ symbol: 'QUIET' })], 20, RULE, NOW);
    const values = __readingsForTest('QUIET')?.values ?? {};
    assert.ok('futOiOpenPct' in values && 'eqBuyPct' in values && 'vix' in values);
    assert.equal(values.futOiOpenPct, null);
  });
});

// The First-Hour Displacement alert — the selection and the message, not the delivery.
//
// This channel spends money on about three mornings in five and its losers are the full stop, so
// what is pinned down here is every way it could fire when it should not: outside the 09:27–10:00
// window, on a stock whose option nobody is quoting, on a volume print that is a corporate action
// rather than a trade, on a wide range that went nowhere, and twice on the same symbol.
//
// The direction test is the one worth reading. Direction is the side of VWAP, NOT the day's
// change, and the two disagree often enough to matter: a stock can be red against yesterday and
// trading above the average price paid for it all morning, and it is the second fact that says
// which way today is going. A regression here would buy calls on falling stocks.
//
// Nothing below touches the network, the disk or the clock. `selectDisplacement` and
// `buildMessage` are pure, which is why they are separated from `onScan`.

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  buildMessage, exits, rule, selectDisplacement,
  type DisplacementCandidate, type DisplacementInput,
} from '../src/momentum/alerts/displacement.js';
import { HTML, MARKDOWN } from '../src/alerts/markup.js';
import type { StrikeChoice } from '../src/momentum/types.js';
import type { MomentumQuote as Quote } from '../src/momentum/data/quotes.js';

/* ------------------------------------------------------------------------ fixtures --- */

/** An IST wall-clock time on Monday 24 Aug 2026, as epoch ms. */
const ist = (hh: number, mm: number): number => Date.UTC(2026, 7, 24, hh, mm) - 330 * 60_000;
const NOW = ist(9, 28);

const R = rule();

/**
 * A stock that qualifies: ₹300, ATR ₹9 (3%), opened at 291 and is at 300 having made a 9.5-rupee
 * range, on 8x volume, one tick off the high. That is 1.06 ATR of range and 1.0 ATR from the open.
 */
const quote = (over: Partial<Quote> = {}): Quote =>
  ({
    symbol: 'TESTCO', instrumentKey: 'NSE_EQ|TEST',
    ltp: 300, prevClose: 292, netChange: 8, changePct: 2.74,
    open: 291, high: 300.5, low: 291, volume: 4_000_000, vwap: 296,
    turnoverCr: 120, openInterest: 0, oiDayHigh: 0, oiDayLow: 0,
    totalBuyQty: 0, totalSellQty: 0, bid: 299.9, ask: 300.1, bidQty: 100, askQty: 100,
    bidOrders: 0, askOrders: 0, depthCr: 2, hasBook: true, at: NOW,
    ...over,
  }) as Quote;

const input = (over: Partial<DisplacementInput> = {}, q: Partial<Quote> = {}): DisplacementInput => ({
  symbol: 'TESTCO',
  equityKey: 'NSE_EQ|TEST',
  quote: quote(q),
  atr: 9,
  avgDailyValueCr: 400,
  rvol: 8,
  lotSize: 500,
  ...over,
});

const pick = (
  inputs: DisplacementInput[],
  minute = 13,
  announced: string[] = [],
): DisplacementCandidate[] => selectDisplacement(inputs, new Set(announced), minute, R);

/* ---------------------------------------------------------------------- the window --- */

describe('displacement alert — the window', () => {
  it('fires inside 09:27 to 10:00', () => {
    assert.equal(pick([input()], R.fromMinute).length, 1);
    assert.equal(pick([input()], R.toMinute).length, 1);
  });

  it('is silent before the window, when a range reading means nothing yet', () => {
    assert.equal(pick([input()], R.fromMinute - 1).length, 0);
    assert.equal(pick([input()], 0).length, 0);
  });

  it('is silent after the window — the base rate of a big move falls away past 10:00', () => {
    assert.equal(pick([input()], R.toMinute + 1).length, 0);
    assert.equal(pick([input()], 300).length, 0);
  });
});

/* ------------------------------------------------------------------- the conditions --- */

describe('displacement alert — the conditions', () => {
  it('takes a stock that clears every gate', () => {
    const [c] = pick([input()]);
    assert.equal(c.symbol, 'TESTCO');
    assert.equal(c.direction, 1);
    assert.ok(c.rangeAtr >= R.minRangeAtr, `range ${c.rangeAtr}`);
    assert.ok(c.moveAtr >= R.minMoveAtr, `move ${c.moveAtr}`);
    assert.ok(c.offExtremeAtr <= R.maxOffExtremeAtr, `off ${c.offExtremeAtr}`);
  });

  it('refuses a stock nobody trades enough of to quote an option on', () => {
    assert.equal(pick([input({ avgDailyValueCr: R.minTurnoverCr - 1 })]).length, 0);
    assert.equal(pick([input({ avgDailyValueCr: null })]).length, 0);
  });

  it('refuses ordinary volume, and refuses a print that is not a trade', () => {
    assert.equal(pick([input({ rvol: R.minRvol - 0.1 })]).length, 0);
    // POLICYBZR printed 238x on 2026-07-03. That is a corporate action, not participation.
    assert.equal(pick([input({ rvol: R.maxRvol + 1 })]).length, 0);
    assert.equal(pick([input({ rvol: null })]).length, 0);
  });

  it('refuses a day that has not made a full normal range yet', () => {
    // Same displacement, narrower range: high pulled down to 297 gives 0.67 ATR.
    assert.equal(pick([input({}, { high: 297, ltp: 296.9, low: 291 })]).length, 0);
  });

  it('refuses a wide range that resolved nowhere', () => {
    // 1.06 ATR of range, but price is back at the open, so displacement is zero.
    assert.equal(pick([input({}, { ltp: 291.2, open: 291, high: 300.5, low: 291, vwap: 291.1 })]).length, 0);
  });

  it('refuses an entry that has already given back the move', () => {
    // Range and displacement both fine, but 0.6 ATR back off the high.
    const c = pick([input({}, { ltp: 295.1, high: 300.5, low: 291, vwap: 293 })]);
    assert.equal(c.length, 0);
  });

  it('refuses a symbol with no ATR — every level in the message is a multiple of it', () => {
    assert.equal(pick([input({ atr: null })]).length, 0);
    assert.equal(pick([input({ atr: 0 })]).length, 0);
  });

  it('refuses a symbol with no VWAP yet, rather than guessing a direction', () => {
    assert.equal(pick([input({}, { vwap: 0 })]).length, 0);
  });

  it('refuses a symbol whose baseline reading was carried from an earlier day', () => {
    // Every gate is a multiple of ATR, so a stale ATR moves all four thresholds at once. On
    // 2026-08-20 the 08:00 build was rate limited and 128 of 208 symbols were carried; their ATR
    // was out by a median 4.3% against 0.6% for the symbols built that morning.
    assert.equal(pick([input({ baselineCarriedFrom: '2026-08-16' })]).length, 0);
  });

  it('takes a symbol whose baseline was built today', () => {
    assert.equal(pick([input({ baselineCarriedFrom: null })]).length, 1);
    assert.equal(pick([input({ baselineCarriedFrom: undefined })]).length, 1);
  });
});

/* -------------------------------------------------------------------- the direction --- */

describe('displacement alert — direction is the side of VWAP, not the day', () => {
  it('buys a put on a stock below its VWAP', () => {
    const [c] = pick([input({}, {
      ltp: 282, open: 291, high: 291, low: 281.5, vwap: 286, prevClose: 292, changePct: -3.42,
    })]);
    assert.equal(c.direction, -1);
    assert.ok(c.moveAtr >= R.minMoveAtr);
  });

  it('buys a call on a stock that is RED on the day but above its VWAP all morning', () => {
    // Gapped down to 280, ran to 291. Change on the day is negative; the session is bullish.
    const [c] = pick([input({}, {
      ltp: 291, open: 280, high: 291.2, low: 280, vwap: 286, prevClose: 300, changePct: -3.0,
    })]);
    assert.equal(c.direction, 1, 'a stock above its VWAP is a call however red the day is');
  });

  it('measures displacement in the trade direction, so a fall is a positive reading', () => {
    const [c] = pick([input({}, {
      ltp: 282, open: 291, high: 291, low: 281.5, vwap: 286, prevClose: 292, changePct: -3.42,
    })]);
    assert.ok(c.moveAtr > 0, `a bearish setup should report positive displacement, got ${c.moveAtr}`);
  });
});

/* ------------------------------------------------------------------- once per symbol --- */

describe('displacement alert — never twice', () => {
  it('skips a symbol already announced today, in either direction', () => {
    assert.equal(pick([input()], 13, ['TESTCO']).length, 0);
  });

  it('orders the tick by relative volume, strongest first', () => {
    const picked = pick([
      input({ symbol: 'WEAK', rvol: 5.5 }),
      input({ symbol: 'STRONG', rvol: 19 }),
      input({ symbol: 'MID', rvol: 9 }),
    ]);
    assert.deepEqual(picked.map((c) => c.symbol), ['STRONG', 'MID', 'WEAK']);
  });
});

/* ---------------------------------------------------------------------- the message --- */

const strike = (over: Partial<StrikeChoice> = {}): StrikeChoice =>
  ({
    strike: 300, type: 'CE', label: '300 CE', instrumentKey: 'NSE_FO|1',
    expiry: '2026-08-27', expiryDays: 12, stepsFromAtm: 0, moneyness: 'ATM',
    premium: 9.8, entryCost: 10, bid: 9.6, ask: 10, spreadPct: 2.1,
    delta: 0.5, gamma: 0.01, iv: 30, thetaPctPerHour: 1.4, oi: 90_000, volume: 30_000,
    lotSize: 500, costPerLot: 5000, premiumAtTarget: 16.2, gainPctAtTarget: 62,
    profitPerLot: 3100, reason: 'at the money', warnings: [],
    ...over,
  }) as StrikeChoice;

describe('displacement alert — the message', () => {
  const [c] = pick([input()]);

  // The checkpoint levels are TUNED and move whenever the study is re-run. Pin them here so these
  // tests cover the arithmetic and the wording, and let the one test below own the shipped values.
  // Without this, retuning the rule fails a formatting test, which says nothing about formatting.
  const pinned = <T>(fn: () => T): T => {
    const before = [process.env.DISPLACEMENT_ARM_AT_PCT, process.env.DISPLACEMENT_LOCK_PCT];
    process.env.DISPLACEMENT_ARM_AT_PCT = '24';
    process.env.DISPLACEMENT_LOCK_PCT = '2';
    try {
      return fn();
    } finally {
      [process.env.DISPLACEMENT_ARM_AT_PCT, process.env.DISPLACEMENT_LOCK_PCT] = before as [string, string];
      if (before[0] === undefined) delete process.env.DISPLACEMENT_ARM_AT_PCT;
      if (before[1] === undefined) delete process.env.DISPLACEMENT_LOCK_PCT;
    }
  };

  it('states the exits as premium prices, which need no model', () => {
    const text = pinned(() => buildMessage(c, strike(), MARKDOWN, NOW));
    // entryCost 10 -> checkpoint arms at 12.40, stop parks at 10.20, target 18.00, hard stop 5.00
    assert.match(text, /touches ₹12\.40/);
    assert.match(text, /MOVE STOP to ₹10\.20/);
    assert.match(text, /SELL ALL at ₹18\.00/);
    assert.match(text, /STOP at ₹5\.00/);
  });

  it('sells the whole position at the target rather than scaling out', () => {
    // The scale-out this replaced graded worst of every shape tested on the 78 real trades:
    // booking half caps the rare full winners that carry the book and pays charges twice.
    const text = buildMessage(c, strike(), MARKDOWN, NOW);
    assert.doesNotMatch(text, /SELL HALF/);
    assert.doesNotMatch(text, /REST at/);
  });

  it('carries the contract, the lot and what one lot costs', () => {
    const text = buildMessage(c, strike(), MARKDOWN, NOW);
    assert.match(text, /BUY 300 CE/);
    assert.match(text, /× 500/);
    assert.match(text, /₹5,000\*\* per lot/);
  });

  it('never emits two adjacent italic markers, which collapse into bold in Discord', () => {
    const md = buildMessage(c, strike(), MARKDOWN, NOW);
    assert.ok(!md.includes('__'), `adjacent italic spans found: ${md}`);
    const html = buildMessage(c, strike(), HTML, NOW);
    assert.ok(!html.includes('</i><i>'), 'adjacent italic tags found');
  });

  it('gives an approximate stock level off the delta, labelled as approximate', () => {
    const text = pinned(() => buildMessage(c, strike(), MARKDOWN, NOW));
    // +24% of a ₹10 premium is ₹2.40, and at delta 0.5 that is ₹4.80 of underlying: 300 -> 304.80.
    assert.match(text, /stock ≈ ₹304\.80/);
  });

  it('states the readings that fired it, so the reader can disagree', () => {
    const text = buildMessage(c, strike(), MARKDOWN, NOW);
    assert.match(text, /RVOL 8\.0×/);
    assert.match(text, /ATR of range already made/);
    assert.match(text, /from the open ₹291\.00/);
  });

  it('still sends when no chain was available, with the rule in words', () => {
    const text = pinned(() => buildMessage(c, null, MARKDOWN, NOW));
    assert.match(text, /No option chain this cycle/);
    assert.match(text, /once up \+24% move the stop to \+2%/);
    assert.match(text, /Sell all at \+80%/);
    assert.match(text, /hard stop −50%/);
    assert.match(text, /lot is 500/);
  });

  it('says what this channel is worth, every single time', () => {
    for (const m of [HTML, MARKDOWN]) {
      const text = buildMessage(c, strike(), m, NOW);
      assert.match(text, /60% of these end profitable/);
      assert.match(text, /Not statistically proven/);
      assert.match(text, /size for the day, not the trade/);
    }
  });

  it('renders in both markups without leaking the other one', () => {
    const html = buildMessage(c, strike(), HTML, NOW);
    const md = buildMessage(c, strike(), MARKDOWN, NOW);
    assert.match(html, /<b>/);
    assert.ok(!md.includes('<b>'), 'the Discord message must not carry HTML tags');
  });

  it('escapes a symbol that would otherwise break the markup', () => {
    const odd = { ...c, symbol: 'GVT&D' };
    const html = buildMessage(odd, strike(), HTML, NOW);
    assert.ok(html.includes('GVT&amp;D'), 'an ampersand must be escaped for Telegram HTML');
  });

  it('surfaces a strike warning rather than hiding it', () => {
    const text = buildMessage(c, strike({ warnings: ['quoted 7.2% wide'] }), MARKDOWN, NOW);
    assert.match(text, /quoted 7\.2% wide/);
  });
});

/* ---------------------------------------------------------------------- the numbers --- */

describe('displacement alert — the rule as shipped', () => {
  it('ships the thresholds the 35-session study settled on', () => {
    assert.equal(R.minRvol, 5);
    assert.equal(R.maxRvol, 50);
    assert.equal(R.minRangeAtr, 1);
    assert.equal(R.minMoveAtr, 0.5);
    assert.equal(R.maxOffExtremeAtr, 0.35);
    assert.equal(R.minTurnoverCr, 100);
    assert.equal(R.maxPerDay, 4);
    // 09:27 and 10:00 in minutes past 09:15.
    assert.equal(R.fromMinute, 12);
    assert.equal(R.toMinute, 45);
  });

  // The one place the tuned checkpoint is pinned. Changing it should fail exactly this assertion,
  // and the failure should be read as "confirm the study, then update the number" rather than as
  // a bug. Switched OFF 2026-09-19: on all 194 journalled trades (1 Jul - 18 Sep), each on its own
  // archived minute path, plain +80/-50 nets Rs1,70,226 and arming +6% at +24% nets Rs1,52,977.
  // The 78-trade result that switched it on (2026-08-30) did not survive the larger sample.
  // Read with the env CLEARED, so this pins what the code ships rather than what the local `.env`
  // happens to say — `.env` is gitignored and differs per machine, and a test that depends on it
  // passes or fails for reasons that have nothing to do with the commit.
  it('ships with the checkpoint off: sell all at +80% or 15:15, hard stop -50%', () => {
    const keys = ['DISPLACEMENT_ARM_AT_PCT', 'DISPLACEMENT_LOCK_PCT', 'DISPLACEMENT_TP2_PCT', 'DISPLACEMENT_SL_PCT'];
    const before = keys.map((k) => process.env[k]);
    for (const k of keys) delete process.env[k];
    try {
      const e = exits();
      assert.equal(e.armAt, 0);
      assert.equal(e.second, 0.80);
      assert.equal(e.stop, 0.50);
      // With the checkpoint off the message must not tell anyone to move a stop.
      const text = buildMessage(pick([input()])[0], strike(), MARKDOWN, NOW);
      assert.doesNotMatch(text, /MOVE STOP/);
      assert.match(text, /①.*SELL ALL at ₹18\.00/);
    } finally {
      keys.forEach((k, i) => { if (before[i] !== undefined) process.env[k] = before[i]; });
    }
  });
});

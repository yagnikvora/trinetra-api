// The flow tape: futures OI, order-book totals and India VIX, minute by minute, read back as journal
// readings.
//
// What is pinned down here is the part that fails silently. A window that quietly measured from the
// wrong minute, or reported a change across a restart as if the tape had been running, would put
// confident numbers on journal rows that a study weeks later would trust. So:
//
//   the windows measure from the right minute     15m and 5m against the point at or before
//   no history means null, not zero               a window the tape does not reach is unknown
//   a dead feed reads null                        a stale last point is not "unchanged"
//   a restart has no "open"                       the first print must be at the open to count
//   a new day starts clean                        yesterday's points never leak into today
//   the journal carries it                        recordEntries writes the fields onto the row

import { strict as assert } from 'node:assert';
import { beforeEach, describe, it } from 'node:test';

import {
  bookReadings, chainOiReadings, oiReadings, recordBookTape, recordFuturesTape, recordVixTape,
  resetFlowTape, vixReadings,
} from '../src/momentum/data/flow-tape.js';
import type { StockChain } from '../src/momentum/data/option-chain.js';
import { recordEntries, setJournalRepository } from '../src/momentum/journal/journal.js';
import type { JournalRepository } from '../src/momentum/journal/repository.js';
import type { JournalTrade } from '../src/momentum/journal/types.js';

/** Epoch ms for a session minute (0 = 09:15 IST) on a given day. */
const at = (minute: number, day = '2026-09-21'): number => Date.parse(`${day}T09:15:00+05:30`) + minute * 60_000;

/** OI rises by 10 contracts a minute from 1,000; price by ₹1 a minute from 100; book 60/40. */
function fill(symbol: string, from: number, to: number, day?: string): void {
  for (let m = from; m <= to; m++) {
    recordFuturesTape(symbol, { oi: 1000 + 10 * m, price: 100 + m, buy: 600, sell: 400 }, 900, at(m, day));
  }
}

const close = (a: number | null, b: number): void => {
  assert.ok(a !== null, 'expected a number, got null');
  assert.ok(Math.abs(a - b) < 0.001, `expected ${b}, got ${a}`);
};

const nothing = (r: Record<string, number | null>): void =>
  assert.deepEqual(Object.values(r).filter((v) => v !== null), []);

describe('flow tape: futures OI', () => {
  beforeEach(() => resetFlowTape());

  it('measures 15m, 5m, since-open and since-yesterday from the right minutes', () => {
    fill('ABC', 0, 20);
    const r = oiReadings('ABC', at(20));
    assert.equal(r.futOi, 1200);
    close(r.futOiDayPct, ((1200 - 900) / 900) * 100);
    close(r.futOiOpenPct, ((1200 - 1000) / 1000) * 100);
    close(r.futPxOpenPct, ((120 - 100) / 100) * 100);
    close(r.futOi15mPct, ((1200 - 1050) / 1050) * 100);
    close(r.futPx15mPct, ((120 - 105) / 105) * 100);
    close(r.futOi5mPct, ((1200 - 1150) / 1150) * 100);
    close(r.futBuyPct, 60);
  });

  it('keeps the last reading of a minute, like a candle close', () => {
    recordFuturesTape('ABC', { oi: 1000, price: 100 }, 900, at(0));
    recordFuturesTape('ABC', { oi: 1100, price: 101 }, 900, at(10));
    recordFuturesTape('ABC', { oi: 1300, price: 103 }, 900, at(10) + 30_000);
    assert.equal(oiReadings('ABC', at(10) + 40_000).futOi, 1300);
  });

  it('reads null for a window the tape does not reach back to', () => {
    fill('ABC', 0, 3);
    const r = oiReadings('ABC', at(3));
    assert.equal(r.futOi15mPct, null);
    assert.equal(r.futOi5mPct, null);
    assert.ok(r.futOiOpenPct !== null, 'since-open is answerable from minute 0');
  });

  it('reads null everywhere when the feed has gone quiet', () => {
    fill('ABC', 0, 10);
    nothing(oiReadings('ABC', at(20)));
  });

  it('has no "since open" when the tape started mid-session, as after a restart', () => {
    fill('ABC', 30, 50);
    const r = oiReadings('ABC', at(50));
    assert.equal(r.futOiOpenPct, null);
    assert.equal(r.futPxOpenPct, null);
    assert.ok(r.futOi15mPct !== null, 'the 15-minute window is still answerable');
  });

  it('keeps the open reading after the rolling window has trimmed it', () => {
    fill('ABC', 0, 100);
    close(oiReadings('ABC', at(100)).futOiOpenPct, ((2000 - 1000) / 1000) * 100);
  });

  it('starts a new day clean, previous-close OI included', () => {
    fill('ABC', 0, 20, '2026-09-21');
    assert.equal(oiReadings('ABC', at(5, '2026-09-22')).futOi, null);
    recordFuturesTape('ABC', { oi: 1000, price: 100 }, null, at(0, '2026-09-22'));
    assert.equal(oiReadings('ABC', at(0, '2026-09-22')).futOiDayPct, null, 'yesterday\'s reference must not carry over');
  });

  it('ignores a reading with no open interest', () => {
    recordFuturesTape('ABC', { oi: 0, price: 100 }, 900, at(0));
    assert.equal(oiReadings('ABC', at(0)).futOi, null);
  });
});

describe('flow tape: the order book', () => {
  beforeEach(() => resetFlowTape());

  it('reports the buy share now and how it moved over 5 and 15 minutes', () => {
    // Buyers fade from 70% of the book to 40% over 20 minutes.
    for (let m = 0; m <= 20; m++) recordBookTape('ABC', 700 - 15 * m, 300 + 15 * m, at(m));
    const r = bookReadings('ABC', at(20));
    assert.equal(r.eqBuyQty, 400);
    assert.equal(r.eqSellQty, 600);
    close(r.eqBuyPct, 40);
    close(r.eqBuyPct5mChg, 40 - 47.5);
    close(r.eqBuyPct15mChg, 40 - 62.5);
  });

  it('ignores an empty book and reads null without history', () => {
    recordBookTape('ABC', 0, 0, at(0));
    nothing(bookReadings('ABC', at(0)));
    recordBookTape('ABC', 500, 500, at(1));
    const r = bookReadings('ABC', at(1));
    close(r.eqBuyPct, 50);
    assert.equal(r.eqBuyPct5mChg, null);
  });
});

describe('flow tape: India VIX', () => {
  beforeEach(() => resetFlowTape());

  it('reports the level, the day change and the 15-minute change', () => {
    for (let m = 0; m <= 20; m++) recordVixTape(12 + 0.1 * m, 12, at(m));
    const r = vixReadings(at(20));
    close(r.vix, 14);
    close(r.vixDayPct, ((14 - 12) / 12) * 100);
    close(r.vix15mPct, ((14 - 12.5) / 12.5) * 100);
  });

  it('reads null when the VIX feed has gone quiet', () => {
    recordVixTape(13, 12, at(0));
    nothing(vixReadings(at(10)));
  });
});

describe('flow tape: the option chain', () => {
  const leg = (oi: number, prevOi: number) => ({
    instrumentKey: 'k', ltp: 1, closePrice: 1, volume: 0, oi, prevOi,
    bid: 1, ask: 1, bidQty: 0, askQty: 0, delta: 0.5,
  });
  const chain = {
    symbol: 'ABC', underlyingKey: 'u', expiry: '2026-09-29', expiryDays: 8, spot: 100, atmStrike: 100,
    rows: [90, 95, 100, 105, 110, 115].map((strike) => ({
      strike, call: leg(200, 100), put: leg(300, 300),
    })),
  } as unknown as StockChain;

  it('reports the bought contract, the five strikes around the money, and PCR', () => {
    const r = chainOiReadings(chain, 105, 'CE');
    assert.equal(r.optOi, 200);
    close(r.optOiDayPct, 100);
    close(r.nearCallOiDayPct, 100);   // calls doubled at every strike
    close(r.nearPutOiDayPct, 0);      // puts unchanged
    close(r.pcrOi, 1.5);
  });

  it('reads the put leg for a PE and null for a strike not in the chain', () => {
    assert.equal(chainOiReadings(chain, 100, 'PE').optOi, 300);
    assert.equal(chainOiReadings(chain, 101, 'CE').optOi, null);
  });

  it('reads all null with no chain', () => {
    nothing(chainOiReadings(null, 100, 'CE'));
  });
});

describe('flow tape: the journal carries it', () => {
  it('writes the futures, book and VIX readings onto a journalled alert', async () => {
    resetFlowTape();
    fill('ABC', 0, 20);
    for (let m = 0; m <= 20; m++) {
      recordBookTape('ABC', 550, 450, at(m));
      recordVixTape(13, 12, at(m));
    }

    const saved: JournalTrade[] = [];
    const fake = {
      existing: async () => new Set<string>(),
      save: async (t: JournalTrade[]) => { saved.push(...t); },
      mine: async () => [],
    } as unknown as JournalRepository;
    setJournalRepository(fake);
    try {
      // No strike, so the row is recorded untracked and nothing subscribes to the live feed.
      await recordEntries('displacement', [{
        symbol: 'ABC', direction: 1, spot: 120, minute: 20, lotSize: 100, strike: null,
        readings: { rvol: 7 },
      }], at(20));
    } finally {
      setJournalRepository(null);
    }

    assert.equal(saved.length, 1);
    const r = saved[0].readings;
    assert.equal(r.rvol, 7, 'the channel\'s own readings survive');
    assert.equal(r.futOi, 1200);
    close(r.futOi15mPct, ((1200 - 1050) / 1050) * 100);
    close(r.eqBuyPct, 55);
    assert.equal(r.vix, 13);
    assert.ok('optOi' in r, 'the chain fields are present, even when null');
  });
});

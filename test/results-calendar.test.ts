// The results calendar — the parse, the tag, and the two answers it must never confuse.
//
// "Nobody reports today" and "the calendar could not be read" look alike and mean opposite things:
// the first is a reading of 0 on every alert, the second is a reading of null. A study that counted
// a morning NSE was unreachable as a morning with no results would dilute the one split of these
// signals that has held out of sample.
//
// Nothing below touches the network or the disk.

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  parseCalendar, previousSession, resetResultsCalendar, resultsLine, resultsReadings, resultsTags, tagFor,
} from '../src/momentum/data/results-calendar.js';
import { buildMessage, type DisplacementCandidate } from '../src/momentum/alerts/displacement.js';
import { buildMessages, type TrendDayAlert } from '../src/momentum/alerts/trend-day.js';
import { HTML, MARKDOWN } from '../src/alerts/markup.js';

/** Rows in the shape NSE answers with, trimmed to the fields that are read. */
const BODY = [
  { symbol: 'HCLTECH', purpose: 'Financial Results/Dividend', date: '12-Oct-2026' },
  { symbol: 'ANANDRATHI', purpose: 'Financial Results', date: '13-Oct-2026' },
  { symbol: 'AEQUS', purpose: 'Fund Raising', bm_desc: 'to consider results of the postal ballot', date: '13-Oct-2026' },
  { symbol: 'DMART', purpose: 'Financial Results', date: '10-Oct-2026' },
  { symbol: 'WIPRO', purpose: 'Financial Results', date: '15-Oct-2026' },
];

describe('results calendar — the parse', () => {
  it('keeps results meetings inside the range, by symbol', () => {
    assert.deepEqual(parseCalendar(BODY, '2026-10-12', '2026-10-13'), {
      HCLTECH: ['2026-10-12'],
      ANANDRATHI: ['2026-10-13'],
    });
  });

  it('reads the purpose only — a fund raising that mentions results is not a results day', () => {
    assert.equal('AEQUS' in parseCalendar(BODY, '2026-10-01', '2026-10-31')!, false);
  });

  it('reads a range nobody reports in as empty, not as a failure', () => {
    assert.deepEqual(parseCalendar([], '2026-10-12', '2026-10-13'), {});
  });

  it('refuses anything that is not the list', () => {
    assert.equal(parseCalendar(null, '2026-10-12', '2026-10-13'), null);
    assert.equal(parseCalendar({ error: 'Unauthorized' }, '2026-10-12', '2026-10-13'), null);
  });
});

describe('results calendar — the tag', () => {
  const meetings = parseCalendar(BODY, '2026-10-09', '2026-10-13')!;

  it('says the numbers are out when the board met on an earlier day', () => {
    assert.deepEqual(tagFor(meetings, 'HCLTECH', '2026-10-13'), { when: 'previous', date: '2026-10-12' });
  });

  it('says only that the board meets when the meeting is today', () => {
    assert.deepEqual(tagFor(meetings, 'ANANDRATHI', '2026-10-13'), { when: 'today', date: '2026-10-13' });
  });

  it('tags nothing else', () => {
    assert.equal(tagFor(meetings, 'RELIANCE', '2026-10-13'), null);
  });

  it('reaches back over a weekend, so a Saturday meeting tags Monday', () => {
    assert.equal(previousSession('2026-10-12'), '2026-10-09');
    assert.deepEqual(tagFor(meetings, 'DMART', '2026-10-12'), { when: 'previous', date: '2026-10-10' });
  });
});

describe('results calendar — the day it is held for', () => {
  /** 09:30 IST on the given October 2026 date. */
  const at = (d: number): number => Date.UTC(2026, 9, d, 9, 30) - 330 * 60_000;

  it('answers from the calendar it already holds, and reads an untagged stock as 0', async () => {
    resetResultsCalendar({ day: '2026-10-13', meetings: { HCLTECH: ['2026-10-12'] }, fetchedAt: at(13) });
    const tags = await resultsTags(['HCLTECH', 'RELIANCE'], at(13));
    assert.deepEqual([...tags!.keys()], ['HCLTECH']);
    assert.deepEqual(await resultsReadings('HCLTECH', at(13)), { resultsDay: 1, resultsOut: 1 });
    assert.deepEqual(await resultsReadings('RELIANCE', at(13)), { resultsDay: 0, resultsOut: 0 });
    resetResultsCalendar();
  });
});

describe('results calendar — on the alerts', () => {
  const NOW = Date.UTC(2026, 9, 13, 9, 27) - 330 * 60_000;
  const c: DisplacementCandidate = {
    symbol: 'HCLTECH', equityKey: 'NSE_EQ|X', direction: 1, entry: 1290, atr: 30, rvol: 12.6,
    rangeAtr: 1.4, moveAtr: 1.1, offExtremeAtr: 0.05, vwap: 1280, open: 1257, prevClose: 1237,
    changePct: 4.3, dayHigh: 1291.5, dayLow: 1255, turnoverCr: 310, lotSize: 350, minute: 12,
  };

  it('puts the tag on a displacement alert in both markups, and leaves an ordinary one alone', () => {
    const tag = { when: 'previous', date: '2026-10-12' } as const;
    assert.equal(resultsLine(tag), 'RESULTS DAY — board met 12 Oct, the numbers are out');
    assert.match(buildMessage(c, null, MARKDOWN, NOW, tag), /📊 \*\*RESULTS DAY — board met 12 Oct/);
    assert.match(buildMessage(c, null, HTML, NOW, tag), /📊 <b>RESULTS DAY — board met 12 Oct/);
    assert.doesNotMatch(buildMessage(c, null, MARKDOWN, NOW), /RESULTS/);
  });

  it('survives the single-alert trend-day path, which drops the block\'s first line', () => {
    const a: TrendDayAlert = {
      symbol: 'ANANDRATHI', direction: -1, price: 1990, changePct: -4.3,
      conviction: { score: 91, vwapAdherence: null, vwapCrossings: null, deepestPullbackAtr: null, heldMin: null } as TrendDayAlert['conviction'],
      plan: null, strike: null, minutesSinceExtreme: null, atrUsed: 0.9, lotSize: null,
      results: { when: 'today', date: '2026-10-13' },
    };
    assert.match(buildMessages([a], MARKDOWN, NOW).join('\n'), /RESULTS TODAY — the board meets today/);
    assert.doesNotMatch(buildMessages([{ ...a, results: null }], MARKDOWN, NOW).join('\n'), /RESULTS/);
  });
});

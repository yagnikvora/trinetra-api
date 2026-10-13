// The news read — which headlines count, what the model's answer is allowed to mean, and the
// difference between "nothing was said" and "nobody has read it yet".
//
// The second matters most. A batch the model never answered must not read as neutral, or a morning
// the free tier was down would be journalled as a morning with no news on anything.
//
// Nothing below touches the network or the disk: the model and Upstox are only reached by a sweep,
// and no test runs one.

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  buildPrompt, freshFilings, freshHeadlines, newsLine, newsRead, newsReadings, parseLabels, resetNewsSentiment, signature,
} from '../src/momentum/data/news-sentiment.js';
import { buildMessage, type DisplacementCandidate } from '../src/momentum/alerts/displacement.js';
import { MARKDOWN } from '../src/alerts/markup.js';

/** IST wall clock on 2026-10-13 as epoch ms. */
const at = (h: number, m = 0, d = 13): number => Date.UTC(2026, 9, d, h, m) - 330 * 60_000;

describe('news read — which headlines count', () => {
  const items = [
    { heading: 'HCLTech Q2 results: Net profit soars 11% QoQ', published_time: at(18, 35, 12) },
    { heading: 'Stocks to watch, Oct 13: HCLTech, RBL Bank', published_time: at(8, 23) },
    { heading: 'Stocks to watch, Oct 13: HCLTech, RBL Bank', published_time: at(8, 25) },
    { heading: 'HCL Tech Q2 preview: revenue may rise', published_time: at(8, 41, 12) },
    { heading: 'Market wrap, Oct 13', published_time: at(16, 0) },
  ];

  it('keeps what was published since the last close and before now, newest first, once each', () => {
    assert.deepEqual(freshHeadlines(items, at(15, 30, 12), at(9, 27)), [
      'Stocks to watch, Oct 13: HCLTech, RBL Bank',
      'HCLTech Q2 results: Net profit soars 11% QoQ',
    ]);
  });

  it('gives the same signature to the same set, so an unchanged stock is not asked again', () => {
    assert.equal(signature(['a', 'b']), signature(['a', 'b']));
    assert.notEqual(signature(['a', 'b']), signature(['a', 'b', 'c']));
  });

  it('lists each stock with its own items under it, the filings first and each marked by source', () => {
    assert.equal(
      buildPrompt([
        { symbol: 'HCLTECH', headlines: ['one', 'two'], filings: ['Press Release: Q2' ] },
        { symbol: 'RBLBANK', headlines: ['three'] },
      ]),
      'HCLTECH\n- [NSE filing] Press Release: Q2\n- [News] one\n- [News] two\n\nRBLBANK\n- [News] three',
    );
  });
});

describe('news read — which NSE filings count', () => {
  const rows = [
    { symbol: 'POLYCAB', desc: 'Press Release', an_dt: '13-Oct-2026 16:47:39',
      attchmntText: 'Polycab India Limited has informed the Exchange regarding a press release dated October 13, 2026, titled "Press Release on NCLAT Order".' },
    { symbol: 'POLYCAB', desc: 'Certificate under SEBI (Depositories and Participants) Regulations, 2018', an_dt: '13-Oct-2026 17:00:00',
      attchmntText: 'Polycab India Limited has informed the Exchange about Certificate under SEBI.' },
    { symbol: 'INDIGO', desc: 'Action(s) taken or orders passed', an_dt: '13-Oct-2026 18:19:53',
      attchmntText: 'InterGlobe Aviation Limited has informed the Exchange about Action(s) taken or orders passed' },
    { symbol: 'INDIGO', desc: 'General Updates', an_dt: '12-Oct-2026 11:00:00', attchmntText: 'Before the window.' },
    { symbol: 'SMALLCO', desc: 'Bagging/Receiving of orders/contracts', an_dt: '13-Oct-2026 18:00:00', attchmntText: 'Not in the universe.' },
  ];
  const got = freshFilings(rows, new Set(['POLYCAB', 'INDIGO']), at(15, 30), at(9, 0, 14));

  it('keeps what a company filed since the close, with the boilerplate opening cut off', () => {
    assert.deepEqual(got.get('POLYCAB'), [
      'Press Release: a press release dated October 13, 2026, titled "Press Release on NCLAT Order".',
    ]);
  });

  it('does not repeat a description that only restates its category', () => {
    assert.deepEqual(got.get('INDIGO'), ['Action(s) taken or orders passed']);
  });

  it('drops paperwork, filings from before the window and stocks outside the universe', () => {
    assert.equal(got.size, 2);
  });
});

describe('news read — the model\'s answer', () => {
  it('keeps well-formed labels for the stocks that were asked about', () => {
    const got = parseLabels(
      '[{"symbol":"HCLTECH","label":"positive","reason":"Strong Q2 profit"},' +
      '{"symbol":"TCS","label":"negative","reason":"not asked"},' +
      '{"symbol":"RBLBANK","label":"bullish","reason":"not a label"}]',
      ['HCLTECH', 'RBLBANK'],
    );
    assert.deepEqual([...got.entries()], [['HCLTECH', { label: 'positive', reason: 'Strong Q2 profit' }]]);
  });

  it('reads anything that is not the list as no answer at all', () => {
    assert.equal(parseLabels('Sorry, I cannot help with that.', ['HCLTECH']).size, 0);
    assert.equal(parseLabels('{"symbol":"HCLTECH","label":"positive"}', ['HCLTECH']).size, 0);
  });
});

describe('news read — the lookup', () => {
  it('tells "no headline", "not read yet" and "no sweep today" apart', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    resetNewsSentiment({
      day: '2026-10-13', sweptAt: at(8, 45),
      reads: {
        RBLBANK: { label: 'positive', reason: 'Q2 profit jumped', headlines: 3, filings: 1, sig: 'x' },
        PAYTM: { label: null, reason: '', headlines: 1, sig: 'y' },
      },
    });
    assert.deepEqual(await newsRead('RBLBANK', at(9, 27)), { label: 'positive', reason: 'Q2 profit jumped', headlines: 3, filings: 1 });
    assert.deepEqual(await newsRead('RELIANCE', at(9, 27)), { label: 'none', reason: '', headlines: 0 });
    assert.equal(await newsRead('PAYTM', at(9, 27)), null);
    resetNewsSentiment();
    delete process.env.GEMINI_API_KEY;
  });

  it('journals a read as +1, −1 or 0, and an unread stock as null rather than 0', () => {
    assert.deepEqual(newsReadings({ label: 'negative', reason: '', headlines: 2, filings: 1 }), { newsSentiment: -1, newsCount: 2, newsFilings: 1 });
    assert.deepEqual(newsReadings({ label: 'none', reason: '', headlines: 0 }), { newsSentiment: 0, newsCount: 0, newsFilings: 0 });
    assert.deepEqual(newsReadings(null), { newsSentiment: null, newsCount: null, newsFilings: null });
  });
});

describe('news read — on the alert', () => {
  const read = { label: 'negative', reason: 'NSE removed the stock from F&O', headlines: 2 } as const;

  it('says so when the news points against the trade, and stays quiet on neutral', () => {
    assert.equal(newsLine(read, -1), 'NEWS NEGATIVE — NSE removed the stock from F&O');
    assert.equal(newsLine(read, 1), 'NEWS NEGATIVE — NSE removed the stock from F&O · AGAINST this trade');
    assert.equal(newsLine({ label: 'neutral', reason: 'market wrap', headlines: 1 }, 1), null);
    assert.equal(newsLine(null, 1), null);
  });

  it('puts the line on a displacement alert only when there is one', () => {
    const c: DisplacementCandidate = {
      symbol: 'POLYCAB', equityKey: 'NSE_EQ|X', direction: 1, entry: 7000, atr: 150, rvol: 6,
      rangeAtr: 1.2, moveAtr: 1, offExtremeAtr: 0.1, vwap: 6950, open: 6850, prevClose: 6800,
      changePct: 2.9, dayHigh: 7010, dayLow: 6840, turnoverCr: 200, lotSize: 125, minute: 12,
    };
    assert.match(buildMessage(c, null, MARKDOWN, at(9, 27), null, read), /📰 _NEWS NEGATIVE — NSE removed the stock from F&O · AGAINST this trade_/);
    assert.doesNotMatch(buildMessage(c, null, MARKDOWN, at(9, 27)), /NEWS/);
  });
});

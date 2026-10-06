// The session bells — the schedule, not the sentiment.
//
// What is worth pinning down here is everything that would embarrass the channel. A greeting is
// low-stakes when it is right and expensive when it is wrong: twenty good mornings in ten minutes
// gets the bot muted, and a muted bot is the failure this whole alert stack keeps trying to avoid.
//
// So the tests are about the quiet, again: exactly one of each per day, none at a weekend, none on
// a listed holiday, and none at 11:40 because the process happened to boot then.
//
// Nothing below touches the network or the disk — `dueBell` is pure and takes the state it would
// otherwise have read, which is why it is separated from the tick in the first place.

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

import {
  dueBell, GRACE_MIN, renderBell, type BellState,
} from '../src/alerts/session-bell.js';
import { bestOf, fitness, parseBatch, usable, type Quote } from '../src/alerts/quotes.js';
import { isSessionDay, isTradingDay, marketOpen } from '../src/momentum/session.js';
import { recordEntries, setJournalRepository } from '../src/momentum/journal/journal.js';

/* ------------------------------------------------------------------------ fixtures --- */

/** An IST wall-clock time on Wednesday 12 Aug 2026, as epoch ms. */
const ist = (hh: number, mm: number): number => Date.UTC(2026, 7, 12, hh, mm) - 330 * 60_000;
/** The same clock time on Saturday 15 Aug 2026. */
const saturday = (hh: number, mm: number): number => Date.UTC(2026, 7, 15, hh, mm) - 330 * 60_000;

const FRESH: BellState = { openSentDay: null, closeSentDay: null, recent: [] };
const state = (over: Partial<BellState> = {}): BellState => ({ ...FRESH, ...over });

/** A quote the renderer can be handed, so the wording is testable without a network. */
const quote = (over: Partial<Quote> = {}): Quote =>
  ({ text: 'Discipline is the bridge between goals and accomplishment.', by: 'Jim Rohn', sourced: true, ...over });

/**
 * Run `fn` with a holiday list in place, and put the environment back afterwards.
 *
 * The variable is read on every call rather than at import, which is what makes this possible —
 * and is itself worth having, since it means adding a holiday does not need a restart.
 */
function withHolidays<T>(list: string, fn: () => T): T {
  const before = process.env.MARKET_HOLIDAYS;
  process.env.MARKET_HOLIDAYS = list;
  try {
    return fn();
  } finally {
    if (before === undefined) delete process.env.MARKET_HOLIDAYS;
    else process.env.MARKET_HOLIDAYS = before;
  }
}

/* --------------------------------------------------------------------------- tests --- */

describe('session bell: the schedule', () => {
  it('rings the open bell at 09:15', () => {
    assert.equal(dueBell(ist(9, 15), FRESH), 'open');
  });

  it('rings the close bell at 15:30', () => {
    assert.equal(dueBell(ist(15, 30), FRESH), 'close');
  });

  it('says nothing before the open', () => {
    assert.equal(dueBell(ist(9, 14), FRESH), null);
  });

  it('says nothing between the two bells', () => {
    assert.equal(dueBell(ist(12, 0), FRESH), null);
  });

  // The window is what makes a restart inside it safe. It is also what stops a process that was
  // down all morning from wishing you good morning over lunch.
  it('still rings inside the grace window', () => {
    assert.equal(dueBell(ist(9, 15 + GRACE_MIN - 1), FRESH), 'open');
  });

  it('has gone quiet once the window has passed', () => {
    assert.equal(dueBell(ist(9, 15 + GRACE_MIN), FRESH), null);
    assert.equal(dueBell(ist(11, 40), FRESH), null, 'a boot two hours late must not greet');
  });
});

describe('session bell: once a day', () => {
  // The regression this exists for: the tick runs every 30 seconds and the window is ten minutes,
  // so without the persisted record one open bell becomes twenty.
  it('does not repeat a bell already sent today', () => {
    assert.equal(dueBell(ist(9, 16), state({ openSentDay: '2026-08-12' })), null);
  });

  it('rings again the next day', () => {
    // Thursday, with Wednesday's record still on disk.
    const thursday = Date.UTC(2026, 7, 13, 9, 15) - 330 * 60_000;
    assert.equal(dueBell(thursday, state({ openSentDay: '2026-08-12' })), 'open');
  });

  it('sends the close bell even when the open bell already went', () => {
    assert.equal(dueBell(ist(15, 30), state({ openSentDay: '2026-08-12' })), 'close');
  });

  it('goes quiet once both have gone', () => {
    const both = state({ openSentDay: '2026-08-12', closeSentDay: '2026-08-12' });
    assert.equal(dueBell(ist(9, 16), both), null);
    assert.equal(dueBell(ist(15, 31), both), null);
  });
});

describe('session bell: days the market is shut', () => {
  it('says nothing at a weekend', () => {
    assert.equal(dueBell(saturday(9, 15), FRESH), null);
    assert.equal(dueBell(saturday(15, 30), FRESH), null);
  });

  // Weekday holidays are the one thing the session clock cannot work out for itself, so they come
  // from the environment. Read on every call, so setting one does not need a restart.
  it('says nothing on a listed holiday', () => {
    withHolidays('2026-08-12, 2026-10-02', () => {
      assert.equal(dueBell(ist(9, 15), FRESH), null);
      assert.equal(dueBell(ist(15, 30), FRESH), null);
    });
  });

  it('rings normally once the holiday list no longer names today', () => {
    withHolidays('2026-10-02', () => {
      assert.equal(dueBell(ist(9, 15), FRESH), 'open');
    });
  });
});

// The scanner, the journal and every cache TTL ask `marketOpen`, not the bell. On 2026-10-02 the
// bell stayed silent and the scanner did not: it read the holiday as an open session and
// journalled four 09:27 trades off the previous day's frozen book.
describe('market open: a listed holiday is a closed market', () => {
  const gandhiJayanti = (hh: number, mm: number): number => Date.UTC(2026, 9, 2, hh, mm) - 330 * 60_000;

  it('is shut all day on a holiday that falls on a weekday', () => {
    withHolidays('2026-10-02', () => {
      assert.equal(marketOpen(gandhiJayanti(9, 27)), false);
      assert.equal(marketOpen(gandhiJayanti(12, 0)), false);
      assert.equal(isTradingDay(gandhiJayanti(9, 27)), false);
      assert.equal(isSessionDay('2026-10-02'), false);
    });
  });

  it('is open on the same clock time when the day is not listed', () => {
    withHolidays('', () => {
      assert.equal(marketOpen(gandhiJayanti(9, 27)), true);
      assert.equal(isSessionDay('2026-10-02'), true);
    });
  });

  it('writes no journal row on a holiday, whatever the caller sends', async () => {
    const before = process.env.MARKET_HOLIDAYS;
    process.env.MARKET_HOLIDAYS = '2026-10-02';
    const saved: unknown[] = [];
    setJournalRepository({
      existing: async () => new Set<string>(),
      save: async (rows: unknown[]) => { saved.push(...rows); },
      mine: async () => [],
    } as never);
    try {
      await recordEntries(
        'displacement',
        [{ symbol: 'HINDPETRO', direction: -1, spot: 345, strike: null } as never],
        gandhiJayanti(9, 27),
      );
      assert.equal(saved.length, 0);
    } finally {
      setJournalRepository(null);
      if (before === undefined) delete process.env.MARKET_HOLIDAYS;
      else process.env.MARKET_HOLIDAYS = before;
    }
  });
});

// The quote picker. Nothing here touches the network: `fetchBatch` is the only part that does,
// and everything worth testing about the feature is what happens to the batch AFTER it arrives.
describe('session bell: choosing a quote', () => {
  const q = (text: string, by: string | null = 'Someone'): Quote => ({ text, by, sourced: true });

  it('rejects a quote too long for a lock screen', () => {
    assert.equal(usable(q('x'.repeat(400))), false);
  });

  it('rejects a fragment that reads as truncation', () => {
    assert.equal(usable(q('Be brave.')), false);
  });

  // ZenQuotes uses these to mean "we do not have an attribution", and an unattributed line reads
  // as the app talking to itself.
  it('rejects an unattributed quote', () => {
    assert.equal(usable(q('Discipline is the bridge between goals and accomplishment.', null)), false);
    assert.equal(usable(q('Discipline is the bridge between goals and accomplishment.', 'Unknown')), false);
    assert.equal(usable(q('Discipline is the bridge between goals and accomplishment.', 'anonymous')), false);
  });

  // The regression this filter exists for. `/api/quotes` is the whole inspirational genre, and
  // this is a real response from it — the wrong register to open a trading day on.
  it('rejects the wrong register for a bell', () => {
    assert.equal(usable(q('Grief is the price we pay for love, and it is worth paying.')), false);
  });

  // Deliberately narrow: a blocklist wide enough to catch every unwanted quote kills good ones.
  it('keeps a good quote that merely mentions fear or losing', () => {
    assert.equal(usable(q('The only thing we have to fear is fear itself, and nothing more.')), true);
  });

  it('ranks a doing-the-work quote above a merely usable one at the open', () => {
    const action = q('Discipline is the bridge between goals and accomplishment.');
    const bland = q('The quality, not the longevity, of a life is what is important.');
    assert.ok(fitness(action, 'open') > fitness(bland, 'open'));
  });

  it('ranks a reflective quote above an action one at the close', () => {
    const reflective = q('We learn the most from the mistakes we are willing to look at again.');
    const action = q('Start now. Begin the work and build the habit before you feel ready.');
    assert.ok(fitness(reflective, 'close') > fitness(action, 'close'));
  });

  it('scores anything unusable at zero', () => {
    assert.equal(fitness(q('Be brave.'), 'open'), 0);
  });

  it('picks the best fit out of a batch', () => {
    const batch = [
      q('Love is the expression of a person and their values in the world.'),
      q('Discipline is the bridge between goals and accomplishment.'),
      q('Be brave.'),
    ];
    assert.equal(bestOf(batch, 'open')?.by, 'Someone');
    assert.match(bestOf(batch, 'open')!.text, /^Discipline/);
  });

  // This is what makes "new every day" true rather than merely likely — fifty random draws from
  // ten thousand quotes will eventually serve the same line twice.
  it('skips a quote sent recently, even when it is the best fit', () => {
    const best = 'Discipline is the bridge between goals and accomplishment.';
    const batch = [q(best), q('Focus on the work in front of you and let the rest arrive later.')];
    assert.notEqual(bestOf(batch, 'open', [best])?.text, best);
  });

  it('matches the recency list past punctuation and case', () => {
    const best = 'Discipline is the bridge between goals and accomplishment.';
    assert.equal(bestOf([q(best)], 'open', ['  DISCIPLINE is the BRIDGE between goals and accomplishment!! ']), null);
  });

  it('returns null rather than something unusable when a batch has nothing', () => {
    assert.equal(bestOf([q('Be brave.'), q('x'.repeat(400))], 'open'), null);
  });

  // Every one of these has arrived from a public API at some point, and any of them thrown inside
  // a timer would take the bell down with no greeting and no error anyone reads.
  it('survives whatever the endpoint returns', () => {
    assert.deepEqual(parseBatch(null), []);
    assert.deepEqual(parseBatch({ error: 'rate limited' }), []);
    assert.deepEqual(parseBatch([{ q: 42, a: 'x' }]), []);
    assert.deepEqual(parseBatch([{ a: 'no text here' }]), []);
    assert.deepEqual(parseBatch([{ q: '  spaced  ', a: '  Someone  ' }]), [
      { text: 'spaced', by: 'Someone', sourced: true },
    ]);
  });
});

describe('session bell: the message', () => {
  it('names the right day and time in the morning', () => {
    const msg = renderBell('open', true, ist(9, 15), quote());
    assert.match(msg, /Wednesday, 12 August 2026/);
    assert.match(msg, /09:15 AM IST/);
    assert.match(msg, /GOOD MORNING/);
  });

  it('says the session is closed in the evening', () => {
    const msg = renderBell('close', true, ist(15, 30), quote());
    assert.match(msg, /TRADING SESSION CLOSED/);
    assert.match(msg, /03:30 PM IST/);
  });

  it('carries the quote it was handed', () => {
    const msg = renderBell('open', true, ist(9, 15), quote({ text: 'A very specific line.', by: 'Nobody', sourced: false }));
    assert.match(msg, /A very specific line\./);
    assert.match(msg, /— Nobody/);
  });

  // ZenQuotes' free tier is conditioned on a visible credit linking back to them. Getting this
  // wrong is a licence breach rather than a cosmetic slip, which is why it is asserted in both
  // directions.
  it('credits ZenQuotes when the quote came from them', () => {
    const msg = renderBell('open', true, ist(9, 15), quote({ sourced: true }));
    assert.match(msg, /zenquotes\.io/);
  });

  it('credits nobody when the quote came from the offline set', () => {
    const msg = renderBell('open', true, ist(9, 15), quote({ sourced: false }));
    assert.equal(msg.toLowerCase().includes('zenquotes'), false);
  });

  // The credit rides on the author line rather than sitting in a paragraph of its own: as a
  // trailing italic line it read like an advert stapled to a personal message.
  it('folds the credit onto the author line and adds no trailing line', () => {
    const msg = renderBell('open', true, ist(9, 15), quote({ by: 'Jim Rohn', sourced: true }));
    assert.match(msg, /— Jim Rohn · <a href="https:\/\/zenquotes\.io\/">ZenQuotes<\/a>/);
    assert.match(msg.split('\n').at(-1) as string, /Let the setup come to you/);
  });

  it('ends the close bell on the sign-off, credit or not', () => {
    for (const sourced of [true, false]) {
      const msg = renderBell('close', true, ist(15, 30), quote({ sourced }));
      assert.match(msg.split('\n').at(-1) as string, /Back at 09:15/, `sourced: ${sourced}`);
    }
  });

  // Telegram parses the message as HTML and drops the WHOLE message on a malformed tag, so the
  // only markup in it must be the markup this file put there.
  it('renders Telegram HTML with balanced tags and nothing else angled', () => {
    const msg = renderBell('open', true, ist(9, 15), quote());
    for (const tag of ['b', 'i', 'a'])
      assert.equal(
        (msg.match(new RegExp(`<${tag}[ >]`, 'g')) ?? []).length,
        (msg.match(new RegExp(`</${tag}>`, 'g')) ?? []).length,
        `unbalanced <${tag}>`,
      );
    assert.equal(msg.replace(/<\/?[bia](?: href="[^"]*")?>/g, '').includes('<'), false);
  });

  // A quote arriving with an ampersand or an angle bracket in it must not be able to break the
  // parse — the whole message would be rejected by Telegram, not just the quote.
  it('escapes markup that arrives inside a quote', () => {
    const msg = renderBell('open', true, ist(9, 15), quote({ text: 'Risk & reward <are> a pair, always.', by: 'A & B' }));
    assert.match(msg, /Risk &amp; reward &lt;are&gt; a pair/);
    assert.match(msg, /A &amp; B/);
  });

  it('renders Discord Markdown rather than HTML', () => {
    const msg = renderBell('close', false, ist(15, 30), quote());
    assert.equal(msg.includes('<b>'), false);
    assert.match(msg, /\*\*TRADING SESSION CLOSED\*\*/);
    assert.match(msg, /\[ZenQuotes\]\(https:\/\/zenquotes\.io\/\)/);
  });
});

// "Back at 09:15 tomorrow" is wrong by two days every Friday and wrong again on the eve of every
// holiday, and a message casually wrong about the calendar is not one to trust about a price.
//
// August 2026 for reference: the 12th is a Wednesday, so 13 Thu, 14 Fri, 15 Sat, 16 Sun, 17 Mon.
describe('session bell: when the next session is', () => {
  const closingLine = (nowMs: number): string =>
    renderBell('close', true, nowMs, quote({ sourced: false })).split('\n').at(-1) as string;

  it('says tomorrow on an ordinary weekday', () => {
    assert.match(closingLine(ist(15, 30)), /Back at 09:15 tomorrow\./);
  });

  it('says Monday on a Friday', () => {
    const friday = Date.UTC(2026, 7, 14, 15, 30) - 330 * 60_000;
    assert.match(closingLine(friday), /Back at 09:15 on Monday\./);
  });

  // The case this section was rewritten for: a holiday tomorrow means the next session is the day
  // after, and naming the weekday beats "the day after tomorrow".
  it('skips a holiday that falls tomorrow', () => {
    withHolidays('2026-08-13', () => {
      assert.match(closingLine(ist(15, 30)), /Back at 09:15 on Friday\./);
    });
  });

  it('skips a holiday that bridges into the weekend', () => {
    // Thursday, with Friday shut — the next session is Monday, three days out.
    const thursday = Date.UTC(2026, 7, 13, 15, 30) - 330 * 60_000;
    withHolidays('2026-08-14', () => {
      assert.match(closingLine(thursday), /Back at 09:15 on Monday\./);
    });
  });

  it('skips a holiday on the Monday after a Friday close', () => {
    const friday = Date.UTC(2026, 7, 14, 15, 30) - 330 * 60_000;
    withHolidays('2026-08-17', () => {
      assert.match(closingLine(friday), /Back at 09:15 on Tuesday\./);
    });
  });

  it('skips a run of consecutive holidays', () => {
    withHolidays('2026-08-13,2026-08-14,2026-08-17', () => {
      assert.match(closingLine(ist(15, 30)), /Back at 09:15 on Tuesday\./);
    });
  });

  // Past a week a weekday name is ambiguous — "on Friday" could be either of two Fridays — so the
  // full date is used instead.
  it('names the date when the market is shut for more than a week', () => {
    withHolidays('2026-08-13,2026-08-14,2026-08-17,2026-08-18,2026-08-19,2026-08-20', () => {
      assert.match(closingLine(ist(15, 30)), /Back at 09:15 on Friday, 21 August 2026\./);
    });
  });

  // A mis-pasted list must not spin the lookahead forever inside a timer.
  it('gives up gracefully rather than looping when nothing is open', () => {
    const shut = Array.from({ length: 30 }, (_, i) =>
      new Date(Date.UTC(2026, 7, 13) + i * 86_400_000).toISOString().slice(0, 10)).join(',');
    withHolidays(shut, () => {
      assert.match(closingLine(ist(15, 30)), /Back at 09:15 when the exchange reopens\./);
    });
  });
});

// The list itself, as shipped.
//
// This exists for next January. The calendar has to be re-pasted by hand every year — NSE
// publishes the coming one around December — and a typo in it fails in the quietest possible
// way: a malformed date simply never matches, so the bell rings on a holiday and nothing
// anywhere says why. Cheaper to catch here than to notice on Diwali.
//
// Deliberately checks the SHAPE and not the dates. Asserting 2026's sixteen would turn the
// annual refresh into a test edit, which is how a guard like this gets deleted.
describe('session bell: the shipped holiday list', () => {
  const example = path.join(fileURLToPath(new URL('.', import.meta.url)), '..', '.env.example');
  const dates = ((parseEnv(readFileSync(example, 'utf8')) as Record<string, string>).MARKET_HOLIDAYS ?? '')
    .split(',').map((s) => s.trim()).filter(Boolean);

  it('is actually parsed out of .env.example', () => {
    assert.ok(dates.length > 0, 'MARKET_HOLIDAYS is empty — a multi-line value will not parse');
  });

  it('is all well-formed YYYY-MM-DD', () => {
    for (const d of dates) {
      assert.match(d, /^\d{4}-\d{2}-\d{2}$/, `${d} is not YYYY-MM-DD`);
      assert.ok(!Number.isNaN(Date.parse(`${d}T00:00:00Z`)), `${d} is not a real date`);
      // Catches the classic: a 13th month, or a 31st of a 30-day month, both of which parse in
      // some engines and silently never match a real day.
      assert.equal(new Date(Date.parse(`${d}T00:00:00Z`)).toISOString().slice(0, 10), d);
    }
  });

  it('lists no weekends, which the session clock already skips', () => {
    for (const d of dates) {
      const dow = new Date(Date.parse(`${d}T00:00:00Z`)).getUTCDay();
      assert.ok(dow !== 0 && dow !== 6, `${d} falls at a weekend and does not need listing`);
    }
  });

  it('lists nothing twice', () => {
    assert.equal(new Set(dates).size, dates.length);
  });
});

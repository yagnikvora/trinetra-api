// The F&O ban list — the parse, and the two answers it must never confuse.
//
// "Nothing is banned" and "this is not the list" look alike and mean opposite things. The first is
// cached for the day; the second has to be retried, because caching it would switch the gate off
// for the session on the strength of an error page. NSE answers 200 with HTML for a date it has no
// file for, so the status code cannot tell them apart and the header line has to.
//
// Nothing below touches the network or the disk.

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { foBan, parseBanFile, resetFoBan } from '../src/momentum/data/fo-ban.js';

/** The file NSE published for 2026-10-13, verbatim. */
const FILE = 'Securities in Ban For Trade Date 13-OCT-2026:\n1,AMBUJACEM\n2,BANDHANBNK\n3,KAYNES\n4,LICHSGFIN\n';

describe('F&O ban list — the parse', () => {
  it('reads the symbols off the dated file', () => {
    assert.deepEqual(parseBanFile(FILE, '2026-10-13'), ['AMBUJACEM', 'BANDHANBNK', 'KAYNES', 'LICHSGFIN']);
  });

  it('survives CRLF line endings and symbols with punctuation', () => {
    const text = 'Securities in Ban For Trade Date 05-JAN-2027:\r\n1,M&M\r\n2,BAJAJ-AUTO\r\n';
    assert.deepEqual(parseBanFile(text, '2027-01-05'), ['M&M', 'BAJAJ-AUTO']);
  });

  it('reads a day with nothing banned as an empty list, not as a failure', () => {
    assert.deepEqual(parseBanFile('Securities in Ban For Trade Date 13-OCT-2026:\n', '2026-10-13'), []);
  });

  it('refuses a file for another session — the undated file rolls to tomorrow each evening', () => {
    assert.equal(parseBanFile(FILE, '2026-10-14'), null);
  });

  it('refuses the HTML page NSE serves for a date it has no file for', () => {
    assert.equal(parseBanFile('<!DOCTYPE html>\n<html lang="en">\n<head>', '2026-10-11'), null);
    assert.equal(parseBanFile('', '2026-10-13'), null);
  });
});

describe('F&O ban list — the day it is held for', () => {
  /** 09:30 IST on the given October 2026 date. */
  const at = (d: number): number => Date.UTC(2026, 9, d, 9, 30) - 330 * 60_000;

  it('answers from the list it already holds for the session', async () => {
    resetFoBan({ day: '2026-10-13', symbols: ['BANDHANBNK'], fetchedAt: at(13) });
    const banned = await foBan(at(13));
    assert.equal(banned.has('BANDHANBNK'), true);
    assert.equal(banned.has('HCLTECH'), false);
    resetFoBan();
  });
});

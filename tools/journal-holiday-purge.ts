// Trades dated on a day the exchange never opened.
//
//   npx tsx tools/journal-holiday-purge.ts            list them
//   npx tsx tools/journal-holiday-purge.ts --apply    back them up, then delete them
//
// THE PROBLEM. `marketOpen` knew about weekends and nothing else, so a weekday holiday read as an
// open session. The scanner ran against the previous close, a full day's frozen volume and range
// looked like a displacement at minute 12, and on 2026-10-02 (Gandhi Jayanti) four alerts were
// journalled at 09:27 as trades. Their "exit" is the same frozen quote read again at 15:15.
//
// `marketOpen` and `recordEntries` now both refuse a listed holiday, so this cannot recur. This
// tool is for what is already in the record.
//
// WHICH DAYS. Saturdays, Sundays and anything in `MARKET_HOLIDAYS`. The list is the authority, so
// check it before applying: a date wrongly added to it would mark a real session for deletion.
//
// WHAT IT DELETES. The journal row, from the local month document AND from the database, and the
// day's option paths and candidate log with it — all three describe a session that did not happen.
// Every row is written to `.cache/momentum/purged_<stamp>.json` first.
//
// ON A TWO-MACHINE SETUP THIS MUST BE RUN ON BOTH. `reconcile` no longer pushes a non-trading-day
// row, but only on a machine running the code that says so.

import '../src/env.js';

import { journalRepository } from '../src/momentum/journal/journal.js';
import { store } from '../src/momentum/store.js';
import { closePool, databaseUrl, getPool } from '../src/momentum/journal/postgres.js';
import { isSessionDay } from '../src/momentum/session.js';
import type { JournalTrade } from '../src/momentum/journal/types.js';

const FROM = '2026-01-01';
const TO = '2027-12-31';

const apply = process.argv.includes('--apply');

const all = await journalRepository().range(FROM, TO);
const drop = all.filter((t) => !isSessionDay(t.day));
const days = [...new Set(drop.map((t) => t.day))].sort();

console.log(`\n  ${all.length} trades in the record, ${drop.length} on a day the exchange was shut.\n`);
for (const t of drop)
  console.log(
    `  ${t.day}  ${t.symbol.padEnd(12)} ${t.channel.padEnd(12)} ` +
    `${String(t.contract?.label ?? '—').padEnd(10)} net ${String(t.netPnl ?? 0).padStart(9)}`,
  );

if (!drop.length) {
  console.log('  Nothing to remove.\n');
  await closePool();
  process.exit(0);
}

const removed = drop.reduce((s, t) => s + (t.netPnl ?? 0), 0);
console.log(`\n  Removing these changes the booked total by ${(-removed).toFixed(2)}.`);

if (!apply) {
  console.log('\n  Dry run. Re-run with --apply to delete.\n');
  await closePool();
  process.exit(0);
}

/* ------------------------------------------------------------------------- the delete --- */

const db = databaseUrl() ? getPool() : null;

// The backup comes first and holds everything about to go, so the delete can be undone by hand.
const paths = db
  ? (await db.query('SELECT * FROM momentum_option_path WHERE day = ANY($1::date[])', [days])).rows
  : [];
const candidates = db
  ? (await db.query('SELECT * FROM momentum_candidate WHERE day = ANY($1::date[])', [days])).rows
  : [];
const backup = `purged_${new Date().toISOString().replace(/[:.]/g, '-')}`;
await store.write(backup, { days, trades: drop, paths, candidates });
console.log(`\n  backup: .cache/momentum/${backup}.json`);

// Local month documents first: it is the copy `reconcile` pushes FROM.
const ids = new Set(drop.map((t) => t.id));
for (const month of new Set(days.map((d) => d.slice(0, 7)))) {
  const key = `journal_${month}`;
  const doc = await store.read<{ month: string; trades: JournalTrade[] }>(key);
  if (doc) {
    const before = doc.trades.length;
    doc.trades = doc.trades.filter((t) => !ids.has(t.id));
    if (doc.trades.length !== before) await store.write(key, doc);
    console.log(`  ${key}: ${before} -> ${doc.trades.length}`);
  }
  const pathKey = `journal_paths_${month}`;
  const pathDoc = await store.read<Record<string, unknown>>(pathKey);
  if (!pathDoc) continue;
  let gone = 0;
  for (const id of ids) if (id in pathDoc) { delete pathDoc[id]; gone++; }
  if (gone) await store.write(pathKey, pathDoc);
}

if (db) {
  const j = await db.query('DELETE FROM momentum_journal WHERE id = ANY($1::text[])', [[...ids]]);
  const p = await db.query('DELETE FROM momentum_option_path WHERE day = ANY($1::date[])', [days]);
  const c = await db.query('DELETE FROM momentum_candidate WHERE day = ANY($1::date[])', [days]);
  console.log(`  database: ${j.rowCount} trades, ${p.rowCount} option paths, ${c.rowCount} candidates deleted`);
}

console.log('');
await closePool();

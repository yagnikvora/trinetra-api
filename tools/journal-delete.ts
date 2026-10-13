// Remove named trades from the record — this machine's copy AND the database.
//
//   npx tsx tools/journal-delete.ts --id 2026-10-13:displacement:BANDHANBNK            list
//   npx tsx tools/journal-delete.ts --id 2026-10-13:displacement:BANDHANBNK --apply    delete
//
// `--id` may be given more than once. An id is `<day>:<channel>:<symbol>`, as the journal shows it.
//
// WHY THIS HAS TO BE RUN ON EVERY MACHINE. The journal is a mirror: each machine keeps its own
// month documents under `.cache/momentum/` and pushes them to Neon. Deleting a row from Neon and
// from ONE machine's disk leaves it on the other's, and that machine does two things with it —
// its page keeps showing the row, because a read is the database UNIONED with local disk, and its
// next boot puts the row straight back in Neon, because `reconcile` pushes whatever local history
// the database does not have. That is what happened to the 2026-10-13 BANDHANBNK row: removed here
// at 21:17, back in the database the moment the second PC started.
//
// So the order is: stop the API on the machine that still has the row, run this there with
// --apply, start it again. Running it on a machine that never had the row is harmless — it only
// clears the database side.
//
// WHAT IT REMOVES. The journal row from the local month document and from `momentum_journal`, the
// row's archived option path on local disk, and its id from the retry queue. Everything removed is
// written to `.cache/momentum/purged_<stamp>.json` first.

import '../src/env.js';

import { hostname } from 'node:os';

import { store } from '../src/momentum/store.js';
import { closePool, databaseUrl, getPool } from '../src/momentum/journal/postgres.js';
import type { JournalTrade } from '../src/momentum/journal/types.js';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const ids = args.flatMap((a, i) => (a === '--id' && args[i + 1] ? [args[i + 1]] : []));

const bad = ids.filter((id) => !/^\d{4}-\d{2}-\d{2}:[a-z-]+:.+$/.test(id));
if (!ids.length || bad.length) {
  console.log(
    bad.length
      ? `\n  Not a trade id: ${bad.join(', ')}\n`
      : '\n  Nothing to do. Usage: npx tsx tools/journal-delete.ts --id <day>:<channel>:<symbol> [--apply]\n',
  );
  process.exit(1);
}

const want = new Set(ids);
const months = [...new Set(ids.map((id) => id.slice(0, 7)))];
const db = databaseUrl() ? getPool() : null;

/* --------------------------------------------------------------------------- what is there --- */

type Month = { month: string; trades: JournalTrade[] };

const local: JournalTrade[] = [];
for (const month of months) {
  const doc = await store.read<Month>(`journal_${month}`);
  for (const t of doc?.trades ?? []) if (want.has(t.id)) local.push(t);
}
const remote = db
  ? (await db.query('SELECT * FROM momentum_journal WHERE id = ANY($1::text[])', [ids])).rows
  : [];

console.log(`\n  On ${hostname()}:\n`);
for (const id of ids) {
  const here = local.find((t) => t.id === id);
  const there = remote.some((r) => r.id === id);
  console.log(
    `  ${id.padEnd(44)} this machine: ${here ? `yes (net ${here.netPnl ?? 0})` : 'no'}` +
    `   database: ${db ? (there ? 'yes' : 'no') : 'not configured'}`,
  );
}

if (!local.length && !remote.length) {
  console.log('\n  Nothing to remove.\n');
  await closePool();
  process.exit(0);
}

if (!apply) {
  console.log('\n  Dry run. Re-run with --apply to delete.\n');
  await closePool();
  process.exit(0);
}

/* ------------------------------------------------------------------------------ the delete --- */

// The backup comes first and holds everything about to go, so the delete can be undone by hand.
const localPaths: Record<string, unknown> = {};
for (const month of months) {
  const pathDoc = await store.read<Record<string, unknown>>(`journal_paths_${month}`);
  for (const id of ids) if (pathDoc && id in pathDoc) localPaths[id] = pathDoc[id];
}
const backup = `purged_${new Date().toISOString().replace(/[:.]/g, '-')}`;
await store.write(backup, { ids, trades: local, remote, paths: localPaths });
console.log(`\n  backup: .cache/momentum/${backup}.json`);

// Local month documents first: it is the copy `reconcile` pushes FROM.
for (const month of months) {
  const key = `journal_${month}`;
  const doc = await store.read<Month>(key);
  if (doc) {
    const before = doc.trades.length;
    doc.trades = doc.trades.filter((t) => !want.has(t.id));
    if (doc.trades.length !== before) await store.write(key, doc);
    console.log(`  ${key}: ${before} -> ${doc.trades.length}`);
  }
  const pathKey = `journal_paths_${month}`;
  const pathDoc = await store.read<Record<string, unknown>>(pathKey);
  if (pathDoc) {
    let gone = 0;
    for (const id of ids) if (id in pathDoc) { delete pathDoc[id]; gone++; }
    if (gone) await store.write(pathKey, pathDoc);
  }
}

// And out of the retry queue, or the next scan tick would look the id up, find nothing, and carry on
// — harmless, but a queue that names a row that no longer exists reads as a sync fault on the page.
const pending = await store.read<{ ids: string[] }>('journal_pending');
if (pending?.ids?.some((id) => want.has(id)))
  await store.write('journal_pending', { ids: pending.ids.filter((id) => !want.has(id)) });

if (db) {
  const j = await db.query('DELETE FROM momentum_journal WHERE id = ANY($1::text[])', [ids]);
  console.log(`  database: ${j.rowCount} deleted`);
}

console.log('\n  Done on this machine. Run it on any other machine that recorded these trades.\n');
await closePool();

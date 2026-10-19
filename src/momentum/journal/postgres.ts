// The journal in Postgres — one row per trade, which is what makes two machines share a record.
//
// WHY A ROW PER TRADE rather than the month document the file store keeps. A document has to be
// read, modified and written back, which raises the question of whose copy is newer every time two
// machines touch it — and answering that question needs a revision counter and the code to
// arbitrate it. A row keyed on the trade's own id needs none of that: `INSERT … ON CONFLICT (id)
// DO UPDATE` is the whole of it, and a bad write can damage one trade instead of a month.
//
// WHY JSONB AND NOT COLUMNS. The trade carries about thirty fields and will carry more. Promoting
// every one of them into a column means a migration each time the record learns something, and
// this is a personal trade log rather than a warehouse. So the whole record is JSONB and only the
// handful worth querying or summing — day, channel, symbol, the two money figures, the two flags —
// are promoted out and indexed. `schema.sql` in this module already anticipated the trade-off; it
// said `momentum_history` is "the one table that genuinely wants a database", and this is the same
// argument for the same reason.
//
// SERVERLESS COMPUTE SLEEPS. Neon suspends an idle branch and wakes it on the next connection,
// which shows up as a cold first query and, less obviously, as a pooled connection that was killed
// while nothing was using it. So the pool is small, its idle timeout is short, and every statement
// gets exactly one retry on the error classes that mean "the socket went away" rather than "your
// SQL is wrong". Retrying a syntax error forever is how a scanner spends an afternoon failing.

import net from 'node:net';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import type { JournalChannel, JournalTrade } from './types.js';
import type { JournalRepository, JournalSyncStatus } from './repository.js';

export const databaseUrl = (): string | null => {
  const raw = (process.env.DATABASE_URL ?? '').trim();
  return raw.length > 0 ? raw : null;
};

/* ----------------------------------------------------------------------------- schema --- */

/**
 * Created on demand rather than by a migration step.
 *
 * There is no migration runner in this app and adding one for a single table would be more
 * machinery than it saves. `IF NOT EXISTS` throughout means this is safe to run on every boot and
 * safe to run from two machines at once.
 */
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS momentum_journal (
    id           TEXT         PRIMARY KEY,
    day          DATE         NOT NULL,
    channel      TEXT         NOT NULL,
    symbol       TEXT         NOT NULL,
    settled      BOOLEAN      NOT NULL DEFAULT false,
    edited       BOOLEAN      NOT NULL DEFAULT false,
    amount_used  NUMERIC,
    net_pnl      NUMERIC,
    trade        JSONB        NOT NULL,
    updated_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS momentum_journal_day_idx ON momentum_journal (day DESC);
CREATE INDEX IF NOT EXISTS momentum_journal_day_channel_idx ON momentum_journal (day, channel);
CREATE INDEX IF NOT EXISTS momentum_journal_unsettled_idx ON momentum_journal (settled, day)
    WHERE settled = false;

-- The traded contract's own minute path, kept because it is PERISHABLE and the journal is not.
--
-- Upstox answers UDAPI100011 "Invalid Instrument key" for any contract whose series has expired.
-- On 2026-08-27 that made every July and August option in this journal unfetchable, and an
-- exit-rule study across 61 settled trades became impossible — the trades were still there, but
-- the evidence needed to ask a NEW question of them was gone. A row here is about 8 KB, so three
-- months of signals is single-digit megabytes: the cheapest insurance in this project.
--
-- The bars column is [[minute, high, low, close], ...] for the WHOLE session, not merely from the
-- entry minute, so a later study can move the ENTRY as well as the exit.
CREATE TABLE IF NOT EXISTS momentum_option_path (
    day             DATE         NOT NULL,
    instrument_key  TEXT         NOT NULL,
    symbol          TEXT         NOT NULL,
    strike          NUMERIC,
    opt_type        TEXT,
    expiry          DATE,
    lot_size        INTEGER,
    -- 'traded' is the contract the alert actually bought. Room for 'neighbour' later, so a
    -- strike-selection study does not need a second table.
    role            TEXT         NOT NULL DEFAULT 'traded',
    bars            JSONB        NOT NULL,
    saved_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
    PRIMARY KEY (day, instrument_key)
);

CREATE INDEX IF NOT EXISTS momentum_option_path_day_idx ON momentum_option_path (day DESC);
CREATE INDEX IF NOT EXISTS momentum_option_path_symbol_idx ON momentum_option_path (symbol, day DESC);

-- What the rule CONSIDERED each morning, including everything it refused.
--
-- Without this, raising DISPLACEMENT_MIN_RVOL from 5 to 8 is untestable after the fact: the RVOL
-- of the symbols that did not fire was never written down. The ticks column holds the gate metrics
-- minute by minute for symbols in contention, and those metrics embed the LIVE baseline — the
-- part that genuinely cannot be reconstructed later, because the baseline is rebuilt and
-- overwritten every morning while equity candles stay fetchable for months.
--
-- taken/taken_minute are what make a capacity study possible: which candidates the per-day cap
-- turned away, and at what time it filled.
CREATE TABLE IF NOT EXISTS momentum_candidate (
    day           DATE         NOT NULL,
    channel       TEXT         NOT NULL,
    symbol        TEXT         NOT NULL,
    taken         BOOLEAN      NOT NULL DEFAULT false,
    taken_minute  INTEGER,
    first_minute  INTEGER      NOT NULL,
    last_minute   INTEGER      NOT NULL,
    peak_rvol     NUMERIC,
    ticks         JSONB        NOT NULL,
    saved_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    PRIMARY KEY (day, channel, symbol)
);

CREATE INDEX IF NOT EXISTS momentum_candidate_day_idx ON momentum_candidate (day DESC);
CREATE INDEX IF NOT EXISTS momentum_candidate_taken_idx ON momentum_candidate (day, taken);
`;

/* ------------------------------------------------------------------------- the driver --- */

/** The transport, narrowed to what this file uses, so a test can supply its own. */
export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(
    sql: string, params?: unknown[],
  ): Promise<{ rows: R[]; rowCount: number | null }>;
}

/** "The socket went away", as opposed to "your SQL is wrong". Only these are worth retrying. */
const TRANSIENT = new Set([
  'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN',
  '57P01',    // admin_shutdown — what a suspended branch looks like from the client
  '57P03',    // cannot_connect_now — waking up
  '08006', '08003', '08000',
]);

const transient = (e: unknown): boolean => {
  const code = (e as { code?: string }).code;
  return code !== undefined && TRANSIENT.has(code);
};

let pool: Pool | null = null;

/**
 * Strip `sslmode` from the connection string, because this file sets TLS explicitly below.
 *
 * Neon hands out URLs ending `?sslmode=require`, and `pg-connection-string` prints a paragraph of
 * deprecation warning about it on every boot — `require` is currently an alias for `verify-full`
 * and will stop being one. Rather than let a warning appear in the log every morning, or pin a
 * spelling that changes meaning in the next major version, the mode is removed here and the `ssl`
 * option is stated outright. Same behaviour, no ambiguity, no warning.
 *
 * `sslmode=disable` is honoured rather than stripped: someone who asked for no TLS meant it.
 */
function withoutSslMode(url: string): { url: string; disable: boolean } {
  try {
    const u = new URL(url);
    const mode = u.searchParams.get('sslmode');
    if (mode === 'disable') return { url, disable: true };
    u.searchParams.delete('sslmode');
    return { url: u.toString(), disable: false };
  } catch {
    return { url, disable: /sslmode=disable/.test(url) };
  }
}

/**
 * Give each address in the Happy Eyeballs race long enough to actually finish.
 *
 * Node 20 turns `autoSelectFamily` on by default and allows each resolved address 250ms to
 * complete its TCP handshake. Neon's endpoint resolves to one IPv6 address and three in AWS
 * us-east-2, and from here the real handshake takes about 550ms — so every attempt overran the
 * budget, the list was exhausted, and the connection died with ETIMEDOUT in under a second. The
 * generous `connectionTimeoutMillis` below never got a say, which is what made this look like an
 * unreachable database rather than a client-side stopwatch.
 *
 * 2500ms is the value Node itself moved the default to once the 250ms one proved too tight for
 * connections that cross an ocean. Set here rather than at the entry point because this is the
 * only long-haul connection the app makes, and a reader asking why it is needed is already in the
 * right file.
 */
net.setDefaultAutoSelectFamilyAttemptTimeout(2500);

export function getPool(url = databaseUrl()): Pool {
  if (!url) throw new Error('DATABASE_URL is not set');
  if (pool) return pool;
  const conn = withoutSslMode(url);
  pool = new Pool({
    connectionString: conn.url,
    // Two is plenty: one long-running process making a handful of small statements a minute. A
    // large pool against a branch that suspends just means more dead sockets to discover.
    max: 2,
    idleTimeoutMillis: 10_000,
    // A cold start on a suspended branch is seconds, not milliseconds.
    connectionTimeoutMillis: 20_000,
    // Neon terminates unencrypted connections. Its certificates are publicly trusted, so this
    // verifies the chain properly rather than turning verification off.
    ssl: conn.disable ? undefined : { rejectUnauthorized: true },
  });
  // Without this an idle client killed by the far end raises an unhandled 'error' event and takes
  // the process with it — the scanner would die overnight for a reason nothing logged.
  pool.on('error', () => {});
  return pool;
}

export async function closePool(): Promise<void> {
  const p = pool;
  pool = null;
  if (p) await p.end().catch(() => {});
}

/** One retry, and only for the errors that mean the connection rather than the statement. */
async function run<R extends QueryResultRow>(
  db: Queryable, sql: string, params?: unknown[],
): Promise<{ rows: R[]; rowCount: number | null }> {
  try {
    return await db.query<R>(sql, params);
  } catch (e) {
    if (!transient(e)) throw e;
    return db.query<R>(sql, params);
  }
}

/* --------------------------------------------------------------------- the repository --- */

interface Row extends QueryResultRow { trade: JournalTrade }

const toTrade = (r: Row): JournalTrade => r.trade;

export class PostgresJournalRepository implements JournalRepository {
  private ready: Promise<void> | null = null;
  private lastPushAt: number | null = null;
  private lastPullAt: number | null = null;
  private lastError: string | null = null;

  constructor(private readonly db: Queryable = getPool()) {}

  /** Creates the table on first use. Memoised, so it is one statement per process. */
  private ensure(): Promise<void> {
    this.ready ??= run(this.db, SCHEMA).then(() => undefined);
    return this.ready.catch((e) => {
      // Cleared so a failure caused by a sleeping branch is retried rather than cached forever.
      this.ready = null;
      throw e;
    });
  }

  async range(from: string, to: string, channel?: JournalChannel | null): Promise<JournalTrade[]> {
    await this.ensure();
    const sql = channel
      ? 'SELECT trade FROM momentum_journal WHERE day BETWEEN $1 AND $2 AND channel = $3 ORDER BY day DESC, (trade->\'entry\'->>\'at\')::bigint ASC'
      : 'SELECT trade FROM momentum_journal WHERE day BETWEEN $1 AND $2 ORDER BY day DESC, (trade->\'entry\'->>\'at\')::bigint ASC';
    const params = channel ? [from, to, channel] : [from, to];
    const { rows } = await run<Row>(this.db, sql, params);
    this.lastPullAt = Date.now();
    this.lastError = null;
    return rows.map(toTrade);
  }

  /** No local half, so this is the same query. */
  mine(day: string): Promise<JournalTrade[]> {
    return this.range(day, day);
  }

  async existing(day: string): Promise<Set<string>> {
    await this.ensure();
    const { rows } = await run<{ id: string } & QueryResultRow>(
      this.db, 'SELECT id FROM momentum_journal WHERE day = $1', [day],
    );
    return new Set(rows.map((r) => r.id));
  }

  async unsettled(): Promise<JournalTrade[]> {
    await this.ensure();
    const { rows } = await run<Row>(
      this.db,
      'SELECT trade FROM momentum_journal WHERE settled = false ORDER BY day ASC',
    );
    return rows.map(toTrade);
  }

  async one(id: string): Promise<JournalTrade | null> {
    await this.ensure();
    const { rows } = await run<Row>(
      this.db, 'SELECT trade FROM momentum_journal WHERE id = $1', [id],
    );
    return rows.length ? toTrade(rows[0]) : null;
  }

  /**
   * Insert or replace, in one statement per batch.
   *
   * `unnest` rather than a row of placeholders per trade: a settlement pass can rewrite a whole
   * day at once, and a statement whose length grows with the batch is the kind of thing that works
   * until the morning it does not.
   */
  async save(trades: JournalTrade[]): Promise<void> {
    if (!trades.length) return;
    await this.ensure();
    const now = Date.now();
    for (const t of trades) t.updatedAt ||= now;
    await run(this.db, `
      INSERT INTO momentum_journal (id, day, channel, symbol, settled, edited, amount_used, net_pnl, trade, updated_at)
      SELECT * FROM unnest(
        $1::text[], $2::date[], $3::text[], $4::text[], $5::boolean[], $6::boolean[],
        $7::numeric[], $8::numeric[], $9::jsonb[], $10::timestamptz[]
      )
      ON CONFLICT (id) DO UPDATE SET
        day = EXCLUDED.day, channel = EXCLUDED.channel, symbol = EXCLUDED.symbol,
        settled = EXCLUDED.settled, edited = EXCLUDED.edited,
        amount_used = EXCLUDED.amount_used, net_pnl = EXCLUDED.net_pnl,
        trade = EXCLUDED.trade, updated_at = EXCLUDED.updated_at
    `, [
      trades.map((t) => t.id),
      trades.map((t) => t.day),
      trades.map((t) => t.channel),
      trades.map((t) => t.symbol),
      trades.map((t) => t.settled),
      trades.map((t) => t.edited),
      trades.map((t) => t.amountUsed),
      trades.map((t) => t.netPnl),
      trades.map((t) => JSON.stringify(t)),
      trades.map((t) => new Date(t.updatedAt ?? now).toISOString()),
    ]);
    this.lastPushAt = Date.now();
    this.lastError = null;
  }

  async status(): Promise<JournalSyncStatus> {
    return {
      mode: 'neon', remote: this.lastError ? 'degraded' : 'ok', pending: 0,
      lastPushAt: this.lastPushAt, lastPullAt: this.lastPullAt,
      lastError: this.lastError, servedFromLocal: false,
    };
  }

  async flush(): Promise<void> { /* writes are synchronous against the database */ }
  async reconcile(): Promise<number> { return 0; }
}

/**
 * Prove the whole path: connect, create the table, write a row, read it back, delete it.
 *
 * Exists because `npm run check-neon` has to answer "are my credentials right" without either the
 * operator or a log line ever handling the connection string. Returns the steps it got through so
 * a failure names the one that broke rather than reporting "database error".
 */
/** One contract's session, as the archive stores it. */
export interface OptionPathRow {
  day: string;
  instrumentKey: string;
  symbol: string;
  strike: number | null;
  optType: string | null;
  expiry: string | null;
  lotSize: number | null;
  role: string;
  bars: Array<[number, number, number, number]>;
}

/**
 * Save contract paths, skipping any already stored.
 *
 * `ON CONFLICT DO NOTHING` rather than an upsert on purpose: a finished session's candles do not
 * change, so the first copy written is the right one, and a re-settle must not be able to
 * overwrite a good path with an empty answer from a since-expired key.
 */
export async function savePaths(db: Queryable, rows: OptionPathRow[]): Promise<number> {
  if (!rows.length) return 0;
  let n = 0;
  for (const r of rows) {
    const { rowCount } = await run(
      db,
      `INSERT INTO momentum_option_path
         (day, instrument_key, symbol, strike, opt_type, expiry, lot_size, role, bars)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
       ON CONFLICT (day, instrument_key) DO NOTHING`,
      [r.day, r.instrumentKey, r.symbol, r.strike, r.optType, r.expiry, r.lotSize, r.role,
        JSON.stringify(r.bars)],
    );
    n += rowCount ?? 0;
  }
  return n;
}

/** One symbol's morning, as the candidate log stores it. */
export interface CandidateRow {
  day: string;
  channel: string;
  symbol: string;
  taken: boolean;
  takenMinute: number | null;
  firstMinute: number;
  lastMinute: number;
  peakRvol: number;
  ticks: Array<[number, number, number, number, number, number, number, 1 | -1]>;
  /** OI, book, VIX, results and news readings — see `alerts/candidates.ts`. Null on older rows. */
  readings?: Record<string, number | null> | null;
}

/**
 * The `readings` column, added to a table that already exists on every machine. Run once per
 * process before the first save, because `saveCandidates` is called with a bare pool that has not
 * necessarily been through `SCHEMA`.
 */
let candidateReadingsColumn: Promise<unknown> | null = null;

/**
 * Save the day's candidates.
 *
 * Upsert rather than DO NOTHING, unlike the path archive: a session can legitimately be re-flushed
 * — a restart mid-morning, or a manual re-run — and the later write is the more complete one,
 * because `taken` is only correct once the window has closed.
 */
export async function saveCandidates(db: Queryable, rows: CandidateRow[]): Promise<number> {
  if (!rows.length) return 0;
  candidateReadingsColumn ??= run(db, 'ALTER TABLE momentum_candidate ADD COLUMN IF NOT EXISTS readings JSONB')
    .catch((e) => { candidateReadingsColumn = null; throw e; });
  await candidateReadingsColumn;
  let n = 0;
  for (const r of rows) {
    const { rowCount } = await run(
      db,
      `INSERT INTO momentum_candidate
         (day, channel, symbol, taken, taken_minute, first_minute, last_minute, peak_rvol, ticks, readings)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb)
       ON CONFLICT (day, channel, symbol) DO UPDATE SET
         taken = EXCLUDED.taken, taken_minute = EXCLUDED.taken_minute,
         first_minute = EXCLUDED.first_minute, last_minute = EXCLUDED.last_minute,
         peak_rvol = EXCLUDED.peak_rvol, ticks = EXCLUDED.ticks, readings = EXCLUDED.readings, saved_at = now()`,
      [r.day, r.channel, r.symbol, r.taken, r.takenMinute, r.firstMinute, r.lastMinute,
        r.peakRvol, JSON.stringify(r.ticks), r.readings ? JSON.stringify(r.readings) : null],
    );
    n += rowCount ?? 0;
  }
  return n;
}

/** What the archive holds, for the status endpoint and the tools. */
export async function pathStats(db: Queryable): Promise<{ paths: number; days: number; from: string | null; to: string | null }> {
  const { rows } = await run<{ n: string; d: string; lo: string | null; hi: string | null } & QueryResultRow>(
    db,
    `SELECT count(*)::text AS n, count(DISTINCT day)::text AS d,
            min(day)::text AS lo, max(day)::text AS hi FROM momentum_option_path`,
  );
  const r = rows[0];
  return { paths: Number(r?.n ?? 0), days: Number(r?.d ?? 0), from: r?.lo ?? null, to: r?.hi ?? null };
}

export async function probe(db: Queryable): Promise<{ step: string; ok: boolean; detail?: string }[]> {
  const steps: { step: string; ok: boolean; detail?: string }[] = [];
  const mark = async (step: string, fn: () => Promise<string | void>) => {
    try {
      const detail = await fn();
      steps.push({ step, ok: true, ...(detail ? { detail } : {}) });
      return true;
    } catch (e) {
      steps.push({ step, ok: false, detail: String((e as Error).message) });
      return false;
    }
  };

  if (!await mark('connect', async () => {
    const { rows } = await run<{ v: string } & QueryResultRow>(db, 'SELECT version() AS v');
    return rows[0]?.v?.split(',')[0] ?? '';
  })) return steps;

  if (!await mark('create table', async () => { await run(db, SCHEMA); })) return steps;

  const id = `__probe:${Date.now()}`;
  const repo = new PostgresJournalRepository(db);
  const fake: JournalTrade = {
    id, day: new Date().toISOString().slice(0, 10), channel: 'displacement',
    symbol: '__PROBE', direction: 1, contract: null, lots: 1,
    entry: { at: Date.now(), minute: 0, premium: 1, spot: 1, source: 'auto' },
    exit: null, mark: null, mfePct: null, maePct: null, spreadPctAtEntry: null,
    amountUsed: null, grossPnl: null, charges: null, netPnl: null, netPct: null,
    shadow: [], readings: {}, note: 'connectivity probe', status: 'open',
    settled: false, edited: false, updatedAt: Date.now(),
  };

  await mark('write a row', async () => { await repo.save([fake]); });
  await mark('read it back', async () => {
    const got = await repo.one(id);
    if (!got) throw new Error('the row was written but could not be read back');
    if (got.symbol !== '__PROBE') throw new Error('the row came back with the wrong contents');
    return 'round trip matched';
  });
  await mark('clean up', async () => {
    const { rowCount } = await run(db, 'DELETE FROM momentum_journal WHERE id = $1', [id]);
    return `${rowCount ?? 0} probe row removed`;
  });
  await mark('count what is stored', async () => {
    const { rows } = await run<{ n: string; lo: string | null; hi: string | null } & QueryResultRow>(
      db,
      'SELECT count(*)::text AS n, min(day)::text AS lo, max(day)::text AS hi FROM momentum_journal',
    );
    const r = rows[0];
    return Number(r?.n ?? 0) > 0 ? `${r.n} trades, ${r.lo} to ${r.hi}` : 'no trades yet';
  });
  return steps;
}

export type { PoolClient };

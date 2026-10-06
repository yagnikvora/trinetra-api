// Where the journal lives, and the seam that lets it live in two places at once.
//
// THE PROBLEM THIS SOLVES. The scanner runs on one machine during market hours and the record is
// read on another at night. Copying `.cache/` between them by hand is the kind of chore that gets
// forgotten exactly once, and the trade log is the one file in this app that cannot be rebuilt —
// `settleDay` can re-derive an exit from candles, but an entry that was never recorded is gone.
//
// THREE IMPLEMENTATIONS, one interface:
//
//   FileJournalRepository      month documents under `api/.cache/momentum/`, as before. The
//                              default, and what runs when DATABASE_URL is unset — so a clone
//                              with no database configured behaves exactly as it did.
//   PostgresJournalRepository  one row per trade in Neon. See ./postgres.ts.
//   MirrorJournalRepository    both. Writes hit the local disk FIRST and the database second.
//
// WHY THE MIRROR WRITES LOCALLY FIRST, and why that order is not arbitrary. A serverless database
// sleeps when idle and wakes on demand, an office network drops, and an alert fires at 09:30
// whether or not either is true at that moment. Local disk is a few milliseconds and cannot be
// unreachable, so the trade is durable before anything is attempted over the wire. The push is
// then best-effort with a retry queue that survives a restart. The failure this ordering prevents
// is the one that matters: a network blip must never cost a trade.
//
// READS PREFER THE DATABASE, because it is the shared truth — a fill corrected at home last night
// has to be what the office sees this morning. A read that cannot reach it falls back to the local
// copy and SAYS SO, in `status().servedFromLocal`, which the page shows. Silently serving a stale
// local copy as though it were the shared record is the one behaviour worth going out of the way
// to prevent.

import { isSessionDay } from '../session.js';
import { store as diskStore, type KeyValueStore } from '../store.js';
import type { JournalChannel, JournalTrade } from './types.js';

/** How the store is wired, and whether the remote half of it is actually working. */
export interface JournalSyncStatus {
  mode: 'disk' | 'neon' | 'mirror';
  /** 'off' when there is no remote at all. */
  remote: 'ok' | 'degraded' | 'off';
  /** Trades written locally that have not reached the database yet. */
  pending: number;
  lastPushAt: number | null;
  lastPullAt: number | null;
  lastError: string | null;
  /**
   * True when the most recent read could not reach the database and answered from local disk.
   *
   * Surfaced rather than swallowed: on the reading machine this is the difference between "there
   * were no trades" and "I could not reach the record", and those look identical otherwise.
   */
  servedFromLocal: boolean;
}

export interface JournalRepository {
  /** Trades whose session day is in [from, to] inclusive, newest day first is NOT guaranteed. */
  range(from: string, to: string, channel?: JournalChannel | null): Promise<JournalTrade[]>;
  /**
   * THIS MACHINE'S copy of one day, which on the mirror means the local one.
   *
   * The 15-second mark tick needs the day it is writing to, and routing that through the database
   * would hold a serverless branch awake all session for readings it already has on disk. The
   * distinction is not cosmetic: `range` is "the shared record" and `mine` is "what I have
   * written", and the tick only ever wants the second.
   */
  mine(day: string): Promise<JournalTrade[]>;
  /** The ids already recorded for a day, so one alert can never be journalled twice. */
  existing(day: string): Promise<Set<string>>;
  /** Everything not yet settled, whatever day it belongs to. */
  unsettled(): Promise<JournalTrade[]>;
  one(id: string): Promise<JournalTrade | null>;
  /** Insert or replace, keyed on `id`. */
  save(trades: JournalTrade[]): Promise<void>;
  status(): Promise<JournalSyncStatus>;
  /** Retry whatever has not reached the remote. A no-op when there is no remote. */
  flush(): Promise<void>;
  /** Push local history the remote has never seen. Runs once on boot. */
  reconcile(days: number): Promise<number>;
}

/* --------------------------------------------------------------------------- the disk --- */

const monthKey = (day: string): string => `journal_${day.slice(0, 7)}`;
const PENDING_KEY = 'journal_pending';

interface Month { month: string; trades: JournalTrade[] }

/** Every month key a [from, to] range touches, as a day string inside each month. */
export function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let [y, m] = from.slice(0, 7).split('-').map(Number);
  const [ty, tm] = to.slice(0, 7).split('-').map(Number);
  for (let guard = 0; guard < 240; guard++) {
    out.push(`${y}-${String(m).padStart(2, '0')}-01`);
    if (y === ty && m === tm) break;
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return out;
}

export const isoDaysAgo = (days: number, from = Date.now()): string =>
  new Date(from - days * 86_400_000).toISOString().slice(0, 10);

export class FileJournalRepository implements JournalRepository {
  /**
   * Every write goes through this chain.
   *
   * A month document is read-modify-written, and the scan tick, an alert firing and an HTTP PATCH
   * can all land inside the same millisecond. Without a queue the last writer wins and a trade
   * silently loses its exit.
   */
  private chain: Promise<unknown> = Promise.resolve();

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => {});
    return next;
  }

  constructor(private readonly store: KeyValueStore = diskStore) {}

  private async readMonth(day: string): Promise<Month> {
    return (await this.store.read<Month>(monthKey(day))) ?? { month: day.slice(0, 7), trades: [] };
  }

  async range(from: string, to: string, channel?: JournalChannel | null): Promise<JournalTrade[]> {
    const out: JournalTrade[] = [];
    for (const mk of monthsBetween(from, to)) {
      for (const t of (await this.readMonth(mk)).trades) {
        if (t.day < from || t.day > to) continue;
        if (channel && t.channel !== channel) continue;
        out.push(t);
      }
    }
    return out;
  }

  mine(day: string): Promise<JournalTrade[]> {
    return this.range(day, day);
  }

  async existing(day: string): Promise<Set<string>> {
    return new Set((await this.readMonth(day)).trades.filter((t) => t.day === day).map((t) => t.id));
  }

  async unsettled(): Promise<JournalTrade[]> {
    const seen: JournalTrade[] = [];
    // This month and the previous one. A trade older than that which is still unsettled has no
    // candles left to settle from anyway — the intraday endpoint only covers today and the
    // historical one is per-day, so reaching further back buys nothing.
    for (const mk of [isoDaysAgo(0), isoDaysAgo(35)]) {
      for (const t of (await this.readMonth(mk)).trades) if (!t.settled) seen.push(t);
    }
    const byId = new Map(seen.map((t) => [t.id, t]));
    return [...byId.values()].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  }

  /**
   * A trade by id, which is an O(1) file read because an id always begins with its session date.
   *
   * The guard is not paranoia: without it a malformed id derives a month key from whatever its
   * first seven characters happen to be, reads a file that does not exist, and reports the trade as
   * missing — a 404 that looks like "deleted" rather than "you sent nonsense".
   */
  async one(id: string): Promise<JournalTrade | null> {
    if (!/^\d{4}-\d{2}-\d{2}:/.test(id)) return null;
    return (await this.readMonth(id.slice(0, 10))).trades.find((t) => t.id === id) ?? null;
  }

  async save(trades: JournalTrade[]): Promise<void> {
    if (!trades.length) return;
    await this.serial(async () => {
      const byMonth = new Map<string, JournalTrade[]>();
      for (const t of trades) {
        const k = t.day.slice(0, 7);
        const a = byMonth.get(k) ?? [];
        a.push(t); byMonth.set(k, a);
      }
      for (const [, group] of byMonth) {
        const day = group[0].day;
        const m = await this.readMonth(day);
        for (const t of group) {
          const i = m.trades.findIndex((x) => x.id === t.id);
          if (i >= 0) m.trades[i] = t;
          else m.trades.push(t);
        }
        m.trades.sort((a, b) => a.entry.at - b.entry.at);
        await this.store.write(monthKey(day), m);
      }
    });
  }

  async status(): Promise<JournalSyncStatus> {
    return {
      mode: 'disk', remote: 'off', pending: 0,
      lastPushAt: null, lastPullAt: null, lastError: null, servedFromLocal: false,
    };
  }

  async flush(): Promise<void> { /* nothing to push */ }
  async reconcile(): Promise<number> { return 0; }
}

/**
 * Merge two sides of the same record, keeping whichever copy of each trade changed last.
 *
 * `updatedAt` is the only arbiter, deliberately: "the database wins" would discard a trade that
 * has not reached it yet, and "local wins" would discard a fill corrected on the other machine.
 */
export function newestWins(remote: JournalTrade[], local: JournalTrade[]): JournalTrade[] {
  const merged = new Map<string, JournalTrade>();
  for (const t of remote) merged.set(t.id, t);
  for (const t of local) {
    const there = merged.get(t.id);
    if (!there || (t.updatedAt ?? 0) > (there.updatedAt ?? 0)) merged.set(t.id, t);
  }
  return [...merged.values()];
}

/* ------------------------------------------------------------------------- the mirror --- */

export class MirrorJournalRepository implements JournalRepository {
  private lastPushAt: number | null = null;
  private lastPullAt: number | null = null;
  private lastError: string | null = null;
  private degraded = false;
  private servedFromLocal = false;
  /** Loaded from disk on first use, so a restart does not lose the retry queue. */
  private pending: Set<string> | null = null;

  /**
   * `local` is typed to the interface rather than to the file class on purpose: the mirror only
   * ever calls interface methods on it, and a test that had to write real files to exercise the
   * retry queue would be testing the disk instead of the queue.
   */
  constructor(
    private readonly local: JournalRepository,
    private readonly remote: JournalRepository,
    private readonly store: KeyValueStore = diskStore,
  ) {}

  private async loadPending(): Promise<Set<string>> {
    if (!this.pending) {
      const saved = await this.store.read<{ ids: string[] }>(PENDING_KEY);
      this.pending = new Set(saved?.ids ?? []);
    }
    return this.pending;
  }

  private async savePending(): Promise<void> {
    await this.store.write(PENDING_KEY, { ids: [...(this.pending ?? [])] });
  }

  /** Try the remote; on failure fall back to local and record that it happened. */
  private async viaRemote<T>(what: () => Promise<T>, fallback: () => Promise<T>): Promise<T> {
    try {
      const r = await what();
      this.lastPullAt = Date.now();
      this.degraded = false;
      this.servedFromLocal = false;
      return r;
    } catch (e) {
      this.degraded = true;
      this.servedFromLocal = true;
      this.lastError = String((e as Error).message);
      return fallback();
    }
  }

  /**
   * The database, UNIONED with anything local that is newer or that the database has not got yet.
   *
   * Reading the database alone was wrong in a way that only showed up on screen: a trade recorded
   * at 09:30 whose push had not landed was safe on disk and absent from the page, which reads as
   * "no alert fired" — the single most misleading thing this module could say. The union also
   * covers the edit-not-yet-pushed case, and it settles disagreements the same way `reconcile`
   * does, on `updatedAt`, so there is one rule for "whose copy is later" rather than two.
   */
  async range(from: string, to: string, channel?: JournalChannel | null): Promise<JournalTrade[]> {
    const theirs = await this.viaRemote(
      () => this.remote.range(from, to, channel),
      async () => [] as JournalTrade[],
    );
    const mine = await this.local.range(from, to, channel).catch(() => [] as JournalTrade[]);
    if (this.servedFromLocal) return mine;          // the database is unreachable; local is all there is
    return newestWins(theirs, mine);
  }

  /**
   * The union of both sides, and it has to be the union.
   *
   * This is the guard against journalling one alert twice. A trade written locally whose push has
   * not landed yet exists on disk and not in the database; asking only the database would report
   * it as new and record a duplicate on the next scan tick.
   */
  async existing(day: string): Promise<Set<string>> {
    const mine = await this.local.existing(day);
    try {
      for (const id of await this.remote.existing(day)) mine.add(id);
    } catch (e) {
      this.degraded = true;
      this.lastError = String((e as Error).message);
    }
    return mine;
  }

  mine(day: string): Promise<JournalTrade[]> {
    return this.local.mine(day);
  }

  unsettled(): Promise<JournalTrade[]> {
    // Local, deliberately. Settlement rewrites the trade and pushes it, so working from the local
    // copy means an unreachable database delays the push rather than skipping the settlement.
    return this.local.unsettled();
  }

  async one(id: string): Promise<JournalTrade | null> {
    const theirs = await this.viaRemote(() => this.remote.one(id), async () => null);
    const mine = await this.local.one(id).catch(() => null);
    if (this.servedFromLocal) return mine;
    if (!theirs) return mine;
    if (!mine) return theirs;
    return (mine.updatedAt ?? 0) > (theirs.updatedAt ?? 0) ? mine : theirs;
  }

  async save(trades: JournalTrade[]): Promise<void> {
    if (!trades.length) return;
    // Local first, always. See the note at the top of this file.
    await this.local.save(trades);
    const pending = await this.loadPending();
    try {
      await this.remote.save(trades);
      for (const t of trades) pending.delete(t.id);
      this.lastPushAt = Date.now();
      this.degraded = false;
      this.lastError = null;
    } catch (e) {
      for (const t of trades) pending.add(t.id);
      this.degraded = true;
      this.lastError = String((e as Error).message);
    }
    await this.savePending();
  }

  async flush(): Promise<void> {
    const pending = await this.loadPending();
    if (!pending.size) return;
    const trades: JournalTrade[] = [];
    for (const id of pending) {
      const t = await this.local.one(id);
      if (t) trades.push(t);
      else pending.delete(id);          // gone from disk; nothing left to push
    }
    if (!trades.length) { await this.savePending(); return; }
    try {
      await this.remote.save(trades);
      for (const t of trades) pending.delete(t.id);
      this.lastPushAt = Date.now();
      this.degraded = false;
      this.lastError = null;
    } catch (e) {
      this.degraded = true;
      this.lastError = String((e as Error).message);
    }
    await this.savePending();
  }

  /**
   * Push local history the database has never seen.
   *
   * Runs once on boot and does two jobs. It backfills the day a database is first configured —
   * otherwise every trade recorded before that afternoon would only ever exist on one machine. And
   * it is the safety net for a retry queue that was itself lost, which is the failure a queue
   * cannot cover for.
   */
  async reconcile(days: number): Promise<number> {
    const from = isoDaysAgo(days), to = isoDaysAgo(-1);
    let mine: JournalTrade[];
    let theirs: JournalTrade[];
    try {
      mine = await this.local.range(from, to);
      theirs = await this.remote.range(from, to);
    } catch (e) {
      this.degraded = true;
      this.lastError = String((e as Error).message);
      return 0;
    }
    const remoteById = new Map(theirs.map((t) => [t.id, t]));
    const push = mine.filter((t) => {
      // A row dated on a day the exchange was shut is not history to backfill. The holiday rows of
      // 2026-10-02 were deleted from the database, and without this the recording machine's own
      // copy would put them straight back on its next boot.
      if (!isSessionDay(t.day)) return false;
      const r = remoteById.get(t.id);
      return !r || (t.updatedAt ?? 0) > (r.updatedAt ?? 0);
    });
    if (!push.length) return 0;
    try {
      await this.remote.save(push);
      this.lastPushAt = Date.now();
      const pending = await this.loadPending();
      for (const t of push) pending.delete(t.id);
      await this.savePending();
      return push.length;
    } catch (e) {
      this.degraded = true;
      this.lastError = String((e as Error).message);
      return 0;
    }
  }

  async status(): Promise<JournalSyncStatus> {
    return {
      mode: 'mirror',
      remote: this.degraded ? 'degraded' : 'ok',
      pending: (await this.loadPending()).size,
      lastPushAt: this.lastPushAt,
      lastPullAt: this.lastPullAt,
      lastError: this.lastError,
      servedFromLocal: this.servedFromLocal,
    };
  }
}

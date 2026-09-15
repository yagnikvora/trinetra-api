// Disk persistence for the momentum module.
//
// The rest of the app already caches to `api/.cache`, so this follows it rather than
// introducing a second convention: JSON files under `api/.cache/momentum/`, outside `src`
// so a rebuild does not wipe them.
//
// Writes are atomic — tmp file then rename. That is not fussiness: the baseline is ~200
// symbols of volume profile and takes a few seconds to serialise, and a process killed
// mid-write would otherwise leave a truncated file that parses as "no baseline" on the next
// boot, silently taking RVOL off every row until someone noticed.
//
// The interfaces below (`KeyValueStore`, and the repositories built on it) exist so this is
// a DRIVER, not the design. Swapping in PostgreSQL is implementing the same three methods
// against `momentum_config` / `momentum_snapshot` / `momentum_history` — the schema is in
// `schema.sql` and nothing above this file knows which is in use.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..', '.cache', 'momentum');

export interface KeyValueStore {
  read<T>(key: string): Promise<T | null>;
  write<T>(key: string, value: T): Promise<void>;
  remove(key: string): Promise<void>;
}

export class FileStore implements KeyValueStore {
  constructor(private readonly root: string = ROOT) {}

  private file(key: string): string {
    // Keys are internal constants, but a traversal here would write outside .cache, so the
    // separator is stripped rather than trusted.
    return path.join(this.root, `${key.replace(/[^a-z0-9._-]/gi, '_')}.json`);
  }

  async read<T>(key: string): Promise<T | null> {
    try {
      return JSON.parse(await fs.readFile(this.file(key), 'utf8')) as T;
    } catch {
      return null;
    }
  }

  async write<T>(key: string, value: T): Promise<void> {
    const target = this.file(key);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(value), 'utf8');
    await fs.rename(tmp, target);
  }

  async remove(key: string): Promise<void> {
    await fs.unlink(this.file(key)).catch(() => {});
  }
}

/** The one store the module wires everywhere. Replace here to move to another backend. */
export const store: KeyValueStore = new FileStore();

export const STORE_KEYS = {
  config: 'config',
  baseline: 'baseline',
  history: 'history',
  snapshot: 'snapshot',
  session: 'session',
  /** Which trend-day confirmations have already been announced today. See alerts/trend-day.js. */
  trendAlerts: 'trend_alerts',
  /**
   * Which ignitions have already been announced today. Its own key rather than a field on
   * `trendAlerts` because the two alerts have independent lifecycles — one can be switched off
   * without silencing the other — and a shared record would couple them.
   */
  ignitionAlerts: 'ignition_alerts',
  /**
   * The trend-day and ignition channels' switches, as set from the UI. See alerts/settings.js.
   *
   * Holds only what somebody has actually CHANGED — a field absent from it falls back to what
   * `.env` supplied at boot — so a deployment that has never opened the panel behaves exactly as
   * it did before this key existed, and deleting the file restores the server's own settings.
   */
  alertSettings: 'alert_settings',
  /**
   * Which first-hour displacement signals have been announced today. See alerts/displacement.js.
   *
   * Its own key for the same reason `ignitionAlerts` has one: the three channels are switched on
   * and off independently, and a shared record would mean disabling one could silence another.
   */
  displacementAlerts: 'displacement_alerts',
  /**
   * Which of today's session bells have been sent, and the quotes used lately.
   *
   * Lives in this key set rather than its own store because the bells are not a momentum feature —
   * they are platform-level — and this is the only disk store the app has. It moved here from the
   * pullback module's key set when that module was removed; the old file is simply orphaned, and a
   * bell that re-fires once on the first morning after the change is the whole cost of that.
   */
  sessionBell: 'session_bell',
  /**
   * Settled contracts' own candle paths, one document a month, keyed by trade id.
   *
   * Kept because the source is perishable and the journal is not: once an option series expires
   * Upstox rejects its instrument key outright, so a path not saved before expiry can never be
   * fetched again. Without it the trades remain but no NEW exit rule can ever be tested against
   * them. See `archivePaths` in journal/journal.ts.
   */
  journalPaths: 'journal_paths',
  /**
   * What each alert channel considered but did not take, per month.
   *
   * Its own key rather than a field on the journal because a candidate is not a trade: it has no
   * contract, no money and no exit, and forcing it into the trade shape would mean a journal full
   * of rows that are not positions. See `alerts/candidates.ts`.
   */
  candidates: 'candidates',
  /**
   * Daily OHLC bars per symbol, so the baseline stops re-downloading 270 unchanged bars a
   * symbol on every build. See `data/daily-cache.ts` for what it does and does not save.
   */
  dailyBars: 'daily_bars',
} as const;

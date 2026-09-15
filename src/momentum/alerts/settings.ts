// The two alert channels' switches, settable from the UI instead of from the server's .env.
//
// WHY THIS EXISTS. `TREND_DAY_ALERTS`, `TREND_DAY_ALERT_MIN_CONVICTION`, `IGNITION_ALERTS` and
// `IGNITION_ALERT_MIN_EQ` are the four settings most likely to want changing on a live morning —
// a channel is too loud, or a floor is selecting the wrong entries — and all four lived in a file
// on the server that has to be edited through the hosting panel and then restarted. That is a
// deploy for a decision made in ten seconds, so in practice it did not happen and the floors
// stayed wherever they had last been set.
//
// WHAT IT DELIBERATELY DOES NOT DO: become a second source of truth. `enabled()`/`minConviction()`
// in trend-day.ts and their pair in ignition.ts remain the ONLY readers of these settings, and
// they still read `process.env`. This module writes that environment from a record on disk and
// the gates never learn it was involved. One reader and one rule everywhere is what keeps the
// running scan, `/momentum/status`, `/momentum/alerts/test` and `tools/trend-replay.ts` all
// agreeing about what the floor is — the property that is lost the moment a panel holds its own
// copy of a number the engine also holds.
//
// WHAT THE RECORD MEANS. Only fields somebody has actually SET are stored. Anything absent falls
// back to the value `.env` supplied at boot, captured here before a single override is applied so
// that `reset` can genuinely put it back. So the env file stays the deployment's default and this
// is an override on top of it, rather than a replacement that silently outranks a server-side
// edit nobody can see any more.
//
// WHEN A CHANGE TAKES EFFECT. On the next scan — fifteen seconds — because the gates are re-read
// on every tick rather than captured at boot. Nothing has to be restarted and nothing in flight
// is disturbed: a channel switched off mid-morning simply stops announcing, and the day's
// already-announced record is untouched, so switching it back on does not replay the morning.

import { store, STORE_KEYS } from '../store.js';
import { enabled as trendDayEnabled, minConviction } from './trend-day.js';
import { enabled as ignitionEnabled, minEntryQuality } from './ignition.js';

/** The four variables this module owns. Nothing else in the app writes them. */
const ENV = {
  trendDayEnabled: 'TREND_DAY_ALERTS',
  trendDayMinConviction: 'TREND_DAY_ALERT_MIN_CONVICTION',
  ignitionEnabled: 'IGNITION_ALERTS',
  ignitionMinEntryQuality: 'IGNITION_ALERT_MIN_EQ',
} as const;

/**
 * What `.env` said, captured at import — which is before any stored override can have been
 * applied, because applying one requires a disk read and therefore an await.
 *
 * This is the whole basis of "reset": without it, restoring the server's own setting would mean
 * re-reading a file the process loaded once at startup, and a value the panel had overwritten
 * would be unrecoverable for the life of the process.
 */
const BOOT: Record<string, string | undefined> = Object.fromEntries(
  Object.values(ENV).map((k) => [k, process.env[k]]),
);

/* ----------------------------------------------------------------------- the shape --- */

export interface AlertSettings {
  trendDay: { enabled: boolean; minConviction: number };
  ignition: { enabled: boolean; minEntryQuality: number };
}

/** A partial edit. Every field is optional; omitting one leaves it as it is. */
export interface AlertSettingsPatch {
  trendDay?: Partial<AlertSettings['trendDay']>;
  ignition?: Partial<AlertSettings['ignition']>;
}

interface StoredAlertSettings extends AlertSettingsPatch {
  updatedAt?: string;
  updatedBy?: string;
}

/** What the panel renders: the live values, plus which of them are overrides rather than .env. */
export interface AlertSettingsState {
  effective: AlertSettings;
  /** The stored overrides only — a field absent here is coming from the server's own .env. */
  overrides: AlertSettingsPatch;
  updatedAt: string | null;
  updatedBy: string | null;
}

/* -------------------------------------------------------------------- the applying --- */

const setEnv = (key: string, value: string | undefined): void => {
  // Deleted rather than set to '' when there is nothing to restore. The trend-day gate reads an
  // unset variable and an empty one identically, but the `=== 'on'` gates do not, and a variable
  // that exists with no value is a state .env cannot produce. Putting the environment back
  // exactly as it was found is the only definition of "restore" that cannot surprise a reader.
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
};

const onOff = (b: boolean): string => (b ? 'on' : 'off');

/**
 * Push a record into `process.env`, restoring the boot value for anything it does not set.
 *
 * Restoring rather than leaving the previous override in place is what makes clearing a field
 * mean anything — otherwise a patch could only ever add overrides and never take one away, and
 * the reset button would be a lie.
 */
function apply(rec: StoredAlertSettings): void {
  setEnv(
    ENV.trendDayEnabled,
    rec.trendDay?.enabled === undefined ? BOOT[ENV.trendDayEnabled] : onOff(rec.trendDay.enabled),
  );
  setEnv(
    ENV.trendDayMinConviction,
    rec.trendDay?.minConviction === undefined
      ? BOOT[ENV.trendDayMinConviction]
      : String(rec.trendDay.minConviction),
  );
  setEnv(
    ENV.ignitionEnabled,
    rec.ignition?.enabled === undefined ? BOOT[ENV.ignitionEnabled] : onOff(rec.ignition.enabled),
  );
  setEnv(
    ENV.ignitionMinEntryQuality,
    rec.ignition?.minEntryQuality === undefined
      ? BOOT[ENV.ignitionMinEntryQuality]
      : String(rec.ignition.minEntryQuality),
  );
}

/** The record as last read or written. Held so a patch can merge without a second disk read. */
let current: StoredAlertSettings = {};
let loaded: Promise<void> | null = null;

/**
 * Read the stored record once and apply it. Cheap and idempotent after the first call.
 *
 * Called from the engine immediately before the alert channels run, and from the endpoints that
 * report or edit these settings — rather than from a boot hook — so there is no ordering to get
 * wrong. A process that never scans and never opens the panel never pays for the read.
 *
 * Never rejects. A disk failure here must not be able to fail the scan that was about to send an
 * alert; the cost of one is a channel running on its .env settings, which is where it was before
 * this module existed.
 */
export async function ensureAlertOverrides(): Promise<void> {
  if (!loaded) {
    loaded = (async () => {
      const saved = await store.read<StoredAlertSettings>(STORE_KEYS.alertSettings).catch(() => null);
      if (saved) {
        current = saved;
        apply(saved);
      }
    })();
  }
  await loaded;
}

/* --------------------------------------------------------------------- the reading --- */

/**
 * What the channels are actually set to, asked of the gates themselves.
 *
 * Deliberately not computed from `current`: the gates own the defaults (65 and 80) and the
 * out-of-range handling, and a panel that recomputed them would drift from the engine the first
 * time one of those rules changed.
 */
export const effectiveAlertSettings = (): AlertSettings => ({
  trendDay: { enabled: trendDayEnabled(), minConviction: minConviction() },
  ignition: { enabled: ignitionEnabled(), minEntryQuality: minEntryQuality() },
});

export const alertSettingsState = (): AlertSettingsState => ({
  effective: effectiveAlertSettings(),
  overrides: {
    ...(current.trendDay ? { trendDay: { ...current.trendDay } } : {}),
    ...(current.ignition ? { ignition: { ...current.ignition } } : {}),
  },
  updatedAt: current.updatedAt ?? null,
  updatedBy: current.updatedBy ?? null,
});

/* --------------------------------------------------------------------- the writing --- */

/** Drop a channel key that ended up with nothing in it, so "not overridden" stays absent. */
const prune = <T extends object>(o: T): T | undefined => (Object.keys(o).length ? o : undefined);

export async function saveAlertSettings(
  patch: AlertSettingsPatch,
  updatedBy: string,
): Promise<AlertSettingsState> {
  await ensureAlertOverrides();

  const trendDay = prune({ ...current.trendDay, ...patch.trendDay });
  const ignition = prune({ ...current.ignition, ...patch.ignition });
  const next: StoredAlertSettings = {
    ...(trendDay ? { trendDay } : {}),
    ...(ignition ? { ignition } : {}),
    updatedAt: new Date().toISOString(),
    updatedBy,
  };

  await store.write(STORE_KEYS.alertSettings, next);
  current = next;
  apply(next);
  return alertSettingsState();
}

/** Forget every override and hand the four settings back to the server's .env. */
export async function resetAlertSettings(): Promise<AlertSettingsState> {
  await store.remove(STORE_KEYS.alertSettings);
  current = {};
  apply(current);
  loaded = Promise.resolve();
  return alertSettingsState();
}

/** Test seam — drops the in-memory record so the next call re-reads the store. */
export const forgetAlertOverrides = (): void => {
  current = {};
  loaded = null;
  apply(current);
};

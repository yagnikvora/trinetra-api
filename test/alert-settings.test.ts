// The alert panel — what a patch is allowed to say, and what the gates do when it is applied.
//
// TWO HALVES, AND THEY ARE THE WHOLE FEATURE. The panel edits four settings by writing the
// environment that `trend-day.ts` and `ignition.ts` already read, so what has to hold is that a
// bad patch never reaches that environment, and that a good one is obeyed by the gates exactly as
// a .env line would have been. Both are checked here without touching the disk: the store-backed
// half (`ensureAlertOverrides`, `saveAlertSettings`) writes to the one real cache directory this
// app has, and a test that reached into it would delete a floor somebody had set from the panel
// the moment they ran `npm test`.
//
// The environment is saved and restored around every case. These are process-global variables and
// a leaked one would not fail this file — it would fail whichever alert test ran next, which is
// the sort of failure that gets blamed on the wrong module for an hour.

import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { parseAlertSettingsPatch, isValidationError } from '../src/momentum/dto.js';
import { enabled as trendDayEnabled, minConviction } from '../src/momentum/alerts/trend-day.js';
import { enabled as ignitionEnabled, minEntryQuality } from '../src/momentum/alerts/ignition.js';

const KEYS = [
  'TREND_DAY_ALERTS', 'TREND_DAY_ALERT_MIN_CONVICTION', 'IGNITION_ALERTS', 'IGNITION_ALERT_MIN_EQ',
] as const;

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

/* -------------------------------------------------------------------- the patch --- */

describe('alert settings: what a patch may say', () => {
  it('takes one field and leaves the rest absent', () => {
    // The property the whole override model rests on: a patch says what CHANGED. Filling in the
    // other three here would turn every save into "freeze all four at today's values", and the
    // server's own .env would quietly stop applying to settings nobody had touched.
    assert.deepEqual(parseAlertSettingsPatch({ trendDay: { enabled: false } }), {
      trendDay: { enabled: false },
    });
  });

  it('accepts on/off as well as true/false', () => {
    const patch = parseAlertSettingsPatch({ trendDay: { enabled: 'off' }, ignition: { enabled: 'on' } });
    assert.equal(patch.trendDay?.enabled, false);
    assert.equal(patch.ignition?.enabled, true);
  });

  it('rounds a floor rather than refusing it', () => {
    // Both scores are integers everywhere they are produced and compared, so 82.6 off a slider is
    // a precision the model does not have — not an error to push back at whoever dragged it.
    assert.equal(parseAlertSettingsPatch({ trendDay: { minConviction: 82.6 } }).trendDay?.minConviction, 83);
  });

  it('refuses a floor outside 0-100, naming the field', () => {
    assert.throws(
      () => parseAlertSettingsPatch({ ignition: { minEntryQuality: 8200 } }),
      (e: unknown) => isValidationError(e) && e.issues[0].includes('ignition.minEntryQuality'),
    );
  });

  it('refuses a channel it does not own', () => {
    // Displacement has its own nine env settings and is NOT wired to this panel. Accepting the
    // key and ignoring it would leave a switch that looks saved and changes nothing.
    assert.throws(() => parseAlertSettingsPatch({ displacement: { enabled: true } }), isValidationError);
  });

  it('refuses a body that is not an object', () => {
    assert.throws(() => parseAlertSettingsPatch('trendDay=off'), isValidationError);
    assert.throws(() => parseAlertSettingsPatch({ trendDay: 82 }), isValidationError);
  });
});

/* --------------------------------------------------------------------- the gates --- */

describe('alert settings: what the gates do with them', () => {
  it('reads the same on/off the panel writes', () => {
    process.env.TREND_DAY_ALERTS = 'off';
    process.env.IGNITION_ALERTS = 'on';
    assert.equal(trendDayEnabled(), false);
    assert.equal(ignitionEnabled(), true);

    process.env.TREND_DAY_ALERTS = 'on';
    process.env.IGNITION_ALERTS = 'off';
    assert.equal(trendDayEnabled(), true);
    assert.equal(ignitionEnabled(), false);
  });

  it('defaults opposite ways, and that is deliberate', () => {
    // Unset means ON for the trend-day channel and OFF for ignition — the proven one speaks
    // unless silenced, the experimental one stays silent unless asked for. `resetAlertSettings`
    // restores absence, so this is what a panel reset lands on when .env says nothing either.
    assert.equal(trendDayEnabled(), true);
    assert.equal(ignitionEnabled(), false);
  });

  it('obeys a floor the panel set', () => {
    process.env.TREND_DAY_ALERT_MIN_CONVICTION = '88';
    process.env.IGNITION_ALERT_MIN_EQ = '71';
    assert.equal(minConviction(), 88);
    assert.equal(minEntryQuality(), 71);
  });

  it('falls back to the shipped floor rather than obeying nonsense', () => {
    // The panel cannot produce these — the DTO refuses them — but a hand-edited .env can, and a
    // floor of NaN compares false against every conviction, which is a silent dead channel.
    for (const bad of ['', 'high', '-4', '101']) {
      process.env.TREND_DAY_ALERT_MIN_CONVICTION = bad;
      process.env.IGNITION_ALERT_MIN_EQ = bad;
      assert.equal(minConviction(), 65, `TREND_DAY_ALERT_MIN_CONVICTION=${bad}`);
      assert.equal(minEntryQuality(), 80, `IGNITION_ALERT_MIN_EQ=${bad}`);
    }
  });
});

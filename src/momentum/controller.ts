// The HTTP surface. An Express Router, mounted at /momentum by `momentum/index.ts`.
//
// Response envelope matches the rest of this API — `{ payload: { data }, status, source }` —
// so the web client's existing `fetchData` works against it unchanged.
//
// `source` is load-bearing and is one of:
//   'upstox' a board computed from a live scan
//   'stale'  a real board from an earlier scan, re-served because Upstox is unreachable.
//            Carries `note` with its age. NEVER invented data — see snapshot.repository.ts.
//
// There is no mock. A fabricated momentum score is indistinguishable from a real one on
// screen and would be read as a trading signal, which is the one failure this module must
// not have.

import express, { type Request, type Response } from 'express';
import type { MomentumBoard, MomentumRow } from './types.js';
import { configRepository } from './config/config.repository.js';
import { buildMessages, previewAlerts, trendAlertStatus } from './alerts/trend-day.js';
import { ignitionAlertStatus } from './alerts/ignition.js';
import {
  alertSettingsState, ensureAlertOverrides, resetAlertSettings, saveAlertSettings,
} from './alerts/settings.js';
import { displacementAlertStatus } from './alerts/displacement.js';
import {
  exitLab, journalBoot, journalExitNow, journalPatch, journalRange, journalSettleDue,
  journalStatus, type ExitRule, type JournalChannel,
} from './journal/journal.js';
import { databaseUrl, getPool, probe } from './journal/postgres.js';
import { HTML, MARKDOWN } from '../alerts/markup.js';
import { previewBell, sessionBellStatus } from '../alerts/session-bell.js';
import { sendTelegram, telegramConfigured, telegramStatus } from '../alerts/telegram.js';
import { sendDiscord, discordConfigured, discordStatus } from '../alerts/discord.js';
import { runScan } from './engine/momentum.engine.js';
import { snapshotRepository, ageLabel } from './data/snapshot.repository.js';
import { ensureBaseline, getBaseline } from './data/baseline.js';
import { CANDLE_ENDPOINT } from './data/candles.js';
import { breakerState, paceState } from './data/throttle.js';
import { historyRepository } from './data/history.repository.js';
import { noteBaselineFailure, scanOnce, schedulerStatus } from './scheduler.js';
import { seedSession } from './data/session-seed.js';
import { cache, single } from './cache.js';
import {
  applySignalFilters, isValidationError, parseAlertSettingsPatch, parseBoardQuery, parseConfigPatch,
  parseSymbol,
} from './dto.js';
import { istDay, marketOpen } from './session.js';
import { tokenSet } from '../upstox.js';

const BOARD_KEY = 'momentum:board';
/** Once the market is shut the numbers are frozen; re-scanning would spend budget for free. */
const CLOSED_TTL_MS = 10 * 60_000;

type Source = 'upstox' | 'stale';

/** An IST date, or the fallback. Anything unparseable is the fallback rather than an error. */
const parseDay = (v: unknown, fallback: string): string =>
  typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : fallback;

const CHANNELS = new Set(['displacement', 'trend-day', 'ignition']);
/** `null` for "all", `false` for "that is not a channel". */
const parseChannel = (v: unknown): JournalChannel | null | false => {
  if (v === undefined || v === '' || v === 'all') return null;
  return typeof v === 'string' && CHANNELS.has(v) ? (v as JournalChannel) : false;
};

const send = <T>(res: Response, data: T, source: Source, note?: string) =>
  res.json({ payload: { data }, status: 'SUCCESS', source, ...(note ? { note } : {}) });

const fail = (res: Response, status: number, message: string, extra?: Record<string, unknown>) =>
  res.status(status).json({ status: 'ERROR', error: message, ...extra });

/**
 * The current board, from cache, then a live scan, then the last good one on disk.
 *
 * The scheduler is normally the thing that fills the cache; this path exists for the first
 * request after a boot and for a deployment running without the scheduler.
 */
async function currentBoard(): Promise<{ board: MomentumBoard; source: Source; note?: string }> {
  const cfg = await configRepository.get();
  const ttl = marketOpen() ? cfg.refresh.quoteMs : CLOSED_TTL_MS;

  try {
    const board = await single(BOARD_KEY, ttl, async () => {
      const fresh = await runScan(cfg);
      await snapshotRepository.save(fresh);
      return fresh;
    });
    return { board, source: 'upstox' };
  } catch (e) {
    const last = await snapshotRepository.last();
    if (!last) throw e;
    return {
      board: last.board,
      source: 'stale',
      note: `Upstox unreachable, showing the last live scan (${ageLabel(last.ageMs)} old): ${String((e as Error).message)}`,
    };
  }
}

/**
 * Drop the cached board after a configuration change.
 *
 * Both write paths must do this, and one of them originally did not: after a reset the API
 * reported the new config version while the board it served was still ranked under the old
 * weights, which is the worst of both — the screen says the model changed and the ranking
 * says it did not. Sharing one function is what stops the next endpoint forgetting.
 */
async function invalidateBoard(): Promise<void> {
  await cache.del(BOARD_KEY);
}

/** Every sample says so on its first line, so nothing sent from a test can be read as real. */
const bellBanner = (html: boolean) =>
  html ? '🧪 <b>SAMPLE — not the real bell</b>\n\n' : '🧪 **SAMPLE — not the real bell**\n\n';

/** Rows carry their full twelve-factor breakdown; the list view does not need it. */
const slim = (r: MomentumRow): Omit<MomentumRow, 'factors'> => {
  const { factors: _factors, ...rest } = r;
  return rest;
};

export function momentumRouter(): express.Router {
  const router = express.Router();
  router.use(express.json({ limit: '256kb' }));

  // ---------------------------------------------------------------- GET /momentum ----
  router.get('/', async (req: Request, res: Response) => {
    if (!tokenSet())
      return fail(res, 503, 'UPSTOX_ACCESS_TOKEN is not set — put your Upstox Analytics Token in api/.env');

    try {
      const cfg = await configRepository.get();
      const q = parseBoardQuery(req.query as Record<string, unknown>, cfg);
      const { board, source, note } = await currentBoard();

      let rows = board.rows.filter((r) => r.score >= q.minScore);
      if (q.direction) rows = rows.filter((r) => r.direction === q.direction);
      if (q.tradeType) rows = rows.filter((r) => r.tradeType === q.tradeType);
      if (q.confidence) rows = rows.filter((r) => r.confidence === q.confidence);
      if (q.sector) rows = rows.filter((r) => (r.sector ?? '').toUpperCase() === q.sector);
      rows = applySignalFilters(rows, q, cfg);

      send(
        res,
        {
          ...board,
          returned: Math.min(rows.length, q.limit),
          matched: rows.length,
          rows: rows.slice(0, q.limit).map((r) => (q.includeFactors ? r : slim(r))),
        },
        source,
        note,
      );
    } catch (e) {
      if (isValidationError(e)) return fail(res, 400, e.message, { issues: e.issues });
      fail(res, 502, String((e as Error).message));
    }
  });

  // -------------------------------------------------------- GET /momentum/signals ----
  //
  // The entry feed. Same board, ordered by ENTRY QUALITY rather than by score, and carrying
  // only the rows the timing layer has something to say about.
  //
  // It is a separate endpoint rather than a query parameter because it answers a different
  // question and is read at a different cadence: the board is "what is strong today" and is
  // browsed, this is "what can I take right now" and is polled. Ordering by score here would
  // put the most extended stock at the top, which is the failure the timing layer exists to
  // fix — so the sort key is deliberately the one number on the row that contains nothing
  // cumulative.
  router.get('/signals', async (req: Request, res: Response) => {
    if (!tokenSet())
      return fail(res, 503, 'UPSTOX_ACCESS_TOKEN is not set — put your Upstox Analytics Token in api/.env');

    try {
      const cfg = await configRepository.get();
      const q = parseBoardQuery(req.query as Record<string, unknown>, cfg);
      const { board, source, note } = await currentBoard();

      // Default to what is actionable; `?state=` or `?action=` overrides for a wider look.
      // `Trending` belongs in that default: a confirmed one-sided day waiting for its next dip
      // is the most actionable row this module produces, and leaving it out was how the whole
      // class of stock this scanner was rebuilt to find stayed invisible on the entry feed.
      const base = q.state || q.action
        ? board.rows
        : board.rows.filter(
            (r) =>
              r.signal &&
              (r.signal.state === 'Igniting' ||
                r.signal.state === 'Trending' ||
                r.signal.state === 'Extending'),
          );

      let rows = applySignalFilters(base, q, cfg);
      if (q.direction) rows = rows.filter((r) => r.direction === q.direction);
      if (q.sector) rows = rows.filter((r) => (r.sector ?? '').toUpperCase() === q.sector);
      rows = [...rows].sort((a, b) => (b.signal?.entryQuality ?? 0) - (a.signal?.entryQuality ?? 0));

      send(
        res,
        {
          asOf: board.asOf,
          configVersion: board.configVersion,
          market: board.market,
          igniting: board.igniting,
          entrable: board.entrable,
          matched: rows.length,
          returned: Math.min(rows.length, q.limit),
          maxTriggerAgeMin: cfg.signal.maxTriggerAgeMin,
          targetOptionMovePct: cfg.signal.targetOptionMovePct,
          rows: rows.slice(0, q.limit).map(slim),
          warnings: board.warnings,
        },
        source,
        note,
      );
    } catch (e) {
      if (isValidationError(e)) return fail(res, 400, e.message, { issues: e.issues });
      fail(res, 502, String((e as Error).message));
    }
  });

  // ---------------------------------------------------------- GET /momentum/trend ----
  //
  // The one-sided-day feed. A third endpoint rather than a query parameter, for the same
  // reason `/signals` is one: it answers a different question at a different cadence.
  //
  //   /            "what is strong today"          browsed, ranked by smoothed score
  //   /signals     "what can I take right now"     polled, ranked by entry quality
  //   /trend       "what is going one way all day" left open, ranked by conviction
  //
  // The third list is the stable one BY CONSTRUCTION, and that is the point of it. Its
  // ordering key is a measurement over hours behind a phase machine with hysteresis, so rows
  // do not move between polls — which is what makes it something you can leave on a second
  // monitor, and what the score-ranked board could never be.
  //
  // Faded days are carried separately rather than filtered away. A trend day that has stopped
  // being one is not a non-event: somebody is holding it on a thesis that just expired, and
  // that is the single most useful thing this endpoint can say.
  router.get('/trend', async (req: Request, res: Response) => {
    if (!tokenSet())
      return fail(res, 503, 'UPSTOX_ACCESS_TOKEN is not set — put your Upstox Analytics Token in api/.env');

    try {
      const cfg = await configRepository.get();
      const q = parseBoardQuery(req.query as Record<string, unknown>, cfg);
      const { board, source, note } = await currentBoard();

      if (!cfg.thresholds.conviction.enabled)
        return fail(res, 409, 'the conviction layer is switched off — set thresholds.conviction.enabled to true');

      // Sorted by conviction unless the caller asked otherwise, and filtered to real trend
      // days unless a specific phase was requested.
      const wanted = { ...q, sort: q.sort === 'rank' ? ('conviction' as const) : q.sort };
      const base = q.phase ? board.rows : board.rows.filter((r) => r.conviction?.phase !== 'None');
      let rows = applySignalFilters(base, wanted, cfg);
      if (q.direction) rows = rows.filter((r) => r.direction === q.direction);
      if (q.sector) rows = rows.filter((r) => (r.sector ?? '').toUpperCase() === q.sector);

      const faded = board.rows
        .filter((r) => r.conviction?.phase === 'Faded')
        .sort((a, b) => (b.conviction?.peak ?? 0) - (a.conviction?.peak ?? 0));

      send(
        res,
        {
          asOf: board.asOf,
          configVersion: board.configVersion,
          market: board.market,
          trendConfirmed: board.trendConfirmed,
          trendForming: board.trendForming,
          trendFaded: board.trendFaded,
          matched: rows.length,
          returned: Math.min(rows.length, q.limit),
          phase: {
            confirmedFrom: cfg.thresholds.conviction.phase.minMinutesConfirmed,
            formingFrom: cfg.thresholds.conviction.phase.minMinutesForming,
          },
          rows: rows.slice(0, q.limit).map((r) => (q.includeFactors ? r : slim(r))),
          // Not part of `rows`, so a client rendering the list cannot accidentally present a
          // faded day as a candidate.
          fading: faded.slice(0, 10).map(slim),
          warnings: board.warnings,
        },
        source,
        note,
      );
    } catch (e) {
      if (isValidationError(e)) return fail(res, 400, e.message, { issues: e.issues });
      fail(res, 502, String((e as Error).message));
    }
  });

  // --------------------------------------------------------- GET /momentum/config ----
  // Declared before /:symbol, or "config" is parsed as a stock.
  router.get('/config', async (_req, res) => {
    send(res, await configRepository.get(), 'upstox');
  });

  // --------------------------------------------------------- PUT /momentum/config ----
  router.put('/config', async (req: Request, res: Response) => {
    try {
      const patch = parseConfigPatch(req.body);
      const by = String(req.header('x-admin-user') ?? 'admin');
      const next = await configRepository.save(patch, by);
      await invalidateBoard();
      send(res, next, 'upstox');
    } catch (e) {
      if (isValidationError(e)) return fail(res, 400, e.message, { issues: e.issues });
      fail(res, 500, String((e as Error).message));
    }
  });

  // ------------------------------------------------------- POST /momentum/config/reset
  router.post('/config/reset', async (req: Request, res: Response) => {
    const by = String(req.header('x-admin-user') ?? 'admin');
    const next = await configRepository.reset(by);
    await invalidateBoard();
    send(res, next, 'upstox');
  });

  // ----------------------------------------------- GET /momentum/alerts/settings ----
  //
  // The two phone channels' switches. Their own endpoints rather than a section of
  // `/momentum/config`, because they are not part of the scoring model: saving the config bumps
  // its version, stamps an author and invalidates the cached board so every row is re-scored,
  // and none of that is the right response to somebody muting a channel for an afternoon.
  //
  // `ensureAlertOverrides` before every one of these, for the same reason it is called before the
  // channels run: the record is read from disk exactly once per process and nothing guarantees a
  // scan happened first, so a panel opened on a freshly booted server would otherwise report the
  // .env settings while the first scan was still on its way to applying the stored ones.
  router.get('/alerts/settings', async (_req, res) => {
    await ensureAlertOverrides();
    send(res, alertSettingsState(), 'upstox');
  });

  // ----------------------------------------------- PUT /momentum/alerts/settings ----
  // Partial: a body of `{ "trendDay": { "enabled": false } }` mutes that channel and leaves the
  // other three settings exactly as they were, so the panel can save one switch without having to
  // hold and re-send a consistent view of all four.
  router.put('/alerts/settings', async (req: Request, res: Response) => {
    try {
      const patch = parseAlertSettingsPatch(req.body);
      const by = String(req.header('x-admin-user') ?? 'admin');
      send(res, await saveAlertSettings(patch, by), 'upstox');
    } catch (e) {
      if (isValidationError(e)) return fail(res, 400, e.message, { issues: e.issues });
      fail(res, 500, String((e as Error).message));
    }
  });

  // ---------------------------------------- POST /momentum/alerts/settings/reset ----
  // Hands all four settings back to the server's own .env. The deploy stays the default; this
  // endpoint is what makes that true rather than a claim, since without it an override applied
  // once could never be taken off for the life of the process.
  router.post('/alerts/settings/reset', async (_req, res) => {
    send(res, await resetAlertSettings(), 'upstox');
  });

  // --------------------------------------------------------- GET /momentum/status ----
  router.get('/status', async (_req, res) => {
    await ensureAlertOverrides();
    const [status, baseline, cfg] = await Promise.all([schedulerStatus(), getBaseline(), configRepository.get()]);
    send(res, {
      ...status,
      marketOpen: marketOpen(),
      // Surfaced because a tripped breaker is the difference between "the baseline is
      // building" and "the baseline cannot build for another four minutes", and those look
      // identical from the outside.
      rateLimit: breakerState(CANDLE_ENDPOINT),
      // What the governor has actually let through lately. `lastMinute` sitting at the cap is a
      // build being paced correctly; the breaker being open with `lastMinute` near zero is a
      // budget spent by a PREVIOUS process, which no amount of local pacing can see.
      pace: paceState(CANDLE_ENDPOINT),
      configVersion: cfg.version,
      configUpdatedAt: cfg.updatedAt,
      shortlistSize: cfg.universe.shortlistSize,
      refresh: cfg.refresh,
      // The trend-day confirmation alerts. `announcedToday` stuck at 0 through an afternoon of
      // confirmed rows is the symptom to watch for — it separates a quiet tape from a dead channel.
      trendAlerts: trendAlertStatus(),
      // The early-entry alert. Reported beside the trend-day one because the pair is the whole
      // story: `trendAlerts` fires on a day being proven and cannot do so before 10:30, this one
      // fires on a move starting. `enabled: false` here with a quiet morning is the answer to
      // "why did I only hear about that stock after it had already run".
      ignitionAlerts: ignitionAlertStatus(),
      // The first-hour displacement alert. `windowOpen` is the field to read first: this
      // channel is only alive between 09:27 and 10:00, so `announcedToday: 0` at noon is the
      // normal state and says nothing about health. `lastScanMinute` is what separates a
      // channel that looked and found nothing from one that never ran.
      displacementAlerts: displacementAlertStatus(),
      // The trade journal. `today.unsettled` above zero after 15:20 is the field that matters:
      // it means positions were opened and their exits have not been priced from candles yet.
      journal: await journalStatus(),
      // The 09:15 and 15:30 bells. Carries which of today's have gone out, so a morning with no
      // greeting can be told apart from a morning the process slept through.
      sessionBell: await sessionBellStatus(),
      // `failures` alone stopped being the useful number once readings started being carried
      // forward: a symbol today's build could not fetch is counted there AND still holds a
      // usable ATR from an earlier one. `carried` and `builtToday` split it into the two facts
      // worth acting on — how much of this baseline is actually today's work, and how much is
      // riding on an older session and wants a rebuild with a clean request budget.
      baseline: baseline.baseline
        ? {
            day: baseline.baseline.day,
            stale: baseline.stale,
            symbols: Object.keys(baseline.baseline.symbols).length,
            builtToday:
              Object.keys(baseline.baseline.symbols).length - (baseline.baseline.carried ?? 0),
            carried: baseline.baseline.carried ?? 0,
            failures: Object.keys(baseline.baseline.failures).length,
          }
        : null,
    }, 'upstox');
  });

  // ------------------------------------------ GET|POST /momentum/alerts/test ----
  //
  // Send one trend-day confirmation to the phone, now, so the channel and the layout can be
  // proved without waiting for 10:30 tomorrow.
  //
  // GET as well as POST, deliberately. A send is not idempotent and normally has no business on a
  // GET, but the whole value of this endpoint is being a link you can open — a POST-only version
  // means finding a terminal, which is exactly the friction that stops anyone checking their alerts
  // until the morning one fails. It is a localhost dev API, nothing here mutates the board, and
  // every message it sends is stamped SAMPLE on its first line.
  //
  //   /momentum/alerts/test            one stock, the highest conviction on the board
  //   /momentum/alerts/test?count=3    three, so the batched 10:30 layout can be read
  //   /momentum/alerts/test?demo=1     the full layout with levels and a contract, any hour
  //   /momentum/alerts/test?bell=open  the 09:15 good morning (or `close` for 15:30)
  //
  // The default is built from the REAL board, so it exercises the chain fetch and the strike
  // selection too. Out of hours that is honestly incomplete — entry, stop and target come off the
  // pulse's ATR, which is dark until the quote ring refills after the open — so the response names
  // what was missing rather than the message inventing it, and `?demo=1` covers the format check
  // in the meantime on a symbol called SAMPLE that nobody can trade by mistake.
  const alertTest = async (req: Request, res: Response) => {
    if (!telegramConfigured() && !discordConfigured())
      return fail(res, 503, 'No phone channel is configured', {
        hint: 'set PULLBACK_TELEGRAM_BOT_TOKEN + PULLBACK_TELEGRAM_CHAT_ID and/or PULLBACK_DISCORD_WEBHOOK_URL in api/.env, then restart the API',
      });

    try {
      const cfg = await configRepository.get();
      const count = Math.max(1, Math.min(Number(req.query.count) || 1, 8));
      // `?bell=open|close` previews a SESSION BELL instead of a confirmation. The two live on one
      // endpoint because they share the channels, and a single link that proves "my phone works"
      // beats two that each prove half of it.
      const bell = String(req.query.bell ?? '');
      if (bell === 'open' || bell === 'close') {
        const preview = await previewBell(bell);
        const [tg, dc] = await Promise.all([
          telegramConfigured() ? sendTelegram(bellBanner(true) + preview.html) : Promise.resolve(null),
          discordConfigured() ? sendDiscord(bellBanner(false) + preview.markdown) : Promise.resolve(null),
        ]);
        const out = {
          sample: `the ${bell === 'open' ? '09:15 good-morning' : '15:30 session-closed'} bell`,
          telegram: tg === null ? { skipped: 'not configured' } : { sent: tg, ...telegramStatus() },
          discord: dc === null ? { skipped: 'not configured' } : { sent: dc, ...discordStatus() },
          live: await sessionBellStatus(),
        };
        if (tg === false || dc === false) return fail(res, 502, 'A configured channel refused the message', out);
        return send(res, out, 'upstox');
      }

      const demo = String(req.query.demo ?? '') !== '' && String(req.query.demo) !== '0';
      const { board, source, note } = await currentBoard();
      const { alerts, basis } = await previewAlerts(board.rows, cfg, board.asOf, count, demo);

      // Rendered once per dialect from the SAME alert objects, so the two phones cannot show
      // different numbers for the same test.
      const banner = (html: boolean) =>
        html
          ? '🧪 <b>SAMPLE — not a live confirmation</b>\n\n'
          : '🧪 **SAMPLE — not a live confirmation**\n\n';

      // A batch too big for one message is split rather than trimmed, so the preview has to send
      // every page — a test that only ever delivers page one would prove the layout and hide the
      // thing most worth checking before 10:30, which is how a three-message stampede reads.
      const sendPages = async (
        pages: string[],
        one: (text: string, i: number) => Promise<boolean>,
      ): Promise<boolean> => {
        let ok = true;
        for (let i = 0; i < pages.length; i++) ok = (await one(pages[i], i)) && ok;
        return ok;
      };

      const html = buildMessages(alerts, HTML, board.asOf);
      const md = buildMessages(alerts, MARKDOWN, board.asOf);

      const [tg, dc] = await Promise.all([
        telegramConfigured()
          ? sendPages(html, (text, i) => sendTelegram((i === 0 ? banner(true) : '') + text))
          : Promise.resolve(null),
        discordConfigured()
          ? sendPages(md, (text, i) => sendDiscord((i === 0 ? banner(false) : '') + text, alerts[0].direction))
          : Promise.resolve(null),
      ]);

      // Baseline coverage, because it is the ONE thing that decides whether a stock can carry a
      // stop and a target at all. The ATR comes from the daily build, `buildPlan` refuses without
      // it, and a build that ran out of request budget leaves a silent hole: those symbols confirm
      // trend days all day and get announced with no levels. Reported here so "why has this one no
      // contract" is answerable from the same response rather than by reading a cache file.
      const bl = await getBaseline();
      const covered = bl.baseline ? Object.keys(bl.baseline.symbols).length : 0;
      const failed = bl.baseline ? Object.keys(bl.baseline.failures).length : 0;

      const result = {
        sample: basis,
        board: { source, asOf: board.asOf, trendConfirmed: board.trendConfirmed, ...(note ? { note } : {}) },
        symbols: alerts.map((a) => a.symbol),
        // How many notifications this batch actually costs. The split is capped, so this is also
        // the answer to "did anything fall off the end" without opening the phone.
        pages: html.length || md.length,
        // The two absences worth knowing about, named rather than left to be noticed on the phone.
        missing: {
          plan: alerts.filter((a) => !a.plan).map((a) => a.symbol),
          contract: alerts.filter((a) => !a.strike).map((a) => a.symbol),
        },
        baseline: {
          day: bl.baseline?.day ?? null,
          stale: bl.stale,
          covered,
          failed,
          // The symbols in this very sample that the baseline never reached — the direct answer to
          // "why is there no stop on this one".
          noAtrInSample: alerts
            .filter((a) => a.symbol !== 'SAMPLE' && !bl.baseline?.symbols[a.symbol])
            .map((a) => a.symbol),
          ...(failed > 0
            ? { hint: `${failed} symbols have no ATR today — POST /momentum/baseline/rebuild refills it (~416 requests)` }
            : {}),
        },
        telegram: tg === null ? { skipped: 'not configured' } : { sent: tg, ...telegramStatus() },
        discord: dc === null ? { skipped: 'not configured' } : { sent: dc, ...discordStatus() },
        live: trendAlertStatus(),
      };
      if (tg === false || dc === false) return fail(res, 502, 'A configured channel refused the message', result);
      send(res, result, 'upstox');
    } catch (e) {
      fail(res, 502, String((e as Error).message));
    }
  };

  router.get('/alerts/test', alertTest);
  router.post('/alerts/test', alertTest);

  // ----------------------------------------------- POST /momentum/baseline/rebuild ----
  // ~416 upstream requests, so it answers immediately and builds behind the response
  // rather than holding a connection open for the couple of minutes it takes.
  router.post('/baseline/rebuild', async (req, res) => {
    const cfg = await configRepository.get();
    // Resumes by default — a repeat call spends its budget on the symbols the last pass never
    // reached rather than re-fetching the ones it did. `?full=1` forces every symbol, which is
    // what a corporate action wants and what a merely-incomplete baseline does not.
    const full = String(req.query.full ?? '') !== '' && String(req.query.full) !== '0';
    void ensureBaseline({
      atrPeriod: cfg.thresholds.atrExpansion.period,
      trendLookback: cfg.thresholds.trendStructure.lookbackSessions,
      full,
    }).catch((e) => {
      // RECORDED, NOT SWALLOWED. This used to be `.catch(() => {})`, which meant a rebuild that
      // failed left `lastError: null` on /momentum/status — indistinguishable from one that had
      // never been asked for. Diagnosing a build that dies on its first request was impossible
      // from the API alone; you had to run the CLI tool to see the 429.
      noteBaselineFailure(`manual rebuild failed: ${String((e as Error).message)}`);
      console.error(`[momentum] manual baseline rebuild failed: ${String((e as Error).message)}`);
    });
    send(
      res,
      {
        started: true,
        mode: full ? 'full' : 'resume',
        note: full
          ? 'rebuilding every symbol — poll GET /momentum/status for progress'
          : 'building the symbols that have no reading yet — poll GET /momentum/status, and call again if any remain',
      },
      'upstox',
    );
  });

  // --------------------------------------------------------- POST /momentum/seed ----
  //
  // Rebuild today's session from the exchange's 1-minute candles. The scheduler already does
  // this once per process per day; this is the escape hatch for the two cases it cannot cover:
  // a boot that landed in a spent candle quota, and wanting to re-measure the morning after
  // changing a conviction threshold.
  //
  // `?force=true` re-seeds even the symbols this process watched from the open. That is a
  // DOWNGRADE — a 1-minute replay is coarser than the live 15-second record — so it is opt-in
  // rather than the default. Like the baseline rebuild, it answers immediately and works
  // behind the response, because ~208 candle requests outlive any sensible request timeout.
  router.post('/seed', async (req: Request, res: Response) => {
    if (!tokenSet())
      return fail(res, 503, 'UPSTOX_ACCESS_TOKEN is not set — put your Upstox Analytics Token in api/.env');

    const force = String(req.query.force ?? '') === 'true';
    void seedSession({ force }).then(() => cache.del(BOARD_KEY)).catch(() => {});
    send(res, {
      started: true,
      force,
      note: 'rebuilding today’s session from 1-minute candles — poll GET /momentum/status for progress',
    }, 'upstox');
  });

  // --------------------------------------------------- POST /momentum/scan (manual) ----
  router.post('/scan', async (_req, res) => {
    await cache.del(BOARD_KEY);
    await scanOnce();
    const { board, source, note } = await currentBoard();
    send(res, { asOf: board.asOf, scored: board.scored, shortlisted: board.shortlisted }, source, note);
  });

  // ------------------------------------------------- GET /momentum/journal ------------
  //
  // Declared BEFORE `/:symbol`, or Express matches "journal" as a stock symbol.
  //
  // `from`/`to` are IST session dates. Both default to today, which is the reading this exists
  // for — the day, at night, after the market has settled it.
  router.get('/journal', async (req: Request, res: Response) => {
    try {
      const today = istDay();
      const from = parseDay(req.query.from, today);
      const to = parseDay(req.query.to, from);
      if (to < from) return fail(res, 400, '`to` is before `from`');
      const channel = parseChannel(req.query.channel);
      if (channel === false) return fail(res, 400, 'channel must be displacement, trend-day or ignition');
      // Once per process, and here as well as in the scheduler so `npm run viewer` — which has no
      // scheduler — still pushes any local history the database has not seen.
      await journalBoot();
      const view = await journalRange(from, to, channel);
      // Journal rows are read off disk and are complete whether or not Upstox is reachable, so
      // the envelope's source says where the PRICES came from, not where the rows did.
      send(res, view, 'upstox');
    } catch (e) {
      fail(res, 500, String((e as Error).message));
    }
  });

  // ------------------------------------- POST /momentum/journal/exit-lab -------------
  //
  // Re-grade the real trades in a range under exit rules supplied by the caller, on the archived
  // 1-minute option paths. This is `tools/exit-lab.ts` as an endpoint, so the question "what would
  // a different stop have made" can be asked from the journal page instead of a terminal.
  //
  // DECLARED BEFORE `/journal/:id`, or Express matches "exit-lab" as a trade id.
  //
  // POST rather than GET because the body is a list of rules, and because the answer is derived
  // rather than fetched — there is nothing here worth a cache key.
  router.post('/journal/exit-lab', async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as {
        from?: unknown; to?: unknown; channel?: unknown; rules?: unknown;
      };
      const today = istDay();
      const from = parseDay(body.from, '2000-01-01');
      const to = parseDay(body.to, today);
      if (to < from) return fail(res, 400, '`to` is before `from`');
      const channel = parseChannel(body.channel);
      if (channel === false) return fail(res, 400, 'channel must be displacement, trend-day or ignition');

      if (!Array.isArray(body.rules) || body.rules.length === 0)
        return fail(res, 400, 'rules must be a non-empty array');
      // Capped because each rule is a full walk of every archived path. Forty is far more than a
      // sweep needs and still answers in well under a second.
      if (body.rules.length > 40) return fail(res, 400, 'at most 40 rules at a time');

      const rules: ExitRule[] = [];
      for (const raw of body.rules as Array<Record<string, unknown>>) {
        const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
        const tp = num(raw.tp);
        const sl = num(raw.sl);
        // A stop at or below −100% can never be hit and a target at zero is hit instantly; both
        // produce a number that looks like an answer and is not one.
        if (tp === null || tp <= 0 || tp > 20) return fail(res, 400, 'tp must be between 0 and 20 (as a fraction)');
        if (sl === null || sl <= 0 || sl >= 1) return fail(res, 400, 'sl must be between 0 and 1 (as a fraction)');
        const armAt = num(raw.armAt);
        const lock = num(raw.lock);
        const trail = raw.trail === 'breakeven' ? 'breakeven' as const : num(raw.trail);
        rules.push({
          name: String(raw.name ?? `+${Math.round(100 * tp)}/-${Math.round(100 * sl)}`).slice(0, 40),
          tp,
          sl,
          ...(armAt !== null && armAt > 0 ? { armAt } : {}),
          ...(lock !== null ? { lock } : {}),
          ...(trail !== null ? { trail } : {}),
        });
      }

      send(res, await exitLab(from, to, channel, rules), 'upstox');
    } catch (e) {
      fail(res, 500, String((e as Error).message));
    }
  });

  // ---------------------------------------- PATCH /momentum/journal/:id ---------------
  //
  // Replace the auto-recorded prices with the fill actually received. An edited row is flagged
  // and settlement stops touching it — see the note in journal.ts.
  router.patch('/journal/:id', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const money = (v: unknown): number | undefined => {
      if (v === undefined || v === null || v === '') return undefined;
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0 || n > 1e7) throw new Error('price must be between 0 and 10,000,000');
      return n;
    };
    try {
      const t = await journalPatch(String(req.params.id), {
        entryPremium: money(body.entryPremium),
        exitPremium: money(body.exitPremium),
        lots: body.lots === undefined ? undefined : Number(body.lots),
        note: body.note === undefined ? undefined : String(body.note),
        reset: body.reset === true,
      });
      if (!t) return fail(res, 404, `no journal trade with id ${req.params.id}`);
      send(res, t, 'upstox');
    } catch (e) {
      fail(res, 400, String((e as Error).message));
    }
  });

  // ----------------------------------- POST /momentum/journal/:id/exit ---------------
  //
  // Sell ONE open position at the live bid, right now, because the operator just did.
  //
  // Separate from PATCH rather than folded into it because the two mean different things. PATCH
  // corrects a price the app already recorded; this ENDS a position that is still running, and
  // the price it writes comes from the feed at the instant of the click rather than from the
  // caller. Nothing is sent to a broker — this records the exit, it does not place it.
  router.post('/journal/:id/exit', async (req: Request, res: Response) => {
    try {
      const t = await journalExitNow(String(req.params.id));
      if (!t) return fail(res, 404, `no journal trade with id ${req.params.id}`);
      send(res, t, 'upstox');
    } catch (e) {
      // 409, not 400: the request was well formed and the refusal is about the state of the
      // trade or of the feed, which is a thing the page can tell the operator to act on.
      fail(res, 409, String((e as Error).message));
    }
  });

  // ------------------------------------------ GET /momentum/journal/sync -------------
  //
  // Proves the shared store end to end: connect, create the table, write a row, read it back,
  // delete it, count what is stored. The same steps `npm run check-neon` runs, exposed over HTTP
  // so the page can offer a button rather than asking anyone to open a terminal.
  //
  // Never returns the connection string. The host and database name are echoed because "am I
  // pointed at the right project" is a real question; the credentials in it are not an answer.
  router.get('/journal/sync', async (_req, res) => {
    const url = databaseUrl();
    if (!url)
      return send(res, {
        configured: false,
        note: 'DATABASE_URL is not set — the journal is on local disk only, on this machine.',
        steps: [],
      }, 'upstox');
    let host = 'unparseable DATABASE_URL';
    try { const u = new URL(url); host = `${u.hostname}${u.pathname}`; } catch { /* keep the label */ }
    try {
      const steps = await probe(getPool());
      const ok = steps.every((s) => s.ok);
      send(res, { configured: true, host, ok, steps }, 'upstox',
        ok ? undefined : 'the shared store is not usable — see the failing step');
    } catch (e) {
      send(res, { configured: true, host, ok: false, steps: [{ step: 'connect', ok: false, detail: String((e as Error).message) }] }, 'upstox');
    }
  });

  // --------------------------------------- POST /momentum/journal/settle -------------
  //
  // Force the settlement pass. The scheduler runs it every two minutes anyway; this is for a
  // process that has just been started to catch up a backlog without waiting.
  router.post('/journal/settle', async (_req, res) => {
    if (!tokenSet())
      return fail(res, 503, 'UPSTOX_ACCESS_TOKEN is not set — settlement reads the contract’s own candles');
    try {
      const settled = await journalSettleDue();
      send(res, { settled }, 'upstox', settled ? undefined : 'nothing was outstanding');
    } catch (e) {
      fail(res, 502, String((e as Error).message));
    }
  });

  // -------------------------------------------------------- GET /momentum/:symbol ----
  router.get('/:symbol', async (req: Request, res: Response) => {
    if (!tokenSet())
      return fail(res, 503, 'UPSTOX_ACCESS_TOKEN is not set — put your Upstox Analytics Token in api/.env');

    try {
      const symbol = parseSymbol(req.params.symbol);
      const { board, source, note } = await currentBoard();
      const row = board.rows.find((r) => r.symbol === symbol);

      if (!row)
        return fail(res, 404, `${symbol} is not in the current momentum board`, {
          hint: 'it may be outside the F&O universe, below the configured price/turnover floor, or below minCoverage',
        });

      const history = await historyRepository.forSymbol(symbol);

      send(
        res,
        {
          asOf: board.asOf,
          configVersion: board.configVersion,
          market: board.market,
          row,
          // The score's own trail through past sessions, for the detail page's sparkline.
          history: history.slice(-60).map((h) => ({
            day: h.day, score: h.score, close: h.close, direction: h.direction,
            rvol: h.rvol, atmIv: h.atmIv, hv20: h.hv20,
          })),
          warnings: board.warnings,
        },
        source,
        note,
      );
    } catch (e) {
      if (isValidationError(e)) return fail(res, 400, e.message, { issues: e.issues });
      fail(res, 502, String((e as Error).message));
    }
  });

  return router;
}

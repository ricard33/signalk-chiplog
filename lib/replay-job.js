const { conflict } = require('./errors');
const { createHistoryApiHistory } = require('./history-api');
const { createInfluxHistory } = require('./influx-history');
const { runWindowedReplay } = require('./replay');

const iso = (ms) => new Date(ms).toISOString();

// One reconstruction at a time, run in the background: POST /replay starts
// it and returns immediately, GET /replay polls status() for progress.
function createReplayJob({
  db,
  settings,
  app,
  clock = Date.now,
  log = () => {},
  fetch = globalThis.fetch,
  onDone = () => {},
  retryDelayMs
}) {
  let current = null;
  let lastResult = null;
  let lastError = null;

  // The replay drives the exact same detection/track/event modules as live
  // detection, against the same database -- a passage still open belongs to
  // the live detector, and a replay stepping through it at the same time
  // would corrupt it, whatever date range is asked for.
  function navigationActive() {
    return Boolean(db.prepare("SELECT 1 FROM log_entries WHERE state = 'active' LIMIT 1").get());
  }

  function overlapsExisting(from, to) {
    return Boolean(
      db
        .prepare(
          `SELECT 1 FROM log_entries
           WHERE start_time < ? AND (end_time IS NULL OR end_time > ?) LIMIT 1`
        )
        .get(to, from)
    );
  }

  function lastEntryId() {
    return db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM log_entries').get().id;
  }

  // What a run added: the passages created after `afterId` within its range
  // -- a live passage opened meanwhile starts after it -- and their totals.
  function summarise(afterId, to) {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS passages,
           COALESCE(SUM(distance), 0) AS distance,
           COALESCE(SUM(engine_duration), 0) AS engineDuration,
           COALESCE(SUM(sail_duration), 0) AS sailDuration,
           (SELECT COUNT(*) FROM track_points WHERE entry_id IN
              (SELECT id FROM log_entries WHERE id > ? AND start_time < ?)) AS trackPoints,
           (SELECT COUNT(*) FROM events WHERE entry_id IN
              (SELECT id FROM log_entries WHERE id > ? AND start_time < ?)) AS events
         FROM log_entries WHERE id > ? AND start_time < ?`
      )
      .get(afterId, to, afterId, to, afterId, to);
    return { ...row };
  }

  // Both history sources are bounded and retried the same way, and report a
  // retry in flight the same way, so the webapp shows a busy provider rather
  // than a run that looks stalled whichever one is reading.
  function onRetry(attempt, of, message) {
    if (attempt !== null) {
      log(
        'error',
        `Retrospective replay: history query timed out, retrying (attempt ${attempt}/${of}): ${message}`
      );
    }
    if (current) {
      current.retry = attempt === null ? null : { attempt, of, message };
    }
  }

  async function perform(from, to, signal) {
    const afterId = lastEntryId();
    try {
      const history =
        settings.retrospectiveHistorySource === 'signalk'
          ? createHistoryApiHistory({
              getHistoryApi: app.getHistoryApi,
              selfContext: settings.influxSelfContext || app.selfContext,
              queryTimeoutSeconds: settings.influxQueryTimeoutSeconds,
              signal,
              retryDelayMs,
              onRetry
            })
          : createInfluxHistory({
              protocol: settings.influxProtocol,
              host: settings.influxHost,
              port: settings.influxPort,
              database: settings.influxDatabase,
              username: settings.influxUsername,
              password: settings.influxPassword,
              selfContext: settings.influxSelfContext || app.selfContext,
              queryTimeoutSeconds: settings.influxQueryTimeoutSeconds,
              fetch,
              signal,
              retryDelayMs,
              onRetry
            });
      await runWindowedReplay({
        db,
        settings,
        history,
        from,
        to,
        signal,
        onPhase: (phase) => {
          if (current) {
            current.phase = phase;
          }
        },
        onProgress: (nowMs) => {
          if (current) {
            current.now = iso(nowMs);
            // Recomputed each slice so the webapp can show what has actually
            // been committed so far, not just how far the clock has got --
            // the only way to know anything was saved if the run then times
            // out or otherwise fails.
            current.summary = summarise(afterId, to);
          }
        }
      });
      lastResult = { at: iso(clock()), from, to, summary: summarise(afterId, to) };
    } catch (err) {
      if (err.name === 'AbortError') {
        lastResult = {
          at: iso(clock()),
          from,
          to,
          cancelled: true,
          summary: summarise(afterId, to)
        };
      } else {
        lastError = {
          at: iso(clock()),
          from,
          to,
          message: err.message,
          summary: summarise(afterId, to)
        };
        log('error', `Retrospective replay failed (${from} to ${to}): ${err.message}`);
      }
    } finally {
      current = null;
      // A completed or partial replay can leave newly-pending place names;
      // let the caller wake its own naming chain rather than have it wait
      // out whatever backoff it was already in.
      onDone();
    }
  }

  return {
    start(from, to) {
      if (
        settings.retrospectiveHistorySource !== 'signalk' &&
        (!settings.influxHost || !settings.influxDatabase)
      ) {
        throw conflict(
          'replay_not_configured',
          'Set the InfluxDB connection in the plugin configuration first'
        );
      }
      if (current) {
        throw conflict('replay_running', 'A retrospective replay is already running');
      }
      if (navigationActive()) {
        throw conflict(
          'replay_navigation_active',
          'A passage is under way; stop or close it before running a retrospective replay'
        );
      }
      if (overlapsExisting(from, to)) {
        throw conflict(
          'replay_overlaps',
          'This range overlaps passages already on record; nothing was reconstructed'
        );
      }
      const controller = new AbortController();
      current = {
        from,
        to,
        startedAt: iso(clock()),
        now: from,
        phase: 'scanning',
        retry: null,
        controller
      };
      lastError = null;
      perform(from, to, controller.signal);
      return { from, to };
    },

    cancel() {
      if (!current) {
        return false;
      }
      current.controller.abort();
      return true;
    },

    status() {
      return {
        configured:
          settings.retrospectiveHistorySource === 'signalk'
            ? typeof app.getHistoryApi === 'function'
            : Boolean(settings.influxHost && settings.influxDatabase),
        running: current !== null,
        progress: current && {
          from: current.from,
          to: current.to,
          now: current.now,
          phase: current.phase,
          summary: current.summary ?? null,
          retry: current.retry
        },
        lastResult,
        lastError
      };
    }
  };
}

module.exports = { createReplayJob };

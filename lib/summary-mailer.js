const { withTransaction } = require('./database');
const { getEntry } = require('./entries');
const { buildMessage, parseAddress, parseAddressList } = require('./mail');
const { renderPassageMap } = require('./passage-map');
const { MAP_CID, renderPassageSummary } = require('./passage-summary');
const { createSmtpClient, SmtpError } = require('./smtp');
const { allTrackPoints } = require('./track');

// Emails a summary of each passage once it is definitively closed (SPEC
// §4.16): a passage closes the moment the vessel stops, but a departure within
// `stopClosureMinutes` reopens it (SPEC §4.2), so the summary waits out that
// window and goes out only once the arrival is final.
//
// Shaped like the forecasters: a `resolveNext()` run by its own
// `background-schedule` chain, dealing with one passage at a time and saying
// when the next run is due.

const SUMMARY_MAIL_DEFAULTS = {
  summaryMailEnabled: false,
  summaryMailTileUrl: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  smtpPort: 587,
  smtpSecurity: 'starttls'
};

const IDLE_MS = 60 * 1000;
// Offline is the normal state at sea; retry patiently rather than hammering.
const FIRST_RETRY_MS = 5 * 60 * 1000;
const MAX_RETRY_MS = 60 * 60 * 1000;
// Past this, a summary is no longer news and the passage is written off rather
// than retried forever -- the same giving-up as the departure forecasts.
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const iso = (ms) => new Date(ms).toISOString();

// The oldest passage definitively closed and not dealt with, so a backlog
// built up offline goes out in the order it was sailed.
function nextPending(db, { now, closureMs }) {
  return db
    .prepare(
      `SELECT id FROM log_entries
       WHERE state = 'closed' AND end_time IS NOT NULL
         AND end_time <= ? AND end_time >= ?
         AND id NOT IN (SELECT entry_id FROM passage_summary_mails)
       ORDER BY end_time, id LIMIT 1`
    )
    .get(iso(now - closureMs), iso(now - MAX_AGE_MS))?.id;
}

function record(db, entryId, now, { recipients = null, error = null }) {
  withTransaction(db, () => {
    db.prepare(
      `INSERT INTO passage_summary_mails (entry_id, sent_at, recipients, error, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (entry_id) DO UPDATE
         SET sent_at = excluded.sent_at, recipients = excluded.recipients, error = excluded.error`
    ).run(entryId, error ? null : iso(now), recipients?.join(', ') ?? null, error, iso(now));
  });
}

// Writes off every passage already too old to be worth a summary, so a boat
// back from a month offline is not mailed its whole cruise one passage at a
// time -- and so `nextPending` does not keep stepping over them.
function writeOffStale(db, now) {
  const where = `state = 'closed' AND end_time IS NOT NULL AND end_time < ?
       AND id NOT IN (SELECT entry_id FROM passage_summary_mails)`;
  // A read first: this runs every minute, and most minutes has nothing to do.
  const stale = db
    .prepare(`SELECT EXISTS (SELECT 1 FROM log_entries WHERE ${where}) AS any`)
    .get(iso(now - MAX_AGE_MS)).any;
  if (!stale) {
    return;
  }
  withTransaction(db, () => {
    db.prepare(
      `INSERT INTO passage_summary_mails (entry_id, error, created_at)
       SELECT id, 'closed too long ago for a summary to be worth sending', ?
       FROM log_entries WHERE ${where}`
    ).run(iso(now), iso(now - MAX_AGE_MS));
  });
}

function configurationProblem(settings) {
  if (!settings.smtpHost) {
    return 'no SMTP server is configured';
  }
  if (parseAddressList(settings.summaryMailTo).length === 0) {
    return 'no recipient is configured';
  }
  if (!parseAddress(settings.summaryMailFrom ?? '')?.address?.includes('@')) {
    return 'no sender address is configured';
  }
  return null;
}

function createSummaryMailer({
  db,
  settings,
  userAgent = 'signalk-chiplog',
  vesselName = () => null,
  clock = Date.now,
  // Injected whole in tests: neither the tile servers nor an SMTP relay is
  // reachable from them.
  fetchImpl = globalThis.fetch,
  createClient = createSmtpClient,
  log = () => {}
}) {
  let stopped = false;
  let failures = 0;
  let failingEntryId = null;
  let lastSuccess = null;
  let lastError = null;

  async function compose(entryId) {
    const entry = getEntry(db, entryId);
    const trackPoints = allTrackPoints(db, entryId);
    const vessel = vesselName();

    // The map is the point of the mail, but a missing one is no reason to
    // withhold the figures: the summary goes out with the track left out.
    let map = null;
    try {
      map = await renderPassageMap(trackPoints, {
        tileUrlTemplate: settings.summaryMailTileUrl || null,
        fetchImpl,
        userAgent,
        log
      });
    } catch (err) {
      log('error', `Passage ${entryId} map could not be drawn: ${err.message}`);
    }

    const { subject, text, html } = await renderPassageSummary(
      { entry, trackPoints },
      {
        language: settings.logbookLanguage,
        timeZone: settings.logbookTimeZone ?? undefined,
        vesselName: vessel,
        mapAvailable: map !== null
      }
    );

    const to = parseAddressList(settings.summaryMailTo);
    const configured = parseAddress(settings.summaryMailFrom);
    // A sender given as a bare address is shown under the vessel's name, so an
    // inbox full of these says which boat they came from.
    const from = configured.name
      ? configured
      : { name: vessel ?? 'Chiplog', address: configured.address };
    return {
      to,
      from,
      message: buildMessage({
        from,
        to,
        subject,
        text,
        html,
        date: new Date(clock()),
        inlineImages: map
          ? [
              {
                cid: MAP_CID,
                filename: `passage-${entryId}.png`,
                contentType: 'image/png',
                content: map.png
              }
            ]
          : []
      })
    };
  }

  async function sendSummary(entryId) {
    const { from, to, message } = await compose(entryId);
    const client = createClient({
      host: settings.smtpHost,
      port: settings.smtpPort,
      security: settings.smtpSecurity,
      username: settings.smtpUsername || null,
      password: settings.smtpPassword || null
    });
    await client.send({
      from: from.address,
      to: to.map((address) => address.address),
      message
    });
    return to.map((address) => address.address);
  }

  return {
    // Sends the summary of one passage now, whatever its state and whether or
    // not one has already gone out: what the configuration is tested with.
    async send(entryId) {
      const problem = configurationProblem(settings);
      if (problem) {
        throw new SmtpError(`Cannot send the passage summary: ${problem}`, { permanent: true });
      }
      const recipients = await sendSummary(entryId);
      const now = clock();
      record(db, entryId, now, { recipients });
      lastSuccess = { at: iso(now), entryId, recipients };
      lastError = null;
      return { entryId, recipients };
    },

    async resolveNext() {
      if (!settings.summaryMailEnabled) {
        return { outcome: 'disabled', retryInMs: IDLE_MS };
      }
      const problem = configurationProblem(settings);
      if (problem) {
        return { outcome: 'disabled', retryInMs: IDLE_MS };
      }

      const now = clock();
      writeOffStale(db, now);
      const entryId = nextPending(db, {
        now,
        closureMs: settings.stopClosureMinutes * 60 * 1000
      });
      if (entryId === undefined) {
        failures = 0;
        return { outcome: 'idle', retryInMs: IDLE_MS };
      }
      if (entryId !== failingEntryId) {
        failures = 0;
        failingEntryId = entryId;
      }

      let recipients;
      try {
        recipients = await sendSummary(entryId);
      } catch (error) {
        if (stopped) {
          return { outcome: 'stopped' };
        }
        // A refusal the relay will repeat -- an address it will not take, a
        // password it will not accept -- is recorded against the passage and
        // left there; retrying it every few minutes for a week would only
        // annoy the relay, and the reason is in the row and in the log.
        if (error instanceof SmtpError && error.permanent) {
          record(db, entryId, clock(), { error: error.message });
          lastError = { at: iso(clock()), entryId, message: error.message };
          log('error', `Passage ${entryId} summary refused for good: ${error.message}`);
          return { outcome: 'refused', retryInMs: 0 };
        }
        failures += 1;
        lastError = { at: iso(clock()), entryId, message: error.message };
        return {
          outcome: 'failed',
          error,
          retryInMs: Math.min(FIRST_RETRY_MS * 2 ** (failures - 1), MAX_RETRY_MS)
        };
      }
      if (stopped) {
        return { outcome: 'stopped' };
      }

      failures = 0;
      const sentAt = clock();
      record(db, entryId, sentAt, { recipients });
      lastSuccess = { at: iso(sentAt), entryId, recipients };
      lastError = null;
      log('info', `Passage ${entryId} summary sent to ${recipients.join(', ')}`);
      // Straight on to the next: a backlog goes out in one go.
      return { outcome: 'sent', retryInMs: 0 };
    },

    status() {
      return {
        enabled: Boolean(settings.summaryMailEnabled),
        configured: configurationProblem(settings) === null,
        problem: configurationProblem(settings),
        recipients: parseAddressList(settings.summaryMailTo).map((address) => address.address),
        lastSuccess,
        lastError
      };
    },

    stop() {
      stopped = true;
    }
  };
}

module.exports = { createSummaryMailer, SUMMARY_MAIL_DEFAULTS, MAX_AGE_MS };

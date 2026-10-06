const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { listEntryCrew } = require('./crew');
const { toEntry } = require('./entries');
const { allEvents } = require('./events');
const { passageFingerprint } = require('./export');
const { allPlaces } = require('./places');
const { allSegments } = require('./propulsion');
const { getTideForecast } = require('./tide-forecaster');
const { allObservations, allTrackPoints } = require('./track');
const { getWeatherForecast } = require('./weather-forecaster');

const CLOUD_SYNC_DEFAULTS = {
  cloudSyncEnabled: false,
  cloudSyncIntervalMinutes: 15
};

// The exchange format the service is sent, in step with its SUPPORTED_FORMAT_VERSIONS.
const FORMAT_VERSION = 1;
// About 300 kB of JSON before compression: a chunk lost to a dropped link is cheap to resend.
const TRACK_CHUNK_POINTS = 2000;
const REQUEST_TIMEOUT_MS = 2 * 60 * 1000;
const IDLE_MS = 15 * 60 * 1000;
const FIRST_RETRY_MS = 60 * 1000;
const MAX_RETRY_MS = 60 * 60 * 1000;

class CloudSyncError extends Error {
  constructor(message, { status = null, code = null } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// SHA-256 of the value's JSON: the service computes the same over what it receives.
const jsonHash = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

function getLogbookId(db) {
  return db.prepare('SELECT id FROM logbook_identity').get().id;
}

// Everything the service keeps of a passage but its track, which goes in chunks.
function passageContent(db, row) {
  return {
    entry: toEntry(row),
    events: allEvents(db, row.id),
    observations: allObservations(db, row.id),
    propulsion: allSegments(db, row.id),
    crew: listEntryCrew(db, row.id),
    tide: getTideForecast(db, row.id),
    weather: getWeatherForecast(db, row.id)
  };
}

function trackChunks(points) {
  const chunks = [];
  for (let start = 0; start < points.length; start += TRACK_CHUNK_POINTS) {
    chunks.push(points.slice(start, start + TRACK_CHUNK_POINTS));
  }
  return chunks;
}

function configurationProblem(settings) {
  if (!settings.cloudSyncUrl) {
    return 'no service address';
  }
  if (!settings.cloudSyncToken) {
    return 'no device token';
  }
  return null;
}

// Pushes the logbook to the online service (SPEC §4.17): the passages new or changed since
// the service last heard of them, newest first, and the deletion of those gone from board.
// The service's sync state is the record of what it holds, so nothing is stored here: a
// restart only costs working the hashes out again. Shaped like the forecasters: a
// `resolveNext()` run by its own background schedule.
function createCloudSync({
  db,
  settings,
  userAgent,
  log,
  fetch = globalThis.fetch,
  clock = Date.now
}) {
  // Per passage, what its hashes were last worked out from, so an unchanged passage is not
  // read again in full every run.
  const cache = new Map();
  let failures = 0;
  let stopped = false;
  let lastSuccess = null;
  let lastError = null;
  let progress = null;

  const iso = (ms) => new Date(ms).toISOString();
  const base = () => `${settings.cloudSyncUrl.replace(/\/+$/, '')}/v1/logbooks/${getLogbookId(db)}`;

  async function call(method, path, body) {
    const headers = {
      authorization: `Bearer ${settings.cloudSyncToken}`,
      'user-agent': userAgent,
      'x-chiplog-version': userAgent.split('/')[1] ?? ''
    };
    let payload;
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      headers['content-encoding'] = 'gzip';
      payload = zlib.gzipSync(JSON.stringify(body));
    }
    const response = await fetch(`${base()}${path}`, {
      method,
      headers,
      body: payload,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    if (!response.ok) {
      let detail = {};
      try {
        detail = await response.json();
      } catch {
        // Not every failure comes from the service itself: a proxy, a captive portal.
      }
      throw new CloudSyncError(
        `${method} ${path} answered ${response.status}${detail.message ? `: ${detail.message}` : ''}`,
        { status: response.status, code: detail.error ?? null }
      );
    }
    return response.status === 204 ? null : response.json();
  }

  function localPassage(row) {
    const fingerprint = passageFingerprint(db, row, {});
    const cached = cache.get(row.id);
    if (cached?.fingerprint === fingerprint) {
      return cached;
    }
    const content = passageContent(db, row);
    const chunks = trackChunks(allTrackPoints(db, row.id));
    const chunkHashes = chunks.map(jsonHash);
    const local = {
      fingerprint,
      contentHash: jsonHash(content),
      trackHash: jsonHash(chunkHashes),
      chunkHashes,
      pointCount: chunks.reduce((sum, chunk) => sum + chunk.length, 0)
    };
    cache.set(row.id, local);
    return local;
  }

  async function upload(row, local) {
    // Read again rather than kept: a long track is only held in memory while it is sent.
    const content = passageContent(db, row);
    const chunks = trackChunks(allTrackPoints(db, row.id));
    const { missingChunks } = await call('PUT', `/passages/${row.id}`, {
      formatVersion: FORMAT_VERSION,
      contentHash: jsonHash(content),
      passage: content,
      track: { pointCount: local.pointCount, chunkHashes: chunks.map(jsonHash) }
    });
    for (const index of missingChunks) {
      if (stopped) {
        return;
      }
      const points = chunks[index];
      await call('PUT', `/passages/${row.id}/track/${index}`, { hash: jsonHash(points), points });
    }
  }

  async function synchronise() {
    const state = await call('GET', '/sync-state');
    const remote = state.passages;
    const held = new Map(remote.map((item) => [item.originId, item]));
    const rows = db.prepare('SELECT * FROM log_entries ORDER BY start_time DESC, id DESC').all();
    const onBoard = new Set(rows.map((row) => row.id));
    for (const id of cache.keys()) {
      if (!onBoard.has(id)) {
        cache.delete(id);
      }
    }

    const due = [];
    for (const row of rows) {
      const local = localPassage(row);
      const remoteItem = held.get(row.id);
      const current =
        remoteItem &&
        remoteItem.complete &&
        remoteItem.contentHash === local.contentHash &&
        remoteItem.trackHash === local.trackHash;
      if (!current) {
        due.push([row, local]);
      }
    }
    const gone = remote.filter((item) => !onBoard.has(item.originId));

    progress = { total: due.length + gone.length, done: 0 };
    let sent = 0;
    let deleted = 0;
    for (const [row, local] of due) {
      if (stopped) {
        return null;
      }
      await upload(row, local);
      sent += 1;
      progress.done += 1;
    }
    for (const item of gone) {
      if (stopped) {
        return null;
      }
      await call('DELETE', `/passages/${item.originId}`);
      deleted += 1;
      progress.done += 1;
    }

    // The places -- names, positions and countries -- go whole, when the list differs from
    // the one the service holds: there are few of them, and a place renamed, deleted or given
    // its country then needs no message of its own. An older service says nothing of places
    // and is sent none; an empty list is not worth sending to a service that has none either.
    let places = false;
    if ('placesHash' in state) {
      const list = allPlaces(db);
      const hash = jsonHash(list);
      if (hash !== state.placesHash && (list.length > 0 || state.placesHash !== null)) {
        if (stopped) {
          return null;
        }
        await call('PUT', '/places', { hash, places: list });
        places = true;
      }
    }
    return { sent, deleted, held: rows.length, places };
  }

  return {
    async resolveNext() {
      if (!settings.cloudSyncEnabled || configurationProblem(settings)) {
        return { outcome: 'disabled', retryInMs: IDLE_MS };
      }
      const intervalMs = settings.cloudSyncIntervalMinutes * 60 * 1000;
      let result;
      try {
        result = await synchronise();
      } catch (error) {
        progress = null;
        if (stopped) {
          return { outcome: 'stopped' };
        }
        failures += 1;
        lastError = { at: iso(clock()), message: error.message, code: error.code ?? null };
        // A token the service will keep refusing is worth a line in the log, not a retry a
        // minute: it only changes when someone pastes a new one.
        if (error.status === 401 || error.status === 403) {
          log('error', `Online backup refused: ${error.message}`);
          return { outcome: 'refused', retryInMs: MAX_RETRY_MS };
        }
        return {
          outcome: 'failed',
          error,
          retryInMs: Math.min(FIRST_RETRY_MS * 2 ** (failures - 1), MAX_RETRY_MS)
        };
      }
      progress = null;
      if (stopped || result === null) {
        return { outcome: 'stopped' };
      }
      failures = 0;
      lastSuccess = { at: iso(clock()), ...result };
      lastError = null;
      const changed = result.sent > 0 || result.deleted > 0 || result.places;
      if (changed) {
        log(
          'info',
          `Online backup: ${result.sent} passage(s) sent, ${result.deleted} deleted${result.places ? ', places sent' : ''}`
        );
      }
      return {
        outcome: changed ? 'sent' : 'idle',
        retryInMs: intervalMs
      };
    },

    status() {
      const problem = configurationProblem(settings);
      return {
        enabled: Boolean(settings.cloudSyncEnabled),
        configured: problem === null,
        problem,
        url: settings.cloudSyncUrl || null,
        logbookId: getLogbookId(db),
        inProgress: progress,
        lastSuccess,
        lastError
      };
    },

    stop() {
      stopped = true;
    }
  };
}

module.exports = {
  createCloudSync,
  CLOUD_SYNC_DEFAULTS,
  FORMAT_VERSION,
  TRACK_CHUNK_POINTS,
  getLogbookId,
  jsonHash
};

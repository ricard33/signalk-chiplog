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
  cloudSyncIntervalMinutes: 15,
  cloudSyncCostlyLink: false
};

// The exchange format the service is sent, in step with its SUPPORTED_FORMAT_VERSIONS.
const FORMAT_VERSION = 1;
// About 300 kB of JSON before compression: a chunk lost to a dropped link is cheap to resend.
const TRACK_CHUNK_POINTS = 2000;
// On a costly link (SPEC §4.17), a passage goes as a light copy: one track point per ten
// minutes, in small chunks so that a passage under way only sends its last few points again.
const LIGHT_POINT_EVERY_MS = 10 * 60 * 1000;
const LIGHT_CHUNK_POINTS = 100;
// Each run costs a connection and the service's list of what it holds: on a costly link the
// backup runs at departures and arrivals, and otherwise only this often.
const COSTLY_INTERVAL_MS = 6 * 60 * 60 * 1000;
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

// Objects with their keys in order, at every depth.
function sorted(value) {
  if (Array.isArray(value)) {
    return value.map(sorted);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sorted(value[key])])
    );
  }
  return value;
}

// SHA-256 of the value's JSON with every object's keys sorted: the service computes the same
// over what it receives. Sorted, so that a passage hashes the same once it has been through
// the service and back -- its database keeps no key order -- and a logbook restored from it
// (lib/cloud-restore.js) is not sent again whole.
const jsonHash = (value) =>
  crypto
    .createHash('sha256')
    .update(JSON.stringify(sorted(value)))
    .digest('hex');

function getLogbookId(db) {
  return db.prepare('SELECT id FROM logbook_identity').get().id;
}

// Whether an earlier logbook is still being read back from the service (lib/cloud-restore.js).
function isRestoring(db) {
  return db.prepare('SELECT restoring FROM logbook_identity').get().restoring === 1;
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

function trackChunks(points, size = TRACK_CHUNK_POINTS) {
  const chunks = [];
  for (let start = 0; start < points.length; start += size) {
    chunks.push(points.slice(start, start + size));
  }
  return chunks;
}

// The passage in a few kilobytes: what happened and who was aboard, without the instrument
// snapshots, the forecasts and the strokes of handwritten notes, which wait for a cheap link.
function lightContent(db, row) {
  return {
    entry: toEntry(row),
    events: allEvents(db, row.id).map((event) =>
      event.type === 'handwritten_annotation' ? { ...event, payload: null } : event
    ),
    observations: [],
    propulsion: allSegments(db, row.id),
    crew: listEntryCrew(db, row.id),
    tide: null,
    weather: null
  };
}

// The track thinned out: the first point of every ten minutes of the clock, and the last one,
// with position and speed only. Cut on the clock rather than evenly so that a track that grew
// keeps the points it already had -- only its last chunk changes.
function lightTrack(points) {
  const kept = [];
  let slot = null;
  points.forEach((point, index) => {
    const current = Math.floor(Date.parse(point.time) / LIGHT_POINT_EVERY_MS);
    if (current !== slot || index === points.length - 1) {
      slot = current;
      kept.push({ time: point.time, lat: point.lat, lon: point.lon, sog: point.sog });
    }
  });
  return kept;
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
  // Set by a backup asked for by hand: the next run sends everything in full, costly link or not.
  let fullRequested = false;

  const iso = (ms) => new Date(ms).toISOString();
  const base = () => `${settings.cloudSyncUrl.replace(/\/+$/, '')}/v1/logbooks/${getLogbookId(db)}`;

  async function call(method, path, body, extraHeaders = {}) {
    const headers = {
      authorization: `Bearer ${settings.cloudSyncToken}`,
      'user-agent': userAgent,
      'x-chiplog-version': userAgent.split('/')[1] ?? '',
      ...extraHeaders
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

  // The hashes of the passage's light copy, worked out when first needed and kept with the
  // others for as long as the passage does not change.
  function lightOf(row, local) {
    if (!local.light) {
      const chunkHashes = trackChunks(
        lightTrack(allTrackPoints(db, row.id)),
        LIGHT_CHUNK_POINTS
      ).map(jsonHash);
      local.light = {
        contentHash: jsonHash(lightContent(db, row)),
        trackHash: jsonHash(chunkHashes)
      };
    }
    return local.light;
  }

  async function upload(row, light) {
    // Read again rather than kept: a long track is only held in memory while it is sent.
    const content = light ? lightContent(db, row) : passageContent(db, row);
    const points = allTrackPoints(db, row.id);
    const chunks = light
      ? trackChunks(lightTrack(points), LIGHT_CHUNK_POINTS)
      : trackChunks(points);
    const { missingChunks } = await call('PUT', `/passages/${row.id}`, {
      formatVersion: FORMAT_VERSION,
      contentHash: jsonHash(content),
      passage: content,
      track: {
        pointCount: chunks.reduce((sum, chunk) => sum + chunk.length, 0),
        chunkHashes: chunks.map(jsonHash)
      },
      ...(light ? { light: true } : {})
    });
    for (const index of missingChunks) {
      if (stopped) {
        return;
      }
      const points = chunks[index];
      await call('PUT', `/passages/${row.id}/track/${index}`, { hash: jsonHash(points), points });
    }
  }

  async function synchronise(costly) {
    const rows = db.prepare('SELECT * FROM log_entries ORDER BY start_time DESC, id DESC').all();
    // How many passages are on board: the service tells its owner how far the backup is.
    const state = await call('GET', '/sync-state', undefined, {
      'x-chiplog-passages': String(rows.length)
    });
    const remote = state.passages;
    const held = new Map(remote.map((item) => [item.originId, item]));
    const onBoard = new Set(rows.map((row) => row.id));
    for (const id of cache.keys()) {
      if (!onBoard.has(id)) {
        cache.delete(id);
      }
    }

    // What to send, and how: in full, or as a light copy on a costly link. `waiting` counts the
    // passages the service does not hold in full yet, for the page to say so.
    const due = [];
    let waiting = 0;
    for (const row of rows) {
      const local = localPassage(row);
      const remoteItem = held.get(row.id);
      const current =
        remoteItem &&
        remoteItem.complete &&
        remoteItem.contentHash === local.contentHash &&
        remoteItem.trackHash === local.trackHash;
      if (current) {
        continue;
      }
      if (!costly) {
        due.push([row, false]);
        continue;
      }
      waiting += 1;
      // A full copy the service already holds, though out of date, is worth more than a light
      // one up to date: it stays until the full passage can replace it.
      if (remoteItem && !remoteItem.light) {
        continue;
      }
      const light = lightOf(row, local);
      const lightCurrent =
        remoteItem &&
        remoteItem.complete &&
        remoteItem.contentHash === light.contentHash &&
        remoteItem.trackHash === light.trackHash;
      if (!lightCurrent) {
        due.push([row, true]);
      }
    }
    const gone = remote.filter((item) => !onBoard.has(item.originId));

    progress = { total: due.length + gone.length, done: 0 };
    let sent = 0;
    let deleted = 0;
    let sentLight = 0;
    for (const [row, light] of due) {
      if (stopped) {
        return null;
      }
      await upload(row, light);
      sent += 1;
      sentLight += light ? 1 : 0;
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
    // Not on a costly link: the list goes whole each time it changes, and can wait.
    if ('placesHash' in state && !costly) {
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
    return { sent, light: sentLight, waiting, deleted, held: rows.length, places };
  }

  return {
    async resolveNext() {
      if (!settings.cloudSyncEnabled || configurationProblem(settings)) {
        return { outcome: 'disabled', retryInMs: IDLE_MS };
      }
      // A logbook half restored lacks passages the service holds: sending now would report
      // them deleted on board.
      if (isRestoring(db)) {
        return { outcome: 'restoring', retryInMs: FIRST_RETRY_MS };
      }
      // A run asked for by hand is a full one, whatever the link: asking is saying it is worth it.
      const costly = Boolean(settings.cloudSyncCostlyLink) && !fullRequested;
      const intervalMs = Math.max(
        settings.cloudSyncIntervalMinutes * 60 * 1000,
        settings.cloudSyncCostlyLink ? COSTLY_INTERVAL_MS : 0
      );
      let result;
      try {
        result = await synchronise(costly);
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
      fullRequested = false;
      lastSuccess = { at: iso(clock()), ...result };
      lastError = null;
      const changed = result.sent > 0 || result.deleted > 0 || result.places;
      if (changed) {
        log(
          'info',
          `Online backup: ${result.sent} passage(s) sent${result.light ? ` (${result.light} as light copies)` : ''}, ${result.deleted} deleted${result.places ? ', places sent' : ''}`
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
        costlyLink: Boolean(settings.cloudSyncCostlyLink),
        logbookId: getLogbookId(db),
        inProgress: progress,
        lastSuccess,
        lastError
      };
    },

    // The next run sends every passage in full, even on a costly link.
    requestFull() {
      fullRequested = true;
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
  LIGHT_CHUNK_POINTS,
  COSTLY_INTERVAL_MS,
  lightContent,
  lightTrack,
  getLogbookId,
  isRestoring,
  jsonHash,
  passageContent
};

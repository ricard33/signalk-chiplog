const { Temporal } = require('@js-temporal/polyfill');
const { MAX_AGE_MS } = require('./detection');
const { createSeriesStore, underwayIntervals } = require('./history-series');

// Reads historical Signal K data back through the server's own History API
// (`app.getHistoryApi()`), whichever provider is registered for it --
// signalk-to-influxdb2, QuestDB, TimescaleDB. Unlike lib/influx-history.js
// this knows no storage schema at all: it asks for Signal K paths and gets
// Signal K values back, so it needs no database credentials of its own.
//
// It answers the same `{ preload, clear, scanMotion, readSelfPath }` contract
// and applies the same bounds as the InfluxDB reader -- chunked requests, a
// pause between them, a timeout with retries -- because the provider usually
// sits on the very same Raspberry Pi as Signal K itself.

// Paths Chiplog reads while replaying a passage. The History API returns
// Signal K values, so this list deliberately holds paths rather than storage
// fields.
const STATIC_PATHS = [
  'navigation.position',
  'navigation.speedOverGround',
  'navigation.courseOverGroundTrue',
  'navigation.headingTrue',
  'navigation.headingMagnetic',
  'navigation.magneticVariation',
  'navigation.speedThroughWater',
  'navigation.log',
  'navigation.state',
  'environment.wind.speedTrue',
  'environment.wind.directionTrue',
  'environment.wind.speedApparent',
  'environment.wind.angleApparent',
  'environment.depth.belowSurface',
  'environment.depth.belowTransducer',
  'environment.outside.pressure',
  'environment.outside.temperature',
  'environment.water.temperature',
  'steering.autopilot.target',
  'steering.autopilot.target.headingTrue',
  'steering.autopilot.target.headingMagnetic',
  'steering.autopilot.target.windAngleApparent',
  'steering.autopilot.target.windAngleTrue',
  'steering.autopilot.state',
  'steering.autopilot.mode',
  'steering.autopilot.engaged'
];

// Same bounds as the InfluxDB reader, for the same reason: a fixed-size
// request keeps each answer small however long the replayed range is, and the
// pause gives a provider sharing the boat's Pi room to recover between them.
const CHUNK_MS = 2 * 60 * 60 * 1000;
const CHUNK_PAUSE_MS = 200;
const SCAN_CHUNK_MS = 7 * 24 * 60 * 60 * 1000;
const SCAN_BUCKET_MS = 60 * 1000;

const DEFAULT_QUERY_TIMEOUT_SECONDS = 30;
const QUERY_MAX_RETRIES = 3;
const QUERY_RETRY_DELAY_MS = 5 * 1000;

const STATE_PATH = 'navigation.state';
const POSITION_PATH = 'navigation.position';

const iso = (ms) => new Date(ms).toISOString();
const instant = (ms) => Temporal.Instant.from(iso(ms));

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// `navigation.position` comes back as a GeoJSON `[longitude, latitude]` pair;
// accept the object forms a provider might answer with as well.
function position(value) {
  if (Array.isArray(value) && typeof value[0] === 'number' && typeof value[1] === 'number') {
    return { longitude: value[0], latitude: value[1] };
  }
  if (value && typeof value.latitude === 'number' && typeof value.longitude === 'number') {
    return { longitude: value.longitude, latitude: value.latitude };
  }
  if (value && typeof value.lon === 'number' && typeof value.lat === 'number') {
    return { longitude: value.lon, latitude: value.lat };
  }
  return null;
}

function createHistoryApiHistory({
  getHistoryApi,
  selfContext,
  signal,
  queryTimeoutSeconds = DEFAULT_QUERY_TIMEOUT_SECONDS,
  retryDelayMs = QUERY_RETRY_DELAY_MS,
  onRetry = () => {}
}) {
  if (typeof getHistoryApi !== 'function') {
    throw new Error('This Signal K server does not expose the History API to plugins');
  }

  const queryTimeoutMs = queryTimeoutSeconds * 1000;
  const store = createSeriesStore();
  // The engines the history holds, for the `propulsion` branch node the
  // propulsion detector and the observation recorder enumerate.
  const engineIds = new Set();
  // Ranges already asked for paths, so a window and each of its extensions
  // cost one discovery request each rather than one per loaded chunk.
  const discoveredRanges = new Set();
  let apiPromise;
  let verified = null;

  function checkAborted() {
    if (signal?.aborted) {
      throw new DOMException('Replay cancelled', 'AbortError');
    }
  }

  async function api() {
    apiPromise ??= getHistoryApi();
    try {
      return await apiPromise;
    } catch (err) {
      throw new Error(`Signal K History API provider is unavailable: ${err.message}`, {
        cause: err
      });
    }
  }

  // The History API takes no abort signal and promises no timeout of its own,
  // so a provider that never answers would otherwise hang the whole replay
  // with nothing to show for it, and cancelling would only take effect at the
  // end of the chunk in flight. Racing the call bounds both.
  function bounded(work) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn) => (value) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        fn(value);
      };
      const done = finish(resolve);
      const fail = finish(reject);
      const timer = setTimeout(() => {
        const err = new Error(
          `The Signal K history provider did not answer within ${queryTimeoutSeconds}s`
        );
        err.name = 'TimeoutError';
        fail(err);
      }, queryTimeoutMs);
      const onAbort = () => fail(new DOMException('Replay cancelled', 'AbortError'));
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      work().then(done, fail);
    });
  }

  // A provider momentarily busy -- sharing its host with Signal K itself -- is
  // retried rather than failing the whole run, exactly as an InfluxDB query
  // timing out is. Only a timeout is retried: anything else would answer the
  // same way again.
  async function attempt(work) {
    for (let retries = 0; ; retries += 1) {
      try {
        const answer = await bounded(work);
        onRetry(null);
        return answer;
      } catch (err) {
        if (signal?.aborted || err.name !== 'TimeoutError') {
          throw err;
        }
        if (retries >= QUERY_MAX_RETRIES) {
          throw err;
        }
        onRetry(retries + 1, QUERY_MAX_RETRIES, err.message);
        await sleep(retryDelayMs);
      }
    }
  }

  // The contexts the history actually holds, so a context matching none of
  // them -- this server pointed at another boat's history -- is a clear error
  // rather than a replay that runs to completion and reconstructs nothing.
  async function verifyContext(fromMs, toMs) {
    if (!selfContext) {
      return;
    }
    verified ??= (async () => {
      const found = await attempt(() =>
        api().then((history) => history.getContexts({ from: instant(fromMs), to: instant(toMs) }))
      );
      const contexts = new Set(found ?? []);
      if (contexts.size > 0 && !contexts.has(selfContext)) {
        throw new Error(
          `No data for context "${selfContext}" in this history. ` +
            `Found: ${[...contexts].join(', ')}. ` +
            'Set "Vessel context (retrospective analysis)" in the plugin configuration to one of these.'
        );
      }
    })();
    return verified;
  }

  async function discover(fromMs, toMs) {
    const key = `${fromMs}-${toMs}`;
    if (discoveredRanges.has(key)) {
      return;
    }
    const paths = await attempt(() =>
      api().then((history) => history.getPaths({ from: instant(fromMs), to: instant(toMs) }))
    );
    for (const path of paths ?? []) {
      const match = /^propulsion\.([^.]+)\.(revolutions|state|runTime)$/.exec(path);
      if (match) {
        engineIds.add(match[1]);
      }
    }
    discoveredRanges.add(key);
  }

  // `last` unless the caller asks otherwise, like the InfluxDB reader: the
  // value in force at the end of a bucket is the one a replay stepping at that
  // interval could have seen.
  function pathSpecs(paths, aggregates) {
    return paths.map((path) => ({
      path,
      aggregate: aggregates[path] ?? 'last',
      parameter: []
    }));
  }

  // `resolution` is a number of seconds, so a bucket finer than a second
  // cannot be asked for -- the replay never uses one (SAMPLE_INTERVAL_MS).
  async function values(paths, fromMs, toMs, resolutionMs, aggregates = {}) {
    checkAborted();
    // The InfluxDB 2 provider needs the position in its own request. It also
    // applies every aggregate in a request to every measurement, so mixing a
    // numeric `max` with a string `last` makes it try MAX() on the string.
    // Keep measurements with different aggregates in separate requests.
    const groups = new Map();
    for (const path of paths) {
      const key = path === POSITION_PATH ? POSITION_PATH : (aggregates[path] ?? 'last');
      const group = groups.get(key) ?? [];
      group.push(path);
      groups.set(key, group);
    }
    const results = [];
    for (const group of groups.values()) {
      results.push(
        await attempt(() =>
          api().then((history) =>
            history.getValues({
              context: selfContext,
              from: instant(fromMs),
              to: instant(toMs),
              resolution: Math.max(1, Math.round(resolutionMs / 1000)),
              pathSpecs: pathSpecs(group, aggregates)
            })
          )
        )
      );
    }
    checkAborted();
    return results;
  }

  // A bucketed row is dated at the start of its bucket; shifting it to the end
  // is what stops the replay seeing a reading before it was published, exactly
  // as the InfluxDB reader does.
  function load(result, shift) {
    const descriptors = result?.values ?? [];
    for (const row of result?.data ?? []) {
      const time = Date.parse(row[0]) + shift;
      descriptors.forEach((descriptor, index) => {
        const value = row[index + 1];
        store.add(
          descriptor.path,
          time,
          descriptor.path === POSITION_PATH ? position(value) : value
        );
      });
    }
  }

  async function preload(fromMs, toMs, onChunk, { bucketMs } = {}) {
    await verifyContext(fromMs, toMs);
    await discover(fromMs, toMs);
    const paths = [
      ...STATIC_PATHS,
      ...[...engineIds].flatMap((id) => [
        `propulsion.${id}.revolutions`,
        `propulsion.${id}.state`,
        `propulsion.${id}.runTime`
      ])
    ];
    const resolutionMs = bucketMs ?? 1000;
    for (let start = fromMs; start < toMs; start += CHUNK_MS) {
      const end = Math.min(start + CHUNK_MS, toMs);
      for (const result of await values(paths, start, end, resolutionMs)) {
        load(result, resolutionMs);
      }
      onChunk?.(end, toMs);
      if (end < toMs) {
        await sleep(CHUNK_PAUSE_MS);
      }
    }
    store.sort();
  }

  // The rows of one scan request, as `{ path, time, value }`, dated at the
  // start of their bucket -- `underwayIntervals` allows for the bucket itself.
  function scanRows(result) {
    const descriptors = result?.values ?? [];
    const rows = [];
    for (const row of result?.data ?? []) {
      const time = Date.parse(row[0]);
      descriptors.forEach((descriptor, index) => {
        rows.push({ path: descriptor.path, time, value: row[index + 1] });
      });
    }
    return rows;
  }

  // When the vessel may have been moving within [fromMs, toMs]: the highest
  // speed of each minute -- `max`, not a mean, so a minute of motion is never
  // averaged away and a departure lost with it -- and navigation.state,
  // whatever source published it.
  async function scanMotion(fromMs, toMs, { stoppedSpeed }, onChunk) {
    await verifyContext(fromMs, toMs);
    const intervals = [];
    const states = [];

    // The state already in force when the range opens: without it, a passage
    // begun before `from` is missed entirely.
    const [seed] = await values(
      [STATE_PATH],
      fromMs - MAX_AGE_MS[STATE_PATH],
      fromMs,
      SCAN_BUCKET_MS
    );
    const seeded = scanRows(seed).filter((row) => typeof row.value === 'string');
    if (seeded.length > 0) {
      states.push(seeded[seeded.length - 1]);
    }

    for (let start = fromMs; start < toMs; start += SCAN_CHUNK_MS) {
      const end = Math.min(start + SCAN_CHUNK_MS, toMs);
      const results = await values(
        ['navigation.speedOverGround', STATE_PATH],
        start,
        end,
        SCAN_BUCKET_MS,
        { 'navigation.speedOverGround': 'max' }
      );
      for (const result of results) {
        for (const row of scanRows(result)) {
          if (
            row.path === 'navigation.speedOverGround' &&
            typeof row.value === 'number' &&
            row.value >= stoppedSpeed
          ) {
            intervals.push({ from: row.time, to: row.time + SCAN_BUCKET_MS });
          }
          if (row.path === STATE_PATH && typeof row.value === 'string') {
            states.push(row);
          }
        }
      }
      onChunk?.(end, toMs);
      if (end < toMs) {
        await sleep(CHUNK_PAUSE_MS);
      }
    }

    intervals.push(...underwayIntervals(states, { fromMs, bucketMs: SCAN_BUCKET_MS }));

    return intervals.sort((a, b) => a.from - b.from);
  }

  // Matches `app.getSelfPath(path)` at that historical instant. `propulsion`
  // is the one branch node asked for: the propulsion detector and the
  // observation recorder enumerate the boat's engines through it.
  function readSelfPath(path, atMs) {
    if (path === 'propulsion') {
      return engineIds.size > 0
        ? Object.fromEntries([...engineIds].map((id) => [id, {}]))
        : undefined;
    }
    return store.readSelfPath(path, atMs);
  }

  function clear() {
    store.clear();
  }

  return { preload, clear, scanMotion, readSelfPath };
}

module.exports = { createHistoryApiHistory, CHUNK_MS, QUERY_MAX_RETRIES };

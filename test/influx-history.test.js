const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { createInfluxHistory, CHUNK_MS, QUERY_MAX_RETRIES } = require('../lib/influx-history');

const T0 = Date.parse('2026-09-13T08:00:00.000Z');
const MINUTE = 60 * 1000;

// A minimal InfluxDB v1 stand-in: answers each statement in the batch from
// `rowsByMeasurement`, keyed by measurement name, regardless of position --
// decoupled from exactly which paths the module queries and in what order.
function fakeInflux(rowsByMeasurement, { onRequest, contexts } = {}) {
  const requests = [];
  const fetch = async (url, options) => {
    const q = options.body.get('q');
    requests.push({ url, options, q });
    onRequest?.(url, options);
    const statements = q.split(';');
    const results = statements.map((statement) => {
      if (/SHOW TAG VALUES/.test(statement)) {
        return !contexts || contexts.length === 0
          ? {}
          : {
              series: [
                {
                  name: 'navigation.speedOverGround',
                  columns: ['key', 'value'],
                  values: contexts.map((c) => ['context', c])
                }
              ]
            };
      }
      if (/SHOW MEASUREMENTS/.test(statement)) {
        const names = Object.keys(rowsByMeasurement).filter((name) =>
          name.startsWith('propulsion.')
        );
        return names.length === 0
          ? {}
          : {
              series: [{ name: 'measurements', columns: ['name'], values: names.map((n) => [n]) }]
            };
      }
      const match = /FROM "([^"]+)"/.exec(statement);
      const allRows = (match && rowsByMeasurement[match[1]]) ?? [];
      const range = /time >= '([^']+)' AND time <= '([^']+)'/.exec(statement);
      const before = /time < '([^']+)'/.exec(statement);
      const [fromMs, toMs] = range
        ? [Date.parse(range[1]), Date.parse(range[2])]
        : before
          ? [-Infinity, Date.parse(before[1]) - 1]
          : [-Infinity, Infinity];
      const rows = allRows.filter((row) => row.time >= fromMs && row.time <= toMs);
      if (rows.length === 0) {
        return {};
      }
      // Rows are answered as they are, not aggregated; a GROUP BY on source
      // splits them into one tagged series per source, like InfluxDB does.
      if (/GROUP BY .*"source"/.test(statement)) {
        const sources = [...new Set(rows.map((row) => row.source))];
        return {
          series: sources.map((source) => {
            const own = rows.filter((row) => row.source === source);
            const columns = Object.keys(own[0]).filter((c) => c !== 'source');
            return {
              name: match[1],
              tags: { source },
              columns,
              values: own.map((row) => columns.map((c) => row[c]))
            };
          })
        };
      }
      const columns = Object.keys(rows[0]);
      return {
        series: [{ name: match[1], columns, values: rows.map((row) => columns.map((c) => row[c])) }]
      };
    });
    return { ok: true, status: 200, json: async () => ({ results }) };
  };
  return { fetch, requests };
}

function history(rowsByMeasurement, options = {}) {
  const { fetch, requests } = fakeInflux(rowsByMeasurement, options);
  const influx = createInfluxHistory({
    host: 'influx.example.com',
    port: 8086,
    database: 'signalk',
    selfContext: options.selfContext ?? 'vessels.self',
    fetch
  });
  return { influx, requests };
}

describe('InfluxDB history', () => {
  it('answers a numeric path as the last value at or before the instant asked', async () => {
    const { influx } = history({
      'navigation.speedOverGround': [
        { time: T0, value: 1 },
        { time: T0 + 10 * MINUTE, value: 2 },
        { time: T0 + 20 * MINUTE, value: 3 }
      ]
    });
    await influx.preload(T0, T0 + 30 * MINUTE);

    assert.equal(influx.readSelfPath('navigation.speedOverGround', T0 - 1), undefined);
    assert.deepEqual(influx.readSelfPath('navigation.speedOverGround', T0), {
      value: 1,
      timestamp: new Date(T0).toISOString()
    });
    assert.deepEqual(influx.readSelfPath('navigation.speedOverGround', T0 + 15 * MINUTE), {
      value: 2,
      timestamp: new Date(T0 + 10 * MINUTE).toISOString()
    });
    assert.deepEqual(influx.readSelfPath('navigation.speedOverGround', T0 + 1000 * MINUTE), {
      value: 3,
      timestamp: new Date(T0 + 20 * MINUTE).toISOString()
    });
  });

  it('reads position from separate lon/lat fields when present', async () => {
    const { influx } = history({
      'navigation.position': [{ time: T0, lon: -1.1522, lat: 46.1591, jsonValue: null }]
    });
    await influx.preload(T0, T0 + MINUTE);

    assert.deepEqual(influx.readSelfPath('navigation.position', T0), {
      value: { longitude: -1.1522, latitude: 46.1591 },
      timestamp: new Date(T0).toISOString()
    });
  });

  it('falls back to parsing jsonValue when lon/lat were not stored', async () => {
    const { influx } = history({
      'navigation.position': [
        { time: T0, jsonValue: JSON.stringify({ longitude: -1.1522, latitude: 46.1591 }) }
      ]
    });
    await influx.preload(T0, T0 + MINUTE);

    assert.deepEqual(influx.readSelfPath('navigation.position', T0), {
      value: { longitude: -1.1522, latitude: 46.1591 },
      timestamp: new Date(T0).toISOString()
    });
  });

  it('resolves navigation.state to whichever source last changed, keeping every source', async () => {
    const { influx } = history({
      'navigation.state': [
        { time: T0, stringValue: 'motoring', source: 'ais.1' },
        { time: T0 + 5 * MINUTE, stringValue: 'sailing', source: 'signalk-autostate.1' }
      ]
    });
    await influx.preload(T0, T0 + 10 * MINUTE);

    const early = influx.readSelfPath('navigation.state', T0 + MINUTE);
    assert.equal(early.value, 'motoring');
    assert.equal(early.$source, 'ais.1');
    assert.deepEqual(Object.keys(early.values).sort(), ['ais.1']);

    const later = influx.readSelfPath('navigation.state', T0 + 6 * MINUTE);
    assert.equal(later.value, 'sailing');
    assert.equal(later.$source, 'signalk-autostate.1');
    assert.deepEqual(Object.keys(later.values).sort(), ['ais.1', 'signalk-autostate.1']);
  });

  it('discovers engine ids from measurement names and queries their paths', async () => {
    const { influx, requests } = history({
      'propulsion.port.revolutions': [{ time: T0, value: 30 }],
      'propulsion.port.state': [{ time: T0, stringValue: 'started' }]
    });
    await influx.preload(T0, T0 + MINUTE);

    assert.deepEqual(influx.readSelfPath('propulsion.port.revolutions', T0), {
      value: 30,
      timestamp: new Date(T0).toISOString()
    });
    assert.deepEqual(influx.readSelfPath('propulsion.port.state', T0), {
      value: 'started',
      timestamp: new Date(T0).toISOString()
    });
    assert.ok(requests.some((r) => r.q.includes('propulsion.port.revolutions')));
  });

  it('answers the propulsion branch node the engines it found', async () => {
    // The propulsion detector and the observation recorder enumerate the
    // boat's engines through it: without the branch node, a replay
    // reconstructs no engine segment however many RPMs the history holds.
    const { influx } = history({
      'propulsion.port.revolutions': [{ time: T0, value: 30 }],
      'propulsion.starboard.revolutions': [{ time: T0, value: 28 }]
    });
    await influx.preload(T0, T0 + MINUTE);

    assert.deepEqual(influx.readSelfPath('propulsion', T0), { port: {}, starboard: {} });
  });

  it('filters by the self context and sends basic auth when a username is given', async () => {
    const { fetch, requests } = fakeInflux({});
    const influx = createInfluxHistory({
      host: 'h',
      port: 8086,
      database: 'signalk',
      username: 'chiplog',
      password: 'secret',
      selfContext: 'vessels.urn:mrn:imo:mmsi:123456789',
      fetch
    });
    await influx.preload(T0, T0 + MINUTE);

    assert.ok(requests.length > 0);
    const isDiscovery = (q) => q.includes('SHOW MEASUREMENTS') || q.includes('SHOW TAG VALUES');
    const dataRequests = requests.filter((r) => !isDiscovery(r.q));
    assert.ok(dataRequests.length > 0);
    for (const { q, options } of requests) {
      if (!isDiscovery(q)) {
        assert.match(q, /"context" = 'vessels\.urn:mrn:imo:mmsi:123456789'/);
      }
      assert.equal(
        options.headers.authorization,
        `Basic ${Buffer.from('chiplog:secret').toString('base64')}`
      );
    }
  });

  it('surfaces an InfluxDB query error', async () => {
    const influx = createInfluxHistory({
      host: 'h',
      port: 8086,
      database: 'signalk',
      selfContext: 'vessels.self',
      fetch: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ results: [{ error: 'database not found: signalk' }] })
      })
    });

    await assert.rejects(influx.preload(T0, T0 + MINUTE), /database not found/);
  });

  it('surfaces an HTTP-level failure', async () => {
    const influx = createInfluxHistory({
      host: 'h',
      port: 8086,
      database: 'signalk',
      selfContext: 'vessels.self',
      fetch: async () => ({ ok: false, status: 401, text: async () => 'unauthorized' })
    });

    await assert.rejects(influx.preload(T0, T0 + MINUTE), /401/);
  });

  it('gives a clear message when the connection times out, after retrying', async () => {
    const influx = createInfluxHistory({
      host: 'unreachable.example.com',
      port: 8086,
      database: 'signalk',
      selfContext: 'vessels.self',
      retryDelayMs: 0,
      fetch: async () => {
        const err = new Error('The operation was aborted');
        err.name = 'TimeoutError';
        throw err;
      }
    });

    await assert.rejects(influx.preload(T0, T0 + MINUTE), /did not answer within 30s/);
  });

  it('honours a configured query timeout', async () => {
    const influx = createInfluxHistory({
      host: 'unreachable.example.com',
      port: 8086,
      database: 'signalk',
      selfContext: 'vessels.self',
      queryTimeoutSeconds: 5,
      retryDelayMs: 0,
      fetch: async () => {
        const err = new Error('The operation was aborted');
        err.name = 'TimeoutError';
        throw err;
      }
    });

    await assert.rejects(influx.preload(T0, T0 + MINUTE), /did not answer within 5s/);
  });

  it('retries a timed-out query, pausing between attempts, and succeeds once it goes through', async () => {
    // Only the context check times out, so its own retries are the only thing
    // being measured -- discovering engines and fetching the chunk each
    // succeed outright and would otherwise add their own calls to the count.
    let attempts = 0;
    const { fetch: normally } = fakeInflux({});
    const influx = createInfluxHistory({
      host: 'flaky.example.com',
      port: 8086,
      database: 'signalk',
      selfContext: 'vessels.self',
      retryDelayMs: 7,
      fetch: async (url, options) => {
        if (!options.body.get('q').includes('SHOW TAG VALUES')) {
          return normally(url, options);
        }
        attempts += 1;
        if (attempts <= 2) {
          const err = new Error('The operation was aborted');
          err.name = 'TimeoutError';
          throw err;
        }
        return normally(url, options);
      }
    });
    const before = Date.now();

    await influx.preload(T0, T0 + MINUTE);

    assert.equal(attempts, 3, 'two timeouts, then a query that goes through');
    assert.ok(Date.now() - before >= 14, 'paused between the two failed attempts');
  });

  it('retries when the timeout fires while reading a slow response body, not just while connecting', async () => {
    // The connection can come back quickly with the InfluxDB server still slow
    // to stream a large chunk's JSON -- the same timeout budget covers both,
    // and a query stuck in that second phase must be retried exactly the same
    // way as one that never got a response at all.
    let attempts = 0;
    const { fetch: normally } = fakeInflux({});
    const influx = createInfluxHistory({
      host: 'flaky.example.com',
      port: 8086,
      database: 'signalk',
      selfContext: 'vessels.self',
      retryDelayMs: 0,
      fetch: async (url, options) => {
        if (!options.body.get('q').includes('SHOW TAG VALUES')) {
          return normally(url, options);
        }
        attempts += 1;
        if (attempts === 1) {
          return {
            ok: true,
            status: 200,
            json: async () => {
              const err = new Error('The operation was aborted');
              err.name = 'TimeoutError';
              throw err;
            }
          };
        }
        return normally(url, options);
      }
    });

    await influx.preload(T0, T0 + MINUTE);

    assert.equal(attempts, 2, 'the slow body times out once, then the retry goes through');
  });

  it('gives up after retrying the configured number of times', async () => {
    let calls = 0;
    const influx = createInfluxHistory({
      host: 'unreachable.example.com',
      port: 8086,
      database: 'signalk',
      selfContext: 'vessels.self',
      retryDelayMs: 0,
      fetch: async () => {
        calls += 1;
        const err = new Error('The operation was aborted');
        err.name = 'TimeoutError';
        throw err;
      }
    });

    await assert.rejects(influx.preload(T0, T0 + MINUTE), /did not answer within 30s/);
    assert.equal(calls, QUERY_MAX_RETRIES + 1, 'the original attempt plus every retry');
  });

  it('reports each retry attempt as it happens, and clears it once a query goes through', async () => {
    let attempts = 0;
    const seen = [];
    const { fetch: normally } = fakeInflux({});
    const influx = createInfluxHistory({
      host: 'flaky.example.com',
      port: 8086,
      database: 'signalk',
      selfContext: 'vessels.self',
      retryDelayMs: 0,
      onRetry: (attempt, of, message) => seen.push({ attempt, of, message }),
      fetch: async (url, options) => {
        if (!options.body.get('q').includes('SHOW TAG VALUES')) {
          return normally(url, options);
        }
        attempts += 1;
        if (attempts === 1) {
          const err = new Error('The operation was aborted');
          err.name = 'TimeoutError';
          throw err;
        }
        return normally(url, options);
      }
    });

    await influx.preload(T0, T0 + MINUTE);

    assert.equal(seen.at(0).attempt, 1);
    assert.equal(seen.at(0).of, QUERY_MAX_RETRIES);
    assert.match(seen.at(0).message, /did not answer within 30s/);
    assert.deepEqual(seen.at(-1), { attempt: null, of: undefined, message: undefined });
  });

  it('does not retry a failure that is not a timeout', async () => {
    let calls = 0;
    const influx = createInfluxHistory({
      host: 'unreachable.example.com',
      port: 8086,
      database: 'signalk',
      selfContext: 'vessels.self',
      retryDelayMs: 0,
      fetch: async () => {
        calls += 1;
        return { ok: false, status: 500, text: async () => 'boom' };
      }
    });

    await assert.rejects(influx.preload(T0, T0 + MINUTE), /500/);
    assert.equal(calls, 1);
  });

  it('surfaces the real cause of a connection failure, not just "fetch failed"', async () => {
    const influx = createInfluxHistory({
      host: 'unreachable.example.com',
      port: 8086,
      database: 'signalk',
      selfContext: 'vessels.self',
      fetch: async () => {
        throw new TypeError('fetch failed', { cause: new Error('ECONNREFUSED') });
      }
    });

    await assert.rejects(
      influx.preload(T0, T0 + MINUTE),
      /Could not reach InfluxDB at http:\/\/unreachable\.example\.com:8086: ECONNREFUSED/
    );
  });

  it('refuses when the configured context matches none the database actually has', async () => {
    const { influx } = history(
      { 'navigation.speedOverGround': [{ time: T0, value: 1 }] },
      { selfContext: 'vessels.self', contexts: ['vessels.urn:mrn:imo:mmsi:123456789'] }
    );

    await assert.rejects(
      influx.preload(T0, T0 + MINUTE),
      /No data for context "vessels\.self".*vessels\.urn:mrn:imo:mmsi:123456789/
    );
  });

  it('proceeds when the configured context is one the database has', async () => {
    const { influx } = history(
      { 'navigation.speedOverGround': [{ time: T0, value: 1 }] },
      {
        selfContext: 'vessels.self',
        contexts: ['vessels.self', 'vessels.urn:mrn:imo:mmsi:123456789']
      }
    );

    await influx.preload(T0, T0 + MINUTE);
    assert.deepEqual(influx.readSelfPath('navigation.speedOverGround', T0), {
      value: 1,
      timestamp: new Date(T0).toISOString()
    });
  });

  it('does not block on an empty database with no context tag values at all', async () => {
    const { influx } = history({}, { selfContext: 'vessels.self', contexts: [] });

    await influx.preload(T0, T0 + MINUTE);
    assert.equal(influx.readSelfPath('navigation.speedOverGround', T0), undefined);
  });

  describe('chunking a long range', () => {
    const CHUNK = CHUNK_MS;

    it('fetches one chunk at a time rather than the whole range in one query', async () => {
      const { influx, requests } = history({
        'navigation.speedOverGround': [
          { time: T0, value: 1 },
          { time: T0 + CHUNK, value: 2 },
          { time: T0 + 2 * CHUNK, value: 3 }
        ]
      });

      await influx.preload(T0, T0 + 3 * CHUNK);

      const sog = requests.filter((r) => r.q.includes('"navigation.speedOverGround"'));
      assert.equal(sog.length, 3, 'one query per chunk, not one for the whole range');
    });

    it('accumulates every chunk into one continuous series', async () => {
      const { influx } = history({
        'navigation.speedOverGround': [
          { time: T0, value: 1 },
          { time: T0 + CHUNK, value: 2 },
          { time: T0 + 2 * CHUNK, value: 3 }
        ]
      });

      await influx.preload(T0, T0 + 3 * CHUNK);

      assert.deepEqual(influx.readSelfPath('navigation.speedOverGround', T0 + 2 * CHUNK), {
        value: 3,
        timestamp: new Date(T0 + 2 * CHUNK).toISOString()
      });
      assert.deepEqual(influx.readSelfPath('navigation.speedOverGround', T0), {
        value: 1,
        timestamp: new Date(T0).toISOString()
      });
    });

    it('reports progress after each chunk', async () => {
      const { influx } = history({});
      const seen = [];

      await influx.preload(T0, T0 + 3 * CHUNK, (doneToMs, toMs) => seen.push([doneToMs, toMs]));

      assert.deepEqual(seen, [
        [T0 + CHUNK, T0 + 3 * CHUNK],
        [T0 + 2 * CHUNK, T0 + 3 * CHUNK],
        [T0 + 3 * CHUNK, T0 + 3 * CHUNK]
      ]);
    });

    it('makes a single query for a range no longer than one chunk', async () => {
      const { influx, requests } = history({
        'navigation.speedOverGround': [{ time: T0, value: 1 }]
      });

      await influx.preload(T0, T0 + MINUTE);

      const sog = requests.filter((r) => r.q.includes('"navigation.speedOverGround"'));
      assert.equal(sog.length, 1);
    });
  });

  describe('bucketed loading', () => {
    it('asks for the last value of each bucket, per source for navigation.state', async () => {
      const { influx, requests } = history({});
      await influx.preload(T0, T0 + MINUTE, null, { bucketMs: 15000 });

      const data = requests.find((r) => r.q.includes('"navigation.speedOverGround"'));
      assert.match(
        data.q,
        /SELECT last\("value"\) AS "value" FROM "navigation.speedOverGround" .* GROUP BY time\(15000ms\) fill\(none\)/
      );
      assert.match(data.q, /FROM "navigation.state" .* GROUP BY time\(15000ms\), "source"/);
    });

    it('dates each value at the end of its bucket', async () => {
      const { influx } = history({
        'navigation.speedOverGround': [{ time: T0, value: 1 }],
        'navigation.state': [{ time: T0, stringValue: 'sailing', source: 'signalk-autostate.1' }]
      });
      await influx.preload(T0, T0 + MINUTE, null, { bucketMs: 15000 });

      assert.equal(influx.readSelfPath('navigation.speedOverGround', T0 + 14999), undefined);
      assert.deepEqual(influx.readSelfPath('navigation.speedOverGround', T0 + 15000), {
        value: 1,
        timestamp: new Date(T0 + 15000).toISOString()
      });
      const state = influx.readSelfPath('navigation.state', T0 + 15000);
      assert.equal(state.value, 'sailing');
      assert.equal(state.$source, 'signalk-autostate.1');
    });

    it('checks the context and discovers engines only once across loads', async () => {
      const { influx, requests } = history({});
      await influx.preload(T0, T0 + MINUTE);
      await influx.preload(T0 + 10 * MINUTE, T0 + 11 * MINUTE);

      assert.equal(requests.filter((r) => r.q.includes('SHOW MEASUREMENTS')).length, 1);
      assert.equal(requests.filter((r) => r.q.includes('SHOW TAG VALUES')).length, 1);
    });

    it('forgets what was loaded on clear', async () => {
      const { influx } = history({
        'navigation.speedOverGround': [{ time: T0, value: 1 }],
        'navigation.state': [{ time: T0, stringValue: 'sailing', source: 'signalk-autostate.1' }]
      });
      await influx.preload(T0, T0 + MINUTE);
      influx.clear();

      assert.equal(influx.readSelfPath('navigation.speedOverGround', T0), undefined);
      assert.equal(influx.readSelfPath('navigation.state', T0), undefined);
    });
  });

  describe('motion scan', () => {
    const KNOT = 1852 / 3600;
    const HOUR = 60 * MINUTE;

    it('counts the minutes whose mean speed reaches the stopped threshold', async () => {
      const { influx, requests } = history({
        'navigation.speedOverGround': [
          { time: T0, value: 0.1 * KNOT },
          { time: T0 + MINUTE, value: 3 * KNOT },
          { time: T0 + 2 * MINUTE, value: 0.2 * KNOT }
        ]
      });

      const intervals = await influx.scanMotion(T0, T0 + HOUR, { stoppedSpeed: 0.5 * KNOT });

      assert.deepEqual(intervals, [{ from: T0 + MINUTE, to: T0 + 2 * MINUTE }]);
      const scan = requests.find((r) => r.q.includes('mean("value")'));
      assert.match(scan.q, /GROUP BY time\(60000ms\) fill\(none\)/);
    });

    it('follows navigation.state until the next one, whatever the source', async () => {
      // The server resolves the path to whichever source published last, so
      // the scan does the same rather than favouring one of them: the
      // transponder's state counts until signalk-autostate's replaces it.
      const { influx } = history({
        'navigation.state': [
          { time: T0, stringValue: 'motoring', source: 'ais.1' },
          { time: T0 + MINUTE, stringValue: 'sailing', source: 'signalk-autostate.1' },
          { time: T0 + 6 * MINUTE, stringValue: 'sailing', source: 'signalk-autostate.1' },
          { time: T0 + 10 * MINUTE, stringValue: 'moored', source: 'signalk-autostate.1' }
        ]
      });

      const intervals = await influx.scanMotion(T0, T0 + HOUR, { stoppedSpeed: KNOT });

      assert.deepEqual(intervals, [
        { from: T0, to: T0 + MINUTE },
        { from: T0 + MINUTE, to: T0 + 6 * MINUTE },
        { from: T0 + 6 * MINUTE, to: T0 + 10 * MINUTE }
      ]);
    });

    it('stops trusting an under-way state once it would have gone stale', async () => {
      const { influx } = history({
        'navigation.state': [
          { time: T0, stringValue: 'sailing', source: 'signalk-autostate.1' },
          { time: T0 + 5 * HOUR, stringValue: 'moored', source: 'signalk-autostate.1' }
        ]
      });

      const intervals = await influx.scanMotion(T0, T0 + 6 * HOUR, { stoppedSpeed: KNOT });

      assert.deepEqual(intervals, [{ from: T0, to: T0 + 21 * MINUTE }]);
    });

    it('starts from the state already in force before the range', async () => {
      const { influx } = history({
        'navigation.state': [
          { time: T0 - 2 * MINUTE, stringValue: 'motoring', source: 'signalk-autostate.1' },
          { time: T0 + 3 * MINUTE, stringValue: 'anchored', source: 'signalk-autostate.1' }
        ]
      });

      const intervals = await influx.scanMotion(T0, T0 + HOUR, { stoppedSpeed: KNOT });

      assert.deepEqual(intervals, [{ from: T0, to: T0 + 3 * MINUTE }]);
    });

    it('scans a week per request', async () => {
      const { influx, requests } = history({});
      await influx.scanMotion(T0, T0 + 15 * 24 * HOUR, { stoppedSpeed: KNOT });

      assert.equal(requests.filter((r) => r.q.includes('mean("value")')).length, 3);
    });
  });
});

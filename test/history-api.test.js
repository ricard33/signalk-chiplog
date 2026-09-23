const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, it } = require('node:test');
const { openDatabase } = require('../lib/database');
const { createHistoryApiHistory } = require('../lib/history-api');
const { runReplay } = require('../lib/replay');

const T0 = Date.parse('2026-09-13T08:00:00.000Z');
const MINUTE = 60 * 1000;

// A History API provider as `@signalk/server-api` defines one: getValues,
// getContexts and getPaths, answering `{ values: [{ path, method }], data }`
// with one row per bucket, dated at the bucket's start. `records` maps a path
// to `[{ time, value }]`.
function fakeProvider(records, { contexts = ['vessels.self'], fail } = {}) {
  const requests = [];
  const aggregate = (method, samples) => {
    if (samples.length === 0) {
      return null;
    }
    if (method === 'max') {
      return samples.reduce((a, b) => (b > a ? b : a));
    }
    return method === 'first' ? samples[0] : samples[samples.length - 1];
  };

  return {
    requests,
    async getContexts() {
      return contexts;
    },
    async getPaths() {
      return Object.keys(records);
    },
    async getValues(query) {
      requests.push(query);
      if (fail) {
        return fail(query);
      }
      // The InfluxDB 2 provider refuses a position mixed with other paths.
      if (
        query.pathSpecs.some((spec) => spec.path === 'navigation.position') &&
        query.pathSpecs.length > 1
      ) {
        throw new Error('Query result lengths do not match');
      }
      if (new Set(query.pathSpecs.map((spec) => spec.aggregate)).size > 1) {
        throw new Error('Incompatible aggregate functions in one InfluxDB query');
      }
      const from = query.from.epochMilliseconds;
      const to = query.to.epochMilliseconds;
      const bucketMs = query.resolution * 1000;
      const descriptors = query.pathSpecs.map((spec) => ({
        path: spec.path,
        method: spec.aggregate
      }));
      const starts = new Set();
      const inBucket = new Map();
      for (const descriptor of descriptors) {
        for (const item of records[descriptor.path] ?? []) {
          if (item.time < from || item.time >= to) {
            continue;
          }
          const start = from + Math.floor((item.time - from) / bucketMs) * bucketMs;
          starts.add(start);
          const key = `${start}|${descriptor.path}`;
          inBucket.set(key, [...(inBucket.get(key) ?? []), item.value]);
        }
      }
      return {
        context: query.context,
        range: { from: new Date(from).toISOString(), to: new Date(to).toISOString() },
        values: descriptors,
        data: [...starts]
          .sort((a, b) => a - b)
          .map((start) => [
            new Date(start).toISOString(),
            ...descriptors.map((descriptor) =>
              aggregate(descriptor.method, inBucket.get(`${start}|${descriptor.path}`) ?? [])
            )
          ])
      };
    }
  };
}

function historyOf(provider, options = {}) {
  return createHistoryApiHistory({
    getHistoryApi: async () => provider,
    selfContext: 'vessels.self',
    retryDelayMs: 0,
    ...options
  });
}

describe('Signal K History API history', () => {
  it('rebuilds the propulsion branch and reads values back as the server would', async () => {
    const provider = fakeProvider({
      'navigation.position': [{ time: T0, value: [-1.15, 46.16] }],
      'navigation.speedOverGround': [{ time: T0, value: 3 }],
      'navigation.state': [{ time: T0, value: 'motoring' }],
      'propulsion.port.revolutions': [{ time: T0, value: 21 }],
      'propulsion.port.state': [{ time: T0, value: 'started' }],
      'propulsion.port.runTime': [{ time: T0, value: 12_345 }]
    });
    const history = historyOf(provider);

    await history.preload(T0, T0 + 2 * MINUTE, null, { bucketMs: 15_000 });
    const at = T0 + 15_000;

    assert.deepEqual(history.readSelfPath('propulsion', at), { port: {} });
    assert.deepEqual(history.readSelfPath('propulsion.port.revolutions', at), {
      value: 21,
      timestamp: new Date(at).toISOString()
    });
    assert.deepEqual(history.readSelfPath('navigation.position', at).value, {
      longitude: -1.15,
      latitude: 46.16
    });
    assert.equal(history.readSelfPath('navigation.state', at).value, 'motoring');
    assert.equal(history.readSelfPath('navigation.speedOverGround', at).value, 3);
  });

  it('dates a bucketed reading at the end of its bucket', async () => {
    // The replay must never see a reading before it could have been published:
    // a value aggregated over a bucket is only current once the bucket is over.
    const provider = fakeProvider({
      'navigation.speedOverGround': [{ time: T0 + 1000, value: 4 }]
    });
    const history = historyOf(provider);

    await history.preload(T0, T0 + MINUTE, null, { bucketMs: 15_000 });

    assert.equal(history.readSelfPath('navigation.speedOverGround', T0 + 14_000), undefined);
    assert.equal(history.readSelfPath('navigation.speedOverGround', T0 + 15_000).value, 4);
  });

  it('asks for the position the same way as every other path', async () => {
    const provider = fakeProvider({ 'navigation.position': [{ time: T0, value: [-1.15, 46.16] }] });

    await historyOf(provider).preload(T0, T0 + MINUTE, null, { bucketMs: 15_000 });

    const specs = provider.requests.flatMap((query) => query.pathSpecs);
    assert.ok(specs.length > 0);
    assert.deepEqual([...new Set(specs.map((spec) => spec.aggregate))], ['last']);
    // ...and never mixed with another path, which some providers refuse.
    assert.ok(
      provider.requests.every(
        (query) =>
          !query.pathSpecs.some((spec) => spec.path === 'navigation.position') ||
          query.pathSpecs.length === 1
      )
    );
    assert.equal(provider.requests[0].context, 'vessels.self');
    assert.equal(provider.requests[0].resolution, 15);
  });

  it('scans for motion on the highest speed of each minute', async () => {
    // A mean would average a minute of motion away; the scan errs towards
    // replaying too much rather than missing a departure.
    const provider = fakeProvider({
      'navigation.speedOverGround': [
        { time: T0 + 1000, value: 0 },
        { time: T0 + 2000, value: 2 },
        { time: T0 + 3000, value: 0 }
      ]
    });

    const intervals = await historyOf(provider).scanMotion(T0, T0 + 2 * MINUTE, {
      stoppedSpeed: 1
    });

    assert.deepEqual(intervals, [{ from: T0, to: T0 + MINUTE }]);
    const scan = provider.requests.find((query) =>
      query.pathSpecs.some((spec) => spec.path === 'navigation.speedOverGround')
    );
    assert.equal(
      scan.pathSpecs.find((spec) => spec.path === 'navigation.speedOverGround').aggregate,
      'max'
    );
  });

  it('keeps numeric max and string last in separate requests', async () => {
    const provider = fakeProvider({
      'navigation.speedOverGround': [{ time: T0 + 1000, value: 2 }],
      'navigation.state': [{ time: T0 + 1000, value: 'motoring' }]
    });

    await historyOf(provider).scanMotion(T0, T0 + 2 * MINUTE, { stoppedSpeed: 1 });

    assert.ok(
      provider.requests.some(
        (query) =>
          query.pathSpecs.length === 1 &&
          query.pathSpecs[0].path === 'navigation.speedOverGround' &&
          query.pathSpecs[0].aggregate === 'max'
      )
    );
    assert.ok(
      provider.requests.some(
        (query) =>
          query.pathSpecs.length === 1 &&
          query.pathSpecs[0].path === 'navigation.state' &&
          query.pathSpecs[0].aggregate === 'last'
      )
    );
  });

  it('finds moving intervals from navigation.state, whatever its source', async () => {
    const provider = fakeProvider({
      'navigation.state': [
        { time: T0 + MINUTE, value: 'motoring' },
        { time: T0 + 5 * MINUTE, value: 'moored' }
      ]
    });

    const intervals = await historyOf(provider).scanMotion(T0, T0 + 10 * MINUTE, {
      stoppedSpeed: 1
    });

    assert.deepEqual(intervals, [{ from: T0 + MINUTE, to: T0 + 5 * MINUTE }]);
  });

  it('starts from the state already in force before the range', async () => {
    // Without the seed, a passage begun before `from` is missed entirely.
    const provider = fakeProvider({
      'navigation.state': [
        { time: T0 - 2 * MINUTE, value: 'motoring' },
        { time: T0 + 3 * MINUTE, value: 'anchored' }
      ]
    });

    const intervals = await historyOf(provider).scanMotion(T0, T0 + MINUTE * 60, {
      stoppedSpeed: 1
    });

    assert.deepEqual(intervals, [{ from: T0, to: T0 + 3 * MINUTE }]);
  });

  it('fails with the contexts it found when none matches', async () => {
    const provider = fakeProvider({}, { contexts: ['vessels.urn:mrn:imo:mmsi:226123456'] });

    await assert.rejects(
      () => historyOf(provider).scanMotion(T0, T0 + MINUTE, { stoppedSpeed: 1 }),
      /No data for context "vessels.self".*226123456/s
    );
  });

  it('retries a provider that does not answer, then gives up', async () => {
    const retries = [];
    let calls = 0;
    const provider = fakeProvider({}, { fail: () => new Promise(() => (calls += 1)) });
    const history = historyOf(provider, {
      queryTimeoutSeconds: 0.01,
      onRetry: (attempt, of) => attempt !== null && retries.push(`${attempt}/${of}`)
    });

    await assert.rejects(
      () => history.preload(T0, T0 + MINUTE, null, { bucketMs: 15_000 }),
      /did not answer within/
    );
    assert.deepEqual(retries, ['1/3', '2/3', '3/3']);
    assert.equal(calls, 4);
  });

  it('gives up at once when the replay is cancelled mid-request', async () => {
    const controller = new AbortController();
    const provider = fakeProvider({}, { fail: () => new Promise(() => {}) });
    const history = historyOf(provider, { signal: controller.signal, queryTimeoutSeconds: 60 });

    const running = history.preload(T0, T0 + MINUTE, null, { bucketMs: 15_000 });
    controller.abort();

    await assert.rejects(() => running, { name: 'AbortError' });
  });

  it('reconstructs an engine segment from historical RPMs', async () => {
    const records = {
      'navigation.position': [],
      'navigation.speedOverGround': [],
      'propulsion.port.revolutions': []
    };
    for (let time = T0; time < T0 + 20 * MINUTE; time += 15_000) {
      records['navigation.position'].push({
        time,
        value: [-1.15, 46.16 + (time - T0) / 10_000_000]
      });
      records['navigation.speedOverGround'].push({ time, value: 3 });
      records['propulsion.port.revolutions'].push({ time, value: 21 });
    }
    const history = historyOf(fakeProvider(records));
    await history.preload(T0, T0 + 20 * MINUTE, null, { bucketMs: 15_000 });

    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chiplog-history-api-'));
    const { db } = openDatabase(dataDir);
    try {
      await runReplay({
        db,
        settings: {},
        history: history.readSelfPath,
        from: new Date(T0).toISOString(),
        to: new Date(T0 + 20 * MINUTE).toISOString()
      });
      assert.equal(db.prepare('SELECT type FROM propulsion_segments').get().type, 'engine');
    } finally {
      db.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

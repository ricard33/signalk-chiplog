const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, it, afterEach } = require('node:test');
const { openDatabase } = require('../lib/database');
const { createReplayJob } = require('../lib/replay-job');
const { QUERY_MAX_RETRIES } = require('../lib/influx-history');
const { insert, insertEntry } = require('./helpers');

const T0 = Date.parse('2026-09-13T08:00:00.000Z');
const MINUTE = 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();

function emptyInfluxFetch() {
  return async (url, options) => {
    const q = options.body.get('q');
    const statements = q.split(';');
    return {
      ok: true,
      status: 200,
      json: async () => ({ results: statements.map(() => ({})) })
    };
  };
}

function openDb() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chiplog-replay-job-'));
  const { db } = openDatabase(dataDir);
  return { db, dataDir };
}

async function waitUntilIdle(job, { timeoutMs = 2000 } = {}) {
  const start = Date.now();
  while (job.status().running) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('replay job never finished');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('replay job', () => {
  let db;
  let dataDir;

  afterEach(() => {
    db?.close();
    if (dataDir) {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  const configuredSettings = () => ({
    influxProtocol: 'http',
    influxHost: 'influx.example.com',
    influxPort: 8086,
    influxDatabase: 'signalk',
    influxUsername: '',
    influxPassword: ''
  });

  it('refuses to start without an InfluxDB connection configured', () => {
    ({ db, dataDir } = openDb());
    const job = createReplayJob({ db, settings: {}, app: { selfContext: 'vessels.self' } });

    assert.throws(() => job.start(iso(T0), iso(T0 + MINUTE)), /InfluxDB/);
  });

  it('uses the Signal K History API without an InfluxDB connection', async () => {
    ({ db, dataDir } = openDb());
    const requests = [];
    const provider = {
      getContexts: async () => ['vessels.legacy'],
      getPaths: async () => [],
      getValues: async (query) => {
        requests.push(query);
        return { values: query.pathSpecs, data: [] };
      }
    };
    const job = createReplayJob({
      db,
      settings: {
        retrospectiveHistorySource: 'signalk',
        // The vessel context applies to either history source: replaying from
        // a development server against a boat's own history needs it here too.
        influxSelfContext: 'vessels.legacy'
      },
      app: {
        selfContext: 'vessels.self',
        getHistoryApi: async (...args) => {
          assert.deepEqual(args, []);
          return provider;
        }
      }
    });

    assert.equal(job.status().configured, true);
    job.start(iso(T0), iso(T0 + MINUTE));
    await waitUntilIdle(job);

    assert.equal(job.status().lastError, null);
    assert.ok(requests.length > 0, 'the provider receives the motion scan');
    assert.equal(requests[0].context, 'vessels.legacy');
  });

  it('reports a missing History API instead of leaving the replay running', async () => {
    ({ db, dataDir } = openDb());
    const job = createReplayJob({
      db,
      settings: { retrospectiveHistorySource: 'signalk' },
      app: { selfContext: 'vessels.self' }
    });

    job.start(iso(T0), iso(T0 + MINUTE));
    await waitUntilIdle(job);

    assert.match(job.status().lastError.message, /does not expose the History API/);
  });

  it('refuses to start while a passage is under way, whatever the requested range', () => {
    ({ db, dataDir } = openDb());
    // Under way now, long after the range being replayed: the point isn't
    // that the dates overlap, it's that the live detector and the replay
    // would both be driving this same passage's row at once.
    insertEntry(db, { state: 'active', start_time: iso(T0 + 365 * 24 * 60 * MINUTE) });
    const job = createReplayJob({
      db,
      settings: configuredSettings(),
      app: { selfContext: 'vessels.self' },
      fetch: emptyInfluxFetch()
    });

    assert.throws(() => job.start(iso(T0), iso(T0 + MINUTE)), /under way/);
  });

  it('refuses a range overlapping a passage already on record', () => {
    ({ db, dataDir } = openDb());
    insertEntry(db, {
      state: 'closed',
      start_time: iso(T0),
      end_time: iso(T0 + 10 * MINUTE)
    });
    const job = createReplayJob({
      db,
      settings: configuredSettings(),
      app: { selfContext: 'vessels.self' },
      fetch: emptyInfluxFetch()
    });

    assert.throws(() => job.start(iso(T0 + 5 * MINUTE), iso(T0 + 20 * MINUTE)), /overlap/);
  });

  it('runs in the background and reports completion', async () => {
    ({ db, dataDir } = openDb());
    const job = createReplayJob({
      db,
      settings: configuredSettings(),
      app: { selfContext: 'vessels.self' },
      fetch: emptyInfluxFetch()
    });

    const result = job.start(iso(T0), iso(T0 + 3 * MINUTE));
    assert.deepEqual(result, { from: iso(T0), to: iso(T0 + 3 * MINUTE) });
    assert.equal(job.status().running, true);
    assert.equal(job.status().progress.phase, 'scanning', 'starts by scanning the history');

    await waitUntilIdle(job);

    const status = job.status();
    assert.equal(status.running, false);
    assert.equal(status.progress, null);
    assert.deepEqual(status.lastResult, {
      at: status.lastResult.at,
      from: iso(T0),
      to: iso(T0 + 3 * MINUTE),
      summary: {
        passages: 0,
        distance: 0,
        engineDuration: 0,
        sailDuration: 0,
        trackPoints: 0,
        events: 0
      }
    });
    assert.equal(status.lastError, null);
  });

  it('sums up what the run reconstructed, and only that', async () => {
    ({ db, dataDir } = openDb());
    // Already on record before the run, outside its range.
    insertEntry(db, {
      start_time: iso(T0 - 120 * MINUTE),
      end_time: iso(T0 - 60 * MINUTE),
      distance: 5000
    });
    const empty = emptyInfluxFetch();
    let reconstructed = false;
    const job = createReplayJob({
      db,
      settings: configuredSettings(),
      app: { selfContext: 'vessels.self' },
      fetch: async (url, options) => {
        if (!reconstructed) {
          reconstructed = true;
          // What the replay would have written...
          const id = insertEntry(db, {
            start_time: iso(T0 + 5 * MINUTE),
            end_time: iso(T0 + 40 * MINUTE),
            distance: 7000,
            engine_duration: 600,
            sail_duration: 1500
          });
          insert(db, 'track_points', {
            entry_id: id,
            time: iso(T0 + 6 * MINUTE),
            lat: 46,
            lon: -1
          });
          insert(db, 'track_points', {
            entry_id: id,
            time: iso(T0 + 7 * MINUTE),
            lat: 46,
            lon: -1
          });
          insert(db, 'events', {
            entry_id: id,
            time: iso(T0 + 8 * MINUTE),
            type: 'autopilot',
            subtype: 'engaged',
            payload: '{}',
            source: 'auto',
            created_at: iso(T0 + 8 * MINUTE)
          });
          // ...and a passage live detection opened meanwhile, today.
          insertEntry(db, { state: 'active', start_time: iso(T0 + 365 * 24 * 60 * MINUTE) });
        }
        return empty(url, options);
      }
    });

    job.start(iso(T0), iso(T0 + 60 * MINUTE));
    await waitUntilIdle(job);

    assert.deepEqual(job.status().lastResult.summary, {
      passages: 1,
      distance: 7000,
      engineDuration: 600,
      sailDuration: 1500,
      trackPoints: 2,
      events: 1
    });
  });

  it('refuses a second replay while one is already running', async () => {
    ({ db, dataDir } = openDb());
    const job = createReplayJob({
      db,
      settings: configuredSettings(),
      app: { selfContext: 'vessels.self' },
      fetch: emptyInfluxFetch()
    });

    job.start(iso(T0), iso(T0 + 3 * MINUTE));
    assert.throws(() => job.start(iso(T0), iso(T0 + MINUTE)), /running/);

    await waitUntilIdle(job);
  });

  it('can be cancelled mid-flight', async () => {
    ({ db, dataDir } = openDb());
    const job = createReplayJob({
      db,
      settings: configuredSettings(),
      app: { selfContext: 'vessels.self' },
      fetch: emptyInfluxFetch()
    });

    job.start(iso(T0), iso(T0 + 60 * MINUTE));
    assert.equal(job.cancel(), true);

    await waitUntilIdle(job);
    assert.equal(job.status().lastResult.cancelled, true);
    assert.equal(job.cancel(), false, 'nothing left to cancel once it has stopped');
  });

  it('surfaces an InfluxDB failure as lastError', async () => {
    ({ db, dataDir } = openDb());
    const job = createReplayJob({
      db,
      settings: configuredSettings(),
      app: { selfContext: 'vessels.self' },
      fetch: async () => ({ ok: false, status: 500, text: async () => 'boom' })
    });

    job.start(iso(T0), iso(T0 + MINUTE));
    await waitUntilIdle(job);

    const status = job.status();
    assert.equal(status.running, false);
    assert.match(status.lastError.message, /500/);
  });

  it('surfaces a retry attempt in progress.retry while it is in flight, then clears it', async () => {
    ({ db, dataDir } = openDb());
    const empty = emptyInfluxFetch();
    let timedOutOnce = false;
    const job = createReplayJob({
      db,
      settings: configuredSettings(),
      app: { selfContext: 'vessels.self' },
      retryDelayMs: 300,
      fetch: async (url, options) => {
        if (!timedOutOnce && options.body.get('q').includes('SHOW TAG VALUES')) {
          timedOutOnce = true;
          const err = new Error('The operation was aborted');
          err.name = 'TimeoutError';
          throw err;
        }
        return empty(url, options);
      }
    });

    job.start(iso(T0), iso(T0 + MINUTE));

    const start = Date.now();
    let retry = null;
    while (!retry && Date.now() - start < 2000) {
      retry = job.status().progress?.retry;
      if (!retry) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }

    assert.ok(retry, 'the retry notice should appear while the pause is in flight');
    assert.equal(retry.attempt, 1);
    assert.equal(retry.of, QUERY_MAX_RETRIES);
    assert.match(retry.message, /did not answer within/);

    await waitUntilIdle(job);
    assert.equal(job.status().progress, null, 'nothing left to show once the run is done');
  });

  it('keeps a summary of what an earlier slice already committed when a later query fails', async () => {
    ({ db, dataDir } = openDb());
    let calls = 0;
    const job = createReplayJob({
      db,
      settings: configuredSettings(),
      app: { selfContext: 'vessels.self' },
      fetch: async () => {
        calls += 1;
        if (calls === 1) {
          // What an earlier committed slice of the same run would have left
          // behind, before the query below fails.
          insertEntry(db, {
            start_time: iso(T0 + 5 * MINUTE),
            end_time: iso(T0 + 40 * MINUTE),
            distance: 7000
          });
          return { ok: true, status: 200, json: async () => ({ results: [{}] }) };
        }
        throw new Error('network down');
      }
    });

    job.start(iso(T0), iso(T0 + 60 * MINUTE));
    await waitUntilIdle(job);

    const status = job.status();
    assert.match(status.lastError.message, /network down/);
    assert.equal(status.lastError.summary.passages, 1);
    assert.equal(status.lastError.summary.distance, 7000);
  });

  it('calls onDone once the attempt finishes, so newly-pending place names can be picked up', async () => {
    ({ db, dataDir } = openDb());
    let doneCalls = 0;
    const job = createReplayJob({
      db,
      settings: configuredSettings(),
      app: { selfContext: 'vessels.self' },
      fetch: emptyInfluxFetch(),
      onDone: () => doneCalls++
    });

    job.start(iso(T0), iso(T0 + MINUTE));
    assert.equal(doneCalls, 0, 'not called while still running');

    await waitUntilIdle(job);
    assert.equal(doneCalls, 1);
  });
});

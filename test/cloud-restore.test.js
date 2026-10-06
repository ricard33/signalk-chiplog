const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, it, beforeEach, afterEach } = require('node:test');
const { openDatabase } = require('../lib/database');
const { createCloudRestore } = require('../lib/cloud-restore');
const {
  createCloudSync,
  CLOUD_SYNC_DEFAULTS,
  TRACK_CHUNK_POINTS,
  getLogbookId,
  isRestoring,
  passageContent
} = require('../lib/cloud-sync');
const { allPlaces } = require('../lib/places');
const { allTrackPoints } = require('../lib/track');
const { T0, at, insert, insertEntry, startServer } = require('./helpers');

const SETTINGS = {
  ...CLOUD_SYNC_DEFAULTS,
  cloudSyncEnabled: true,
  cloudSyncUrl: 'https://service.test/',
  cloudSyncToken: 'ma_token'
};

// A stand-in for the service that holds exactly what `source`, a logbook, would have sent it,
// and gives it back through the restore routes -- as JSON, so nothing survives that a real
// answer would not carry.
function serviceHolding(source) {
  const logbookId = getLogbookId(source);
  const requests = [];
  const control = { failAfter: Infinity, trash: new Set() };
  const rows = () =>
    source
      .prepare('SELECT * FROM log_entries ORDER BY id')
      .all()
      .filter((row) => !control.trash.has(row.id));
  const chunksOf = (id) => {
    const points = allTrackPoints(source, id);
    const chunks = [];
    for (let start = 0; start < points.length; start += TRACK_CHUNK_POINTS) {
      chunks.push(points.slice(start, start + TRACK_CHUNK_POINTS));
    }
    return chunks;
  };
  const reply = (status, body) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' }
    });

  async function fetch(url, { method, headers }) {
    const route = new URL(url).pathname;
    requests.push({ method, route, headers });
    assert.equal(method, 'GET');
    assert.equal(headers.authorization, 'Bearer ma_token');
    if (requests.length > control.failAfter) {
      throw new TypeError('fetch failed');
    }
    if (route === '/v1/restore/logbooks') {
      const held = rows();
      return reply(200, {
        formatVersions: [1],
        logbooks:
          held.length === 0
            ? []
            : [
                {
                  logbookId,
                  passages: held.length,
                  firstStart: held[0].start_time,
                  lastStart: held.at(-1).start_time
                }
              ]
      });
    }
    const match = /^\/v1\/logbooks\/([^/]+)\/(restore|passages\/(\d+)(?:\/track\/(\d+))?)$/.exec(
      route
    );
    assert.ok(match, `unexpected route ${route}`);
    if (match[1] !== logbookId) {
      return reply(200, { passages: [], places: [] });
    }
    if (match[2] === 'restore') {
      return reply(200, {
        passages: rows().map((row) => ({
          originId: row.id,
          trackChunks: chunksOf(row.id).length,
          pointCount: allTrackPoints(source, row.id).length
        })),
        places: allPlaces(source).map(({ id, name, position, source: from, countryCode }) => ({
          id,
          name,
          position,
          source: from,
          countryCode
        }))
      });
    }
    const row = rows().find((item) => item.id === Number(match[3]));
    if (!row) {
      return reply(404, { error: 'passage_not_found', message: 'No such passage' });
    }
    if (match[4] === undefined) {
      const chunks = chunksOf(row.id);
      return reply(200, {
        formatVersion: 1,
        passage: passageContent(source, row),
        track: { pointCount: chunks.flat().length, chunks: chunks.length }
      });
    }
    const chunk = chunksOf(row.id)[Number(match[4])];
    return chunk
      ? reply(200, { points: chunk })
      : reply(404, { error: 'chunk_not_found', message: 'Never received' });
  }

  return { fetch, requests, control, logbookId };
}

// A logbook with a bit of everything a passage can carry.
function sailedLogbook(db) {
  const rochelle = insert(db, 'places', {
    name: 'La Rochelle',
    lat: 46.15,
    lon: -1.15,
    source: 'geocoding',
    country_code: 'FR',
    country_checked: 1,
    created_at: T0,
    updated_at: T0
  });
  const yeu = insert(db, 'places', {
    name: 'Île d’Yeu',
    lat: 46.72,
    lon: -2.35,
    source: 'manual',
    created_at: T0,
    updated_at: T0
  });
  const skipper = insert(db, 'crew_members', {
    name: 'Cédric',
    role: 'skipper',
    created_at: T0,
    updated_at: T0
  });

  const first = insertEntry(db, {
    start_place_id: rochelle,
    end_place_id: yeu,
    start_place_name: 'La Rochelle',
    end_place_name: 'Île d’Yeu',
    start_lat: 46.15,
    start_lon: -1.15,
    end_lat: 46.72,
    end_lon: -2.35,
    distance: 85000,
    engine_duration: 1800,
    sail_duration: 12600,
    start_tanks: JSON.stringify([{ name: 'fuel', level: 0.8 }]),
    start_batteries: JSON.stringify([{ name: 'house', voltage: 12.7 }])
  });
  for (let n = 0; n < 5; n += 1) {
    insert(db, 'track_points', {
      entry_id: first,
      time: at(n / 10),
      lat: 46.15 + n / 100,
      lon: -1.15 - n / 50,
      sog: 3.1,
      cog: 5.2,
      tws: 7.5,
      heading: 5.1
    });
  }
  const castOff = insert(db, 'events', {
    entry_id: first,
    time: T0,
    type: 'manoeuvre',
    subtype: 'cast_off',
    lat: 46.15,
    lon: -1.15,
    source: 'manual',
    client_ref: 'ref-1',
    created_at: T0
  });
  insert(db, 'events', {
    entry_id: first,
    time: at(1),
    type: 'text_annotation',
    comment: 'Dauphins à l’étrave',
    payload: JSON.stringify({ mood: 'good' }),
    source: 'manual',
    created_at: at(1)
  });
  db.prepare('UPDATE log_entries SET opened_by_event_id = ? WHERE id = ?').run(castOff, first);
  insert(db, 'observations', {
    entry_id: first,
    time: at(1),
    reason: 'periodic',
    lat: 46.3,
    lon: -1.5,
    sog: 3,
    depth: 22.5,
    pressure: 101500,
    air_temp: 291.2,
    engine_runtimes: JSON.stringify({ port: 3600 })
  });
  insert(db, 'propulsion_segments', {
    entry_id: first,
    type: 'engine',
    start_time: T0,
    end_time: at(0.5),
    average_rpm: 1800
  });
  insert(db, 'propulsion_segments', {
    entry_id: first,
    type: 'sail',
    start_time: at(0.5),
    end_time: at(4),
    source: 'manual'
  });
  insert(db, 'log_entry_crew', {
    entry_id: first,
    crew_member_id: skipper,
    name: 'Cédric',
    role: 'skipper',
    created_at: T0
  });
  insert(db, 'log_entry_crew', { entry_id: first, name: 'Anne', created_at: T0 });
  insert(db, 'tide_forecasts', {
    entry_id: first,
    lat: 46.15,
    lon: -1.15,
    fetched_at: T0,
    points: JSON.stringify([{ time: T0, height: 2.1 }])
  });
  insert(db, 'weather_forecasts', {
    entry_id: first,
    lat: 46.15,
    lon: -1.15,
    fetched_at: T0,
    points: JSON.stringify([{ time: T0, windSpeed: 6 }])
  });

  const second = insertEntry(db, {
    start_time: at(24),
    end_time: at(30),
    start_place_id: yeu,
    start_place_name: 'Île d’Yeu',
    distance: 40000
  });
  insert(db, 'track_points', { entry_id: second, time: at(25), lat: 46.7, lon: -2.3 });
  insert(db, 'log_entry_crew', {
    entry_id: second,
    crew_member_id: skipper,
    name: 'Cédric',
    role: 'skipper',
    created_at: at(24)
  });
  return { first, second };
}

describe('restoring from the online backup', () => {
  let dirs;
  let source;
  let db;
  let service;
  let logs;
  let done;

  function open() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chiplog-restore-'));
    dirs.push(dir);
    return openDatabase(dir).db;
  }

  function restorer(settings = {}) {
    return createCloudRestore({
      db,
      settings: { ...SETTINGS, ...settings },
      userAgent: 'signalk-chiplog/2.9.0',
      log: (level, message) => logs.push({ level, message }),
      onDone: () => {
        done += 1;
      },
      fetch: service.fetch,
      clock: () => Date.parse(at(100))
    });
  }

  beforeEach(() => {
    dirs = [];
    source = open();
    db = open();
    sailedLogbook(source);
    service = serviceHolding(source);
    logs = [];
    done = 0;
  });

  afterEach(() => {
    source.close();
    db.close();
    dirs.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
  });

  const entries = (database) => database.prepare('SELECT * FROM log_entries ORDER BY id').all();

  it('offers the logbooks the service holds, but not this one', async () => {
    const restore = restorer();

    assert.equal(restore.status().possible, true);
    const logbooks = await restore.candidates();

    assert.deepEqual(logbooks, [
      { logbookId: service.logbookId, passages: 2, firstStart: T0, lastStart: at(24) }
    ]);
    // The logbook the service holds, asking for itself: nothing to restore.
    db.prepare('UPDATE logbook_identity SET id = ?').run(service.logbookId);
    assert.deepEqual(await restore.candidates(), []);
  });

  it('brings every passage back as it was, under the identity of the logbook restored', async () => {
    const restore = restorer();

    await restore.start(service.logbookId).finished;

    assert.equal(restore.status().lastError, null);
    assert.deepEqual(restore.status().lastResult, {
      at: at(100),
      logbookId: service.logbookId,
      passages: 2,
      failed: 0,
      total: 2
    });
    assert.equal(getLogbookId(db), service.logbookId);
    assert.equal(isRestoring(db), false);
    assert.equal(done, 1, 'the backup is told to carry on');

    const restored = entries(db);
    assert.deepEqual(
      restored.map((row) => row.id),
      entries(source).map((row) => row.id)
    );
    for (const row of entries(source)) {
      const copy = restored.find((item) => item.id === row.id);
      // To the letter, key order included: the passage then hashes as it did when sent, and
      // the next backup has nothing to send again.
      assert.equal(
        JSON.stringify(passageContent(db, copy)),
        JSON.stringify(passageContent(source, row))
      );
      assert.deepEqual(allTrackPoints(db, row.id), allTrackPoints(source, row.id));
    }
    assert.deepEqual(
      allPlaces(db).map(({ id, name, position, source: from, countryCode }) => ({
        id,
        name,
        position,
        from,
        countryCode
      })),
      allPlaces(source).map(({ id, name, position, source: from, countryCode }) => ({
        id,
        name,
        position,
        from,
        countryCode
      }))
    );
    assert.deepEqual(
      db
        .prepare('SELECT id, name, role FROM crew_members')
        .all()
        .map((row) => ({ ...row })),
      [{ id: 1, name: 'Cédric', role: 'skipper' }],
      'the crew list is made again from the passages'
    );
  });

  it('emails nobody the summary of a passage restored', async () => {
    await restorer().start(service.logbookId).finished;

    assert.deepEqual(
      db
        .prepare('SELECT entry_id, error FROM passage_summary_mails ORDER BY entry_id')
        .all()
        .map((row) => ({ ...row })),
      [
        { entry_id: 1, error: 'restored from the online backup' },
        { entry_id: 2, error: 'restored from the online backup' }
      ]
    );
  });

  it('closes a passage that was under way when it was last sent, where its track ends', async () => {
    const active = insertEntry(source, { state: 'active', start_time: at(48) });
    insert(source, 'track_points', { entry_id: active, time: at(49), lat: 46, lon: -2 });
    insert(source, 'track_points', { entry_id: active, time: at(50), lat: 46.1, lon: -2.1 });

    await restorer().start(service.logbookId).finished;

    const row = db.prepare('SELECT state, end_time FROM log_entries WHERE id = ?').get(active);
    assert.deepEqual({ ...row }, { state: 'closed', end_time: at(50) });
  });

  it('only fills an empty logbook', () => {
    insertEntry(db);
    const restore = restorer();

    assert.equal(restore.status().possible, false);
    assert.throws(
      () => restore.start(service.logbookId),
      (error) => error.code === 'logbook_not_empty'
    );
    assert.notEqual(getLogbookId(db), service.logbookId);
    assert.equal(entries(db).length, 1);
  });

  it('needs the boat to be paired', async () => {
    const restore = restorer({ cloudSyncToken: null });

    assert.equal(restore.status().possible, false);
    assert.deepEqual(await restore.candidates(), []);
    assert.throws(
      () => restore.start(service.logbookId),
      (error) => error.code === 'cloud_sync_not_configured'
    );
  });

  it('cut short, holds the backup off and carries on where it stopped', async () => {
    // The index and the first passage arrive, then the link drops.
    service.control.failAfter = 3;
    const restore = restorer();

    await restore.start(service.logbookId).finished;

    assert.match(restore.status().lastError.message, /fetch failed/);
    assert.equal(restore.status().restoring, true);
    assert.equal(done, 0);
    assert.equal(getLogbookId(db), service.logbookId, 'the identity is taken first');
    assert.deepEqual(
      entries(db).map((row) => row.id),
      [1]
    );
    // A backup now would tell the service passage 2 was deleted on board.
    const sync = createCloudSync({
      db,
      settings: SETTINGS,
      userAgent: 'signalk-chiplog/2.9.0',
      log: () => {},
      fetch: () => assert.fail('the backup must not reach the service during a restore')
    });
    assert.equal((await sync.resolveNext()).outcome, 'restoring');

    // Meanwhile the boat sails: the new passage takes a number past those still to come.
    const live = insertEntry(db, { state: 'active', start_time: at(90) });
    assert.equal(live, 3);

    service.control.failAfter = Infinity;
    const before = service.requests.length;
    await restore.resume().finished;

    assert.equal(restore.status().restoring, false);
    assert.deepEqual(
      entries(db).map((row) => row.id),
      [1, 2, 3]
    );
    assert.equal(restore.status().lastResult.passages, 1, 'the first one is not fetched again');
    assert.ok(
      !service.requests.slice(before).some((request) => request.route.endsWith('/passages/1'))
    );
    assert.equal(done, 1);
  });

  it('has nothing to carry on with when no restore was cut short', () => {
    assert.equal(restorer().resume(), null);
  });

  it('keeps one passage it cannot write from blocking the others', async () => {
    // A kind of event this version of the plugin does not know.
    source.exec('PRAGMA ignore_check_constraints = ON');
    insert(source, 'events', {
      entry_id: 1,
      time: at(2),
      type: 'from_the_future',
      source: 'auto',
      created_at: at(2)
    });
    source.exec('PRAGMA ignore_check_constraints = OFF');
    const restore = restorer();

    await restore.start(service.logbookId).finished;

    assert.deepEqual(
      entries(db).map((row) => row.id),
      [2]
    );
    assert.equal(restore.status().lastResult.failed, 1);
    assert.equal(isRestoring(db), false);
    assert.ok(logs.some((line) => /Passage 1 could not be restored/.test(line.message)));
    assert.equal(db.prepare('SELECT count(*) AS n FROM track_points').get().n, 1);
  });

  it('restores a passage with the track the service has, when a chunk never arrived', async () => {
    const original = service.fetch;
    service.fetch = (url, options) =>
      new URL(url).pathname.endsWith('/passages/1/track/0')
        ? Promise.resolve(
            new Response(JSON.stringify({ error: 'chunk_not_found', message: 'Never received' }), {
              status: 404
            })
          )
        : original(url, options);

    await restorer().start(service.logbookId).finished;

    assert.equal(entries(db).length, 2);
    assert.equal(allTrackPoints(db, 1).length, 0);
    assert.equal(allTrackPoints(db, 2).length, 1);
  });
});

describe('restore API', () => {
  let server;

  beforeEach(async () => {
    server = await startServer();
  });

  afterEach(() => server.close());

  it('reports the restore with the backup', async () => {
    const { status, body } = await server.request('GET', '/cloud-sync');

    assert.equal(status, 200);
    assert.deepEqual(body.restore, {
      restoring: false,
      running: false,
      possible: false,
      inProgress: null,
      lastResult: null,
      lastError: null
    });
  });

  it('offers nothing while the boat is not paired', async () => {
    const { status, body } = await server.request('GET', '/cloud-sync/restore');

    assert.equal(status, 200);
    assert.deepEqual(body.logbooks, []);
  });

  it('refuses to start without a logbook, or unpaired', async () => {
    const missing = await server.request('POST', '/cloud-sync/restore', {});
    const unpaired = await server.request('POST', '/cloud-sync/restore', {
      logbookId: '0b6f7c1e-8f3a-4c59-9d57-0c2f3a1b9e11'
    });

    assert.equal(missing.status, 400);
    assert.equal(unpaired.status, 409);
    assert.equal(unpaired.body.error.code, 'cloud_sync_not_configured');
  });

  it('lets anyone read the restore, and only an admin start one', () => {
    const level = (method, route) =>
      server.permissions.find((item) => item.method === method && item.path === route)?.level;

    assert.equal(level('GET', '/api/cloud-sync/restore'), 'readonly');
    assert.notEqual(level('POST', '/api/cloud-sync/restore'), 'readonly');
  });
});

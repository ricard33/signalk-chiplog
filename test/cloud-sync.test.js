const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { describe, it, beforeEach, afterEach } = require('node:test');
const { openDatabase } = require('../lib/database');
const {
  createCloudSync,
  CLOUD_SYNC_DEFAULTS,
  COSTLY_INTERVAL_MS,
  LIGHT_CHUNK_POINTS,
  TRACK_CHUNK_POINTS,
  lightTrack,
  getLogbookId,
  jsonHash
} = require('../lib/cloud-sync');
const { T0, at, insert, insertEntry, startServer } = require('./helpers');

const SETTINGS = {
  ...CLOUD_SYNC_DEFAULTS,
  cloudSyncEnabled: true,
  cloudSyncUrl: 'https://service.test/',
  cloudSyncToken: 'ma_token'
};

// An in-memory stand-in for the service, keeping to its protocol: it holds what it was sent,
// answers which chunks it lacks, and refuses a chunk the passage does not declare.
function fakeService() {
  const passages = new Map();
  // What the service holds of the logbook's places; `knowsPlaces` off is an older service.
  const places = { hash: null, list: [], knowsPlaces: true };
  const requests = [];
  const control = { down: false, status: null };

  const reply = (status, body) =>
    new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' }
    });

  async function fetch(url, { method, headers, body }) {
    const route = new URL(url).pathname;
    requests.push({ method, route, headers, bytes: body ? body.length : 0 });
    if (control.down) {
      throw new TypeError('fetch failed');
    }
    if (control.status) {
      return reply(control.status, { error: 'unauthorized', message: 'Unknown token' });
    }
    const payload = body ? JSON.parse(zlib.gunzipSync(body)) : undefined;
    const match =
      /^\/v1\/logbooks\/([^/]+)(?:\/passages\/(\d+)(?:\/track\/(\d+))?|\/sync-state|\/places)$/.exec(
        route
      );
    assert.ok(match, `unexpected route ${route}`);
    const originId = match[2] && Number(match[2]);
    const index = match[3] && Number(match[3]);

    if (method === 'GET') {
      return reply(200, {
        formatVersions: [1],
        passages: [...passages.entries()].map(([id, p]) => ({
          originId: id,
          contentHash: p.contentHash,
          trackHash: jsonHash(p.chunkHashes),
          complete: p.chunkHashes.every((hash, i) => p.chunks.get(i) === hash),
          light: p.light
        })),
        ...(places.knowsPlaces ? { placesHash: places.hash } : {})
      });
    }
    if (route.endsWith('/places')) {
      assert.equal(jsonHash(payload.places), payload.hash);
      places.hash = payload.hash;
      places.list = payload.places;
      return reply(204);
    }
    if (method === 'DELETE') {
      passages.delete(originId);
      return reply(204);
    }
    if (index === undefined) {
      const previous = passages.get(originId);
      if (payload.light && previous && !previous.light) {
        return reply(409, { error: 'full_copy_held', message: 'A full copy is held' });
      }
      assert.equal(jsonHash(payload.passage), payload.contentHash);
      const chunks = new Map();
      payload.track.chunkHashes.forEach((hash, i) => {
        if (previous?.chunks.get(i) === hash) {
          chunks.set(i, hash);
        }
      });
      passages.set(originId, {
        contentHash: payload.contentHash,
        light: payload.light === true,
        content: payload.passage,
        chunkHashes: payload.track.chunkHashes,
        chunks,
        points: new Map(previous ? [...previous.points].filter(([i]) => chunks.has(i)) : [])
      });
      return reply(200, {
        missingChunks: payload.track.chunkHashes.map((_, i) => i).filter((i) => !chunks.has(i))
      });
    }
    const passage = passages.get(originId);
    assert.equal(jsonHash(payload.points), payload.hash);
    assert.equal(passage.chunkHashes[index], payload.hash);
    passage.chunks.set(index, payload.hash);
    passage.points.set(index, payload.points);
    return reply(204);
  }

  return { fetch, passages, places, requests, control };
}

function point(n) {
  return { time: new Date(Date.parse(T0) + n * 1000).toISOString(), lat: 46, lon: -1.2 };
}

describe('online backup', () => {
  let dataDir;
  let db;
  let service;
  let logs;

  function sync(settings = {}) {
    return createCloudSync({
      db,
      settings: { ...SETTINGS, ...settings },
      userAgent: 'signalk-chiplog/2.9.0',
      log: (level, message) => logs.push({ level, message }),
      fetch: service.fetch,
      clock: () => Date.parse(at(6))
    });
  }

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chiplog-cloud-'));
    ({ db } = openDatabase(dataDir));
    service = fakeService();
    logs = [];
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('gives the logbook a lasting UUID of its own', () => {
    const id = getLogbookId(db);
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    db.close();
    ({ db } = openDatabase(dataDir));
    assert.equal(getLogbookId(db), id);
  });

  it('sends every passage with its track, filed under the logbook', async () => {
    const older = insertEntry(db, { start_time: at(-48), end_time: at(-44) });
    const newer = insertEntry(db, { start_time: at(0), end_time: at(4) });
    for (let n = 0; n < 3; n += 1) {
      insert(db, 'track_points', { entry_id: newer, ...point(n) });
    }

    const result = await sync().resolveNext();

    assert.equal(result.outcome, 'sent');
    assert.equal(result.retryInMs, 15 * 60 * 1000);
    assert.deepEqual([...service.passages.keys()].sort(), [older, newer].sort());
    const sent = service.passages.get(newer);
    assert.equal(sent.content.entry.id, newer);
    assert.deepEqual(
      sent.points.get(0).map((p) => p.time),
      [0, 1, 2].map((n) => point(n).time)
    );
    const first = service.requests.find((r) => r.method === 'PUT');
    assert.match(first.route, new RegExp(`^/v1/logbooks/${getLogbookId(db)}/passages/${newer}$`));
    assert.equal(first.headers.authorization, 'Bearer ma_token');
    assert.equal(first.headers['content-encoding'], 'gzip');
    assert.equal(first.headers['x-chiplog-version'], '2.9.0');
  });

  it('says how many passages are on board, for the service to tell how far the backup is', async () => {
    insertEntry(db, { start_time: at(-48), end_time: at(-44) });
    insertEntry(db, { start_time: at(0), end_time: at(4) });

    await sync().resolveNext();

    const asked = service.requests.find((r) => r.method === 'GET');
    assert.equal(asked.headers['x-chiplog-passages'], '2');
    const put = service.requests.find((r) => r.method === 'PUT');
    assert.equal(put.headers['x-chiplog-passages'], undefined);
  });

  it('sends nothing more when the service already holds everything', async () => {
    insertEntry(db);
    const cloud = sync();
    await cloud.resolveNext();
    service.requests.length = 0;

    const result = await cloud.resolveNext();

    assert.equal(result.outcome, 'idle');
    assert.deepEqual(
      service.requests.map((r) => r.method),
      ['GET']
    );
  });

  it('works out the same hashes after a restart, so nothing is sent again', async () => {
    insertEntry(db);
    await sync().resolveNext();
    service.requests.length = 0;

    const result = await sync().resolveNext();

    assert.equal(result.outcome, 'idle');
    assert.deepEqual(
      service.requests.map((r) => r.method),
      ['GET']
    );
  });

  it('sends a changed passage again, and only the track chunks that changed', async () => {
    const id = insertEntry(db);
    for (let n = 0; n < TRACK_CHUNK_POINTS + 1; n += 1) {
      insert(db, 'track_points', { entry_id: id, ...point(n) });
    }
    const cloud = sync();
    await cloud.resolveNext();
    insert(db, 'track_points', { entry_id: id, ...point(TRACK_CHUNK_POINTS + 1) });
    service.requests.length = 0;

    await cloud.resolveNext();

    assert.deepEqual(
      service.requests
        .filter((r) => r.method === 'PUT')
        .map((r) => r.route.split('/').slice(4).join('/')),
      [`passages/${id}`, `passages/${id}/track/1`]
    );
  });

  it('removes from the service a passage deleted on board', async () => {
    const kept = insertEntry(db, { start_time: at(-48), end_time: at(-44) });
    const removed = insertEntry(db);
    const cloud = sync();
    await cloud.resolveNext();
    db.prepare('DELETE FROM log_entries WHERE id = ?').run(removed);

    await cloud.resolveNext();

    assert.deepEqual([...service.passages.keys()], [kept]);
  });

  it('sends the newest passage first', async () => {
    const older = insertEntry(db, { start_time: at(-48), end_time: at(-44) });
    const newer = insertEntry(db);

    await sync().resolveNext();

    const order = service.requests
      .filter((r) => r.method === 'PUT')
      .map((r) => Number(r.route.split('/').pop()));
    assert.deepEqual(order, [newer, older]);
  });

  it('does nothing while turned off or not configured', async () => {
    insertEntry(db);

    for (const settings of [
      { cloudSyncEnabled: false },
      { cloudSyncUrl: null },
      { cloudSyncToken: null }
    ]) {
      assert.equal((await sync(settings).resolveNext()).outcome, 'disabled');
    }
    assert.equal(service.requests.length, 0);
    assert.equal(sync({ cloudSyncToken: null }).status().problem, 'no device token');
  });

  it('retries later, ever more slowly, while the service is out of reach', async () => {
    insertEntry(db);
    service.control.down = true;
    const cloud = sync();

    const first = await cloud.resolveNext();
    const second = await cloud.resolveNext();

    assert.equal(first.outcome, 'failed');
    assert.equal(first.retryInMs, 60 * 1000);
    assert.equal(second.retryInMs, 2 * 60 * 1000);
    assert.equal(cloud.status().lastError.message, 'fetch failed');
  });

  it('waits an hour after the service refuses the token, and says so in the log', async () => {
    insertEntry(db);
    service.control.status = 401;
    const cloud = sync();

    const result = await cloud.resolveNext();

    assert.equal(result.outcome, 'refused');
    assert.equal(result.retryInMs, 60 * 60 * 1000);
    assert.equal(cloud.status().lastError.code, 'unauthorized');
    assert.equal(logs.at(-1).level, 'error');
  });

  it('reports what it did last', async () => {
    insertEntry(db);
    const cloud = sync();

    await cloud.resolveNext();

    assert.deepEqual(cloud.status(), {
      enabled: true,
      configured: true,
      problem: null,
      url: 'https://service.test/',
      costlyLink: false,
      logbookId: getLogbookId(db),
      inProgress: null,
      lastSuccess: {
        at: at(6),
        sent: 1,
        light: 0,
        waiting: 0,
        deleted: 0,
        held: 1,
        places: false
      },
      lastError: null
    });
  });
});

describe('online backup of places', () => {
  let dataDir;
  let db;
  let service;

  const sync = () =>
    createCloudSync({
      db,
      settings: SETTINGS,
      userAgent: 'signalk-chiplog/2.9.0',
      log: () => {},
      fetch: service.fetch
    });
  const addPlace = (name, countryCode = null) =>
    insert(db, 'places', {
      name,
      lat: 46.16,
      lon: -1.15,
      source: 'geocoding',
      country_code: countryCode,
      created_at: T0,
      updated_at: T0
    });
  const methods = () => service.requests.map((r) => `${r.method} ${r.route.split('/').pop()}`);

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chiplog-cloud-places-'));
    ({ db } = openDatabase(dataDir));
    service = fakeService();
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('sends the places with their position and country, once', async () => {
    const id = addPlace('La Rochelle', 'FR');
    const cloud = sync();

    const result = await cloud.resolveNext();

    assert.equal(result.outcome, 'sent');
    assert.deepEqual(service.places.list, [
      {
        id,
        name: 'La Rochelle',
        position: { lat: 46.16, lon: -1.15 },
        source: 'geocoding',
        countryCode: 'FR',
        createdAt: T0,
        updatedAt: T0
      }
    ]);
    assert.equal(cloud.status().lastSuccess.places, true);

    service.requests.length = 0;
    assert.equal((await cloud.resolveNext()).outcome, 'idle');
    assert.deepEqual(methods(), ['GET sync-state']);
  });

  it('sends the list again when a place is renamed, gets its country or goes', async () => {
    const id = addPlace('46°09.6′N 001°09.0′W');
    const cloud = sync();
    await cloud.resolveNext();

    db.prepare('UPDATE places SET name = ?, country_code = ? WHERE id = ?').run(
      'La Rochelle',
      'FR',
      id
    );
    await cloud.resolveNext();
    assert.equal(service.places.list[0].name, 'La Rochelle');
    assert.equal(service.places.list[0].countryCode, 'FR');

    db.prepare('DELETE FROM places WHERE id = ?').run(id);
    await cloud.resolveNext();
    assert.deepEqual(service.places.list, []);
  });

  it('does not send an empty list to a service that holds none', async () => {
    await sync().resolveNext();

    assert.deepEqual(methods(), ['GET sync-state']);
  });

  it('sends no places to a service that does not know of them', async () => {
    addPlace('La Rochelle', 'FR');
    service.places.knowsPlaces = false;

    const result = await sync().resolveNext();

    assert.equal(result.outcome, 'idle');
    assert.deepEqual(methods(), ['GET sync-state']);
  });
});

describe('GET and POST /cloud-sync', () => {
  let ctx;

  afterEach(() => ctx?.close());

  it('reports the backup, and refuses to start one before it is set up', async () => {
    ctx = await startServer();

    const { status, body } = await ctx.request('GET', '/cloud-sync');
    assert.equal(status, 200);
    assert.equal(body.enabled, false);
    assert.equal(body.problem, 'no service address');
    assert.match(body.logbookId, /^[0-9a-f-]{36}$/);

    const refused = await ctx.request('POST', '/cloud-sync');
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error.code, 'cloud_sync_not_configured');
  });
});

describe('online backup over a costly link', () => {
  let dataDir;
  let db;
  let service;

  const sync = (settings = {}) =>
    createCloudSync({
      db,
      settings: { ...SETTINGS, cloudSyncCostlyLink: true, ...settings },
      userAgent: 'signalk-chiplog/2.9.0',
      log: () => {},
      fetch: service.fetch,
      clock: () => Date.parse(at(6))
    });

  // A passage of four hours with a point every ten seconds, and all that weighs on a link.
  function heavyPassage() {
    const id = insertEntry(db, { distance: 40000 });
    for (let n = 0; n <= 1440; n += 1) {
      insert(db, 'track_points', {
        entry_id: id,
        time: new Date(Date.parse(T0) + n * 10000).toISOString(),
        lat: 46 + n / 10000,
        lon: -1.2,
        sog: 3.2,
        tws: 8,
        heading: 0.1
      });
    }
    for (let n = 0; n < 24; n += 1) {
      insert(db, 'observations', {
        entry_id: id,
        time: at(n / 6),
        reason: 'periodic',
        pressure: 101300
      });
    }
    insert(db, 'events', {
      entry_id: id,
      time: at(1),
      type: 'text_annotation',
      comment: 'Reefed',
      source: 'manual',
      created_at: at(1)
    });
    insert(db, 'events', {
      entry_id: id,
      time: at(2),
      type: 'handwritten_annotation',
      payload: JSON.stringify({ strokes: Array.from({ length: 500 }, (_, i) => [i, i * 2]) }),
      source: 'manual',
      created_at: at(2)
    });
    insert(db, 'weather_forecasts', {
      entry_id: id,
      lat: 46,
      lon: -1.2,
      fetched_at: T0,
      points: JSON.stringify(Array.from({ length: 48 }, (_, i) => ({ time: at(i), windSpeed: 6 })))
    });
    insert(db, 'log_entry_crew', { entry_id: id, name: 'Cédric', created_at: T0 });
    return id;
  }

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chiplog-costly-'));
    ({ db } = openDatabase(dataDir));
    service = fakeService();
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('thins a track to a point every ten minutes of the clock, and its last', () => {
    const points = Array.from({ length: 1441 }, (_, n) => ({
      time: new Date(Date.parse(T0) + n * 10000).toISOString(),
      lat: 46 + n / 10000,
      lon: -1.2,
      sog: 3.2,
      tws: 8
    }));

    const light = lightTrack(points);

    assert.equal(light.length, 25, 'four hours: twenty-four ten-minute marks, and the arrival');
    assert.deepEqual(light[0], { time: T0, lat: 46, lon: -1.2, sog: 3.2 });
    assert.equal(light.at(-1).time, points.at(-1).time);
    // A track that grew keeps the points it had: only the end changes.
    const grown = lightTrack(points.slice(0, 1000));
    assert.deepEqual(light.slice(0, grown.length - 1), grown.slice(0, -1));
    assert.deepEqual(lightTrack([]), []);
  });

  it('sends a summary and a thinned-out track, in a few kilobytes', async () => {
    const id = heavyPassage();
    const cloud = sync();

    const outcome = await cloud.resolveNext();

    assert.equal(outcome.outcome, 'sent');
    const held = service.passages.get(id);
    assert.equal(held.light, true);
    assert.deepEqual(held.content.observations, []);
    assert.equal(held.content.weather, null);
    assert.equal(held.content.events.length, 2);
    assert.equal(held.content.events[0].comment, 'Reefed', 'what was written is in the summary');
    assert.equal(held.content.events[1].payload, null, 'the strokes of a drawing are not');
    assert.deepEqual(
      held.content.crew.map((member) => member.name),
      ['Cédric']
    );
    assert.equal(held.content.entry.distance, 40000);
    assert.equal([...held.points.values()].flat().length, 25);
    assert.deepEqual(cloud.status().lastSuccess, {
      at: at(6),
      sent: 1,
      light: 1,
      waiting: 1,
      deleted: 0,
      held: 1,
      places: false
    });

    const sent = service.requests
      .filter((request) => request.method === 'PUT')
      .reduce((sum, request) => sum + request.bytes, 0);
    assert.ok(sent < 4000, `${sent} bytes went out`);
  });

  it('has nothing to send again while the passage does not change', async () => {
    heavyPassage();
    const cloud = sync();
    await cloud.resolveNext();
    const before = service.requests.length;

    const outcome = await cloud.resolveNext();

    assert.equal(outcome.outcome, 'idle');
    assert.deepEqual(
      service.requests.slice(before).map((request) => request.method),
      ['GET']
    );
    assert.equal(cloud.status().lastSuccess.waiting, 1, 'its full copy still waits');
  });

  it('runs every six hours rather than every few minutes', async () => {
    insertEntry(db);

    assert.equal((await sync().resolveNext()).retryInMs, COSTLY_INTERVAL_MS);
    assert.equal(
      (await sync({ cloudSyncIntervalMinutes: 24 * 60 }).resolveNext()).retryInMs,
      24 * 60 * 60 * 1000,
      'a longer interval asked for is kept'
    );
    assert.equal(
      (await sync({ cloudSyncCostlyLink: false }).resolveNext()).retryInMs,
      15 * 60 * 1000
    );
  });

  it('only sends the end of the track again as a passage goes on', async () => {
    const id = insertEntry(db, { state: 'active' });
    const addPoints = (from, to) => {
      for (let n = from; n < to; n += 1) {
        insert(db, 'track_points', {
          entry_id: id,
          time: new Date(Date.parse(T0) + n * 600000).toISOString(),
          lat: 46 + n / 1000,
          lon: -1.2
        });
      }
    };
    // Forty hours under way: 240 light points, three chunks.
    addPoints(0, 240);
    const cloud = sync();
    await cloud.resolveNext();
    assert.equal(service.passages.get(id).chunkHashes.length, Math.ceil(240 / LIGHT_CHUNK_POINTS));
    const before = service.requests.length;

    addPoints(240, 250);
    db.prepare('UPDATE log_entries SET updated_at = ? WHERE id = ?').run(at(42), id);
    await cloud.resolveNext();

    const chunksSent = service.requests
      .slice(before)
      .filter((request) => /\/track\/\d+$/.test(request.route))
      .map((request) => request.route.split('/').pop());
    assert.deepEqual(chunksSent, ['2'], 'the first two hundred points stay where they are');
  });

  it('leaves alone a full copy the service holds, even out of date', async () => {
    const id = heavyPassage();
    await sync({ cloudSyncCostlyLink: false }).resolveNext();
    assert.equal(service.passages.get(id).light, false);
    const fullHash = service.passages.get(id).contentHash;
    db.prepare('UPDATE log_entries SET end_place_name = ?, updated_at = ? WHERE id = ?').run(
      'Port-Joinville',
      at(5),
      id
    );
    const cloud = sync();
    const before = service.requests.length;

    const outcome = await cloud.resolveNext();

    assert.equal(outcome.outcome, 'idle');
    assert.deepEqual(
      service.requests.slice(before).map((request) => request.method),
      ['GET'],
      'no light copy is sent over it'
    );
    assert.equal(service.passages.get(id).contentHash, fullHash);
    assert.equal(cloud.status().lastSuccess.waiting, 1);
  });

  it('sends everything in full once the link is cheap again', async () => {
    const id = heavyPassage();
    const settings = { ...SETTINGS, cloudSyncCostlyLink: true };
    const cloud = createCloudSync({
      db,
      settings,
      userAgent: 'signalk-chiplog/2.9.0',
      log: () => {},
      fetch: service.fetch
    });
    await cloud.resolveNext();
    assert.equal(service.passages.get(id).light, true);

    settings.cloudSyncCostlyLink = false;
    await cloud.resolveNext();

    const held = service.passages.get(id);
    assert.equal(held.light, false);
    assert.equal(held.content.observations.length, 24);
    assert.equal([...held.points.values()].flat().length, 1441);
    assert.equal(cloud.status().lastSuccess.waiting, 0);
    assert.equal(cloud.status().lastSuccess.light, 0);
  });

  it('sends everything in full when asked by hand, then goes back to light', async () => {
    const id = heavyPassage();
    const cloud = sync();
    await cloud.resolveNext();

    cloud.requestFull();
    await cloud.resolveNext();

    assert.equal(service.passages.get(id).light, false);
    assert.equal([...service.passages.get(id).points.values()].flat().length, 1441);

    // The next passage, with nobody asking, goes light again.
    const next = insertEntry(db, { start_time: at(24), end_time: at(28) });
    await cloud.resolveNext();
    assert.equal(service.passages.get(next).light, true);
  });

  it('holds the places back, and still reports deletions', async () => {
    insert(db, 'places', {
      name: 'La Rochelle',
      lat: 46.15,
      lon: -1.15,
      source: 'manual',
      created_at: T0,
      updated_at: T0
    });
    const id = insertEntry(db);
    const cloud = sync();
    await cloud.resolveNext();
    assert.equal(service.places.hash, null, 'the list of places waits');

    db.prepare('DELETE FROM log_entries WHERE id = ?').run(id);
    await cloud.resolveNext();

    assert.equal(service.passages.has(id), false);
    assert.equal(cloud.status().lastSuccess.deleted, 1);
  });
});

describe('costly link API', () => {
  let server;

  beforeEach(async () => {
    server = await startServer();
  });

  afterEach(() => server.close());

  it('declares the link costly, and cheap again, in the plugin configuration', async () => {
    assert.equal((await server.request('GET', '/cloud-sync')).body.costlyLink, false);

    const costly = await server.request('POST', '/cloud-sync/costly-link', { costly: true });

    assert.equal(costly.status, 200);
    assert.equal(costly.body.costlyLink, true);
    assert.equal(server.savedOptions.at(-1).cloudSyncCostlyLink, true);
    assert.equal(server.savedOptions.at(-1).geocodingEnabled, false, 'the other settings are kept');

    const cheap = await server.request('POST', '/cloud-sync/costly-link', { costly: false });
    assert.equal(cheap.body.costlyLink, false);
    assert.equal(server.savedOptions.at(-1).cloudSyncCostlyLink, false);
  });

  it('refuses anything but true or false', async () => {
    const response = await server.request('POST', '/cloud-sync/costly-link', { costly: 'yes' });

    assert.equal(response.status, 400);
  });
});

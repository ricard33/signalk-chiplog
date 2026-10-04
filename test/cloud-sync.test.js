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
  TRACK_CHUNK_POINTS,
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
  const requests = [];
  const control = { down: false, status: null };

  const reply = (status, body) =>
    new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' }
    });

  async function fetch(url, { method, headers, body }) {
    const route = new URL(url).pathname;
    requests.push({ method, route, headers });
    if (control.down) {
      throw new TypeError('fetch failed');
    }
    if (control.status) {
      return reply(control.status, { error: 'unauthorized', message: 'Unknown token' });
    }
    const payload = body ? JSON.parse(zlib.gunzipSync(body)) : undefined;
    const match =
      /^\/v1\/logbooks\/([^/]+)(?:\/passages\/(\d+)(?:\/track\/(\d+))?|\/sync-state)$/.exec(route);
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
          complete: p.chunkHashes.every((hash, i) => p.chunks.get(i) === hash)
        }))
      });
    }
    if (method === 'DELETE') {
      passages.delete(originId);
      return reply(204);
    }
    if (index === undefined) {
      const previous = passages.get(originId);
      const chunks = new Map();
      payload.track.chunkHashes.forEach((hash, i) => {
        if (previous?.chunks.get(i) === hash) {
          chunks.set(i, hash);
        }
      });
      passages.set(originId, {
        contentHash: payload.contentHash,
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

  return { fetch, passages, requests, control };
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
      logbookId: getLogbookId(db),
      inProgress: null,
      lastSuccess: { at: at(6), sent: 1, deleted: 0, held: 1 },
      lastError: null
    });
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

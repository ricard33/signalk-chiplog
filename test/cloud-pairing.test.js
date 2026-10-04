const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, it, beforeEach, afterEach, mock } = require('node:test');
const { openDatabase } = require('../lib/database');
const { createCloudPairing } = require('../lib/cloud-pairing');
const { getLogbookId } = require('../lib/cloud-sync');
const { startServer } = require('./helpers');

const reply = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// The service's side of pairing: a code handed out, then answers to the plugin's polls,
// pending until the test claims it.
function fakeService() {
  const control = { claimed: false, expired: false, down: false, delivered: false };
  const requests = [];

  async function fetch(url, { body }) {
    const route = new URL(url).pathname;
    const payload = JSON.parse(body);
    requests.push({ url, route, payload });
    if (control.down) {
      throw new TypeError('fetch failed');
    }
    if (route === '/v1/pairings') {
      return reply(201, {
        pairingId: '11111111-2222-4333-8444-555555555555',
        code: 'K7QF-3MXB',
        pollSecret: 'secret',
        expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
        pollIntervalSeconds: 5,
        claimUrl: 'https://service.test/pair?code=K7QF-3MXB'
      });
    }
    assert.equal(payload.pollSecret, 'secret');
    if (control.expired) {
      return reply(410, { error: 'pairing_expired', message: 'This pairing code has expired' });
    }
    if (!control.claimed) {
      return reply(200, { status: 'pending' });
    }
    if (control.delivered) {
      return reply(409, { error: 'pairing_already_used', message: 'Already used' });
    }
    control.delivered = true;
    return reply(200, { status: 'paired', token: 'ma_new', vesselId: 'v', vesselName: 'Ti Rev' });
  }

  return { fetch, control, requests };
}

describe('pairing with the online service', () => {
  let dataDir;
  let db;
  let service;
  let saved;

  function pairing(onPaired = async (pair) => saved.push(pair)) {
    return createCloudPairing({
      db,
      userAgent: 'signalk-chiplog/2.9.0',
      onPaired,
      log: () => {},
      fetch: service.fetch
    });
  }

  // Lets the poll timer fire and the poll it starts settle.
  async function tick(ms = 5000) {
    mock.timers.tick(ms);
    for (let i = 0; i < 5; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chiplog-pairing-'));
    ({ db } = openDatabase(dataDir));
    service = fakeService();
    saved = [];
    mock.timers.enable({ apis: ['setTimeout'] });
  });

  afterEach(() => {
    mock.timers.reset();
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('shows a code, and saves the token once someone claims it', async () => {
    const cloud = pairing();

    const started = await cloud.start('https://service.test/');

    assert.equal(started.state, 'waiting');
    assert.equal(started.code, 'K7QF-3MXB');
    assert.equal(started.claimUrl, 'https://service.test/pair?code=K7QF-3MXB');
    assert.equal(started.pollSecret, undefined, 'the secret stays in the plugin');
    assert.equal(service.requests[0].url, 'https://service.test/v1/pairings');
    assert.deepEqual(service.requests[0].payload, { logbookId: getLogbookId(db) });

    await tick();
    assert.equal(cloud.status().state, 'waiting');
    assert.deepEqual(saved, []);

    service.control.claimed = true;
    await tick();

    assert.deepEqual(saved, [{ url: 'https://service.test', token: 'ma_new' }]);
    assert.equal(cloud.status().state, 'paired');
    assert.equal(cloud.status().vesselName, 'Ti Rev');
    await tick();
    assert.equal(service.requests.length, 3, 'no polling once paired');
  });

  it('keeps waiting through a dropped connection', async () => {
    const cloud = pairing();
    await cloud.start('https://service.test');
    service.control.down = true;

    await tick();
    assert.equal(cloud.status().state, 'waiting');

    service.control.down = false;
    service.control.claimed = true;
    await tick(10000);
    assert.equal(cloud.status().state, 'paired');
  });

  it('reports a code that expired unclaimed', async () => {
    const cloud = pairing();
    await cloud.start('https://service.test');
    service.control.expired = true;

    await tick();

    assert.equal(cloud.status().state, 'expired');
  });

  it('stops waiting when cancelled', async () => {
    const cloud = pairing();
    await cloud.start('https://service.test');

    cloud.cancel();
    await tick();

    assert.equal(cloud.status().state, 'idle');
    assert.equal(service.requests.length, 1);
  });

  it('refuses an address that is not a web address', async () => {
    await assert.rejects(pairing().start('service.test'), { code: 'invalid_url' });
    await assert.rejects(pairing().start('ftp://service.test'), { code: 'invalid_url' });
  });

  it('reports a token it could not save', async () => {
    const cloud = pairing(async () => {
      throw new Error('disk full');
    });
    await cloud.start('https://service.test');
    service.control.claimed = true;

    await tick();

    assert.deepEqual(cloud.status(), {
      state: 'failed',
      error: { message: 'disk full', code: 'save_failed' }
    });
  });
});

describe('POST and DELETE /cloud-sync/pairing', () => {
  let ctx;
  const realFetch = globalThis.fetch;

  afterEach(async () => {
    globalThis.fetch = realFetch;
    await ctx?.close();
  });

  it('starts a pairing, and saves the token into the plugin configuration', async () => {
    const service = fakeService();
    // Only the service's address goes to the fake; the test's own requests go through.
    globalThis.fetch = (url, options) =>
      String(url).startsWith('https://service.test')
        ? service.fetch(url, options)
        : realFetch(url, options);
    ctx = await startServer({ config: { stopClosureMinutes: 20 } });

    const started = await ctx.request('POST', '/cloud-sync/pairing', {
      url: 'https://service.test'
    });
    assert.equal(started.status, 200);
    assert.equal(started.body.code, 'K7QF-3MXB');

    service.control.claimed = true;
    for (let i = 0; i < 100 && ctx.savedOptions.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    assert.deepEqual(ctx.savedOptions.at(-1), {
      geocodingEnabled: false,
      landmarksEnabled: false,
      tidesEnabled: false,
      weatherEnabled: false,
      summaryMailEnabled: false,
      stopClosureMinutes: 20,
      cloudSyncEnabled: true,
      cloudSyncUrl: 'https://service.test',
      cloudSyncToken: 'ma_new'
    });
    const { body } = await ctx.request('GET', '/cloud-sync');
    assert.equal(body.configured, true);
    assert.equal(body.enabled, true);
    assert.equal(body.pairing.state, 'paired');
  });

  it('refuses a missing or malformed address, and cancels on request', async () => {
    ctx = await startServer();

    assert.equal((await ctx.request('POST', '/cloud-sync/pairing', {})).status, 400);
    assert.equal(
      (await ctx.request('POST', '/cloud-sync/pairing', { url: 'not a url' })).status,
      400
    );
    const cancelled = await ctx.request('DELETE', '/cloud-sync/pairing');
    assert.equal(cancelled.status, 200);
    assert.deepEqual(cancelled.body, { state: 'idle' });
  });
});

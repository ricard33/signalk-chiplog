const assert = require('node:assert/strict');
const { describe, it, afterEach } = require('node:test');
const { startServer, insertEntry } = require('./helpers');

describe('plugin', () => {
  let ctx;

  afterEach(() => ctx?.close());

  describe('GET /state', () => {
    it('opens a passage from a fresh navigation.state as soon as the plugin starts', async () => {
      ctx = await startServer({
        self: {
          navigation: { state: { value: 'sailing', timestamp: new Date().toISOString() } }
        }
      });

      const { status, body } = await ctx.request('GET', '/state');

      assert.equal(status, 200);
      assert.equal(body.detection, 'autostate');
      assert.equal(body.motion, 'underway');
      assert.equal(body.propulsion, 'sail');
      assert.equal(body.schemaVersion, 18);
      const entry = await ctx.request('GET', `/entries/${body.activeEntryId}`);
      assert.equal(entry.body.state, 'active');
    });

    it('ignores a navigation.state left over from long ago', async () => {
      ctx = await startServer({
        self: { navigation: { state: { value: 'sailing', timestamp: '2026-01-01T00:00:00.000Z' } } }
      });

      const { body } = await ctx.request('GET', '/state');

      assert.deepEqual(body, {
        activeEntryId: null,
        detection: 'fallback',
        motion: 'unknown',
        propulsion: null,
        stateIssue: {
          reason: 'stale',
          source: null,
          value: 'sailing',
          updatedAt: '2026-01-01T00:00:00.000Z'
        },
        schemaVersion: 18
      });
    });

    it('reports the active entry', async () => {
      ctx = await startServer();
      const id = insertEntry(ctx.db, { state: 'active', last_moving_at: new Date().toISOString() });
      const { body } = await ctx.request('GET', '/state');
      assert.equal(body.activeEntryId, id);
    });
  });

  it('fetches the forecasts as soon as a passage opens', async (t) => {
    const asked = [];
    const realFetch = globalThis.fetch;
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      const { hostname, pathname } = new URL(url);
      if (hostname !== 'forecast.invalid') {
        return realFetch(url, options);
      }
      asked.push(pathname);
      return { ok: false, status: 400, json: async () => ({}) };
    });
    ctx = await startServer({
      config: {
        tidesEnabled: true,
        weatherEnabled: true,
        tideUrl: 'http://forecast.invalid/v1/marine',
        weatherUrl: 'http://forecast.invalid/v1/forecast'
      },
      self: {
        navigation: {
          state: { value: 'sailing', timestamp: new Date().toISOString() },
          position: {
            value: { latitude: 46.1466, longitude: -1.1686 },
            timestamp: new Date().toISOString()
          }
        }
      }
    });

    // Well before the chains' own first run, 5 s after start.
    await new Promise((resolve) => setTimeout(resolve, 200));

    assert.deepEqual(asked.sort(), ['/v1/forecast', '/v1/marine', '/v1/marine']);
    const { body } = await ctx.request('GET', '/state');
    const tide = await ctx.request('GET', `/entries/${body.activeEntryId}/tide`);
    assert.equal(tide.body.error.code, 'tide_not_found');
  });

  it('answers 503 while the plugin is stopped', async () => {
    ctx = await startServer();
    ctx.plugin.stop();

    const { status, body } = await ctx.request('GET', '/entries');

    assert.equal(status, 503);
    assert.equal(body.error.code, 'plugin_not_started');
    ctx.plugin.start({}, () => {});
  });

  it('opens reads to readonly users, crew writes to readwrite, and keeps the rest admin-only', async () => {
    ctx = await startServer();

    const level = (method, path) =>
      ctx.permissions.find((p) => p.method === method && p.path === path)?.level ?? 'admin';

    assert.equal(level('GET', '/api/entries'), 'readonly');
    assert.equal(level('GET', '/api/export'), 'readonly');
    assert.equal(level('POST', '/api/entries/:id/events'), 'readwrite');
    assert.equal(level('PATCH', '/api/places/:id'), 'readwrite');
    assert.equal(level('PATCH', '/api/propulsion/:id'), 'readwrite');
    assert.equal(level('DELETE', '/api/entries/:id'), 'admin');
    assert.equal(level('DELETE', '/api/places/:id'), 'admin');
    assert.equal(level('POST', '/api/manoeuvre-types'), 'admin');
    assert.equal(level('POST', '/api/export/usb'), 'admin');
    assert.equal(level('GET', '/api/crew'), 'readonly');
    assert.equal(level('POST', '/api/crew'), 'readwrite');
    assert.equal(level('PATCH', '/api/crew/:id'), 'readwrite');
    // Unlike places/manoeuvre-types, removing a roster member is readwrite
    // too -- the crew must be able to correct it without an admin login.
    assert.equal(level('DELETE', '/api/crew/:id'), 'readwrite');
    assert.equal(level('PUT', '/api/entries/:id/crew'), 'readwrite');
  });

  it('logs unexpected failures and hides their detail from the client', async () => {
    ctx = await startServer();
    ctx.db.exec('DROP TABLE observations');
    const id = insertEntry(ctx.db);

    const { status, body } = await ctx.request('GET', `/entries/${id}`);

    assert.equal(status, 500);
    assert.equal(body.error.code, 'internal_error');
    assert.equal(ctx.errors.length, 1);
    assert.match(ctx.errors[0], /no such table/);
  });
});

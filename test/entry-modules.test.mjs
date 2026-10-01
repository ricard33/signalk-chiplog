import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, it } from 'node:test';
import { createTokenStore } from '../public/js/auth.mjs';
import { randomId } from '../public/js/ids.mjs';
import { createAccessRequester } from '../public/entry/js/access.mjs';
import { createServerClock } from '../public/entry/js/clock.mjs';
import { createJournal } from '../public/entry/js/journal.mjs';
import { createOutbox, isTransient } from '../public/entry/js/outbox.mjs';
import { createStrokeRecorder, strokeWidth } from '../public/entry/js/strokes.mjs';

function storage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key)
  };
}

const failure = (status, code = 'x') => Object.assign(new Error(code), { status, code });
const item = (ref, body = {}) => ({ ref, method: 'POST', path: '/events', body, createdAt: 0 });

describe('entry outbox', () => {
  it('replays entries in order and forgets them once delivered', async () => {
    const delivered = [];
    const outbox = createOutbox({ send: async (entry) => delivered.push(entry.ref) });
    outbox.add(item('a'));
    outbox.add(item('b'));

    const { sent, blocked } = await outbox.flush();

    assert.deepEqual(delivered, ['a', 'b']);
    assert.equal(sent.length, 2);
    assert.equal(blocked, null);
    assert.equal(outbox.size, 0);
  });

  it('stops at the first transient failure and keeps the rest in order', async () => {
    let online = false;
    const delivered = [];
    const outbox = createOutbox({
      send: async (entry) => {
        if (!online) {
          throw failure(0, 'network');
        }
        delivered.push(entry.ref);
      }
    });
    outbox.add(item('a'));
    outbox.add(item('b'));

    const first = await outbox.flush();
    assert.equal(first.blocked.code, 'network');
    assert.deepEqual(
      outbox.snapshot().pending.map((entry) => entry.ref),
      ['a', 'b']
    );

    online = true;
    await outbox.flush();
    assert.deepEqual(delivered, ['a', 'b']);
  });

  it('sets refused entries aside with the reason and carries on', async () => {
    const outbox = createOutbox({
      send: async (entry) => {
        if (entry.ref === 'a') {
          throw failure(409, 'no_passage');
        }
      }
    });
    outbox.add(item('a'));
    outbox.add(item('b'));

    await outbox.flush();

    const { pending, failed } = outbox.snapshot();
    assert.equal(pending.length, 0);
    assert.equal(failed.length, 1);
    assert.equal(failed[0].error.code, 'no_passage');
    assert.equal(outbox.remove('a'), true);
    assert.equal(outbox.snapshot().failed.length, 0);
  });

  it('survives a reload through its storage', () => {
    const shared = storage();
    const first = createOutbox({ storage: shared, send: async () => {} });
    first.add(item('a', { type: 'manoeuvre' }));
    first.update('a', { comment: 'second reef' });

    const reloaded = createOutbox({ storage: shared, send: async () => {} });
    assert.deepEqual(reloaded.snapshot().pending[0].body, {
      type: 'manoeuvre',
      comment: 'second reef'
    });
    assert.equal(reloaded.update('missing', {}), false);
  });

  it('starts empty from unreadable storage', () => {
    const outbox = createOutbox({ storage: storage({ 'chiplog.outbox': '{nope' }), send: null });
    assert.equal(outbox.size, 0);
  });

  it('runs one replay at a time', async () => {
    let calls = 0;
    let release;
    const outbox = createOutbox({
      send: () => {
        calls += 1;
        return new Promise((resolve) => {
          release = resolve;
        });
      }
    });
    outbox.add(item('a'));
    const one = outbox.flush();
    const two = outbox.flush();
    assert.equal(one, two);
    release();
    await one;
    assert.equal(calls, 1);
  });

  it('tells transient failures from refusals', () => {
    for (const status of [0, 401, 403, 408, 429, 500, 503]) {
      assert.equal(isTransient(failure(status)), true, String(status));
    }
    for (const status of [400, 404, 409]) {
      assert.equal(isTransient(failure(status)), false, String(status));
    }
  });
});

describe('server clock', () => {
  it('corrects the tablet clock by the offset seen in the Date header', () => {
    const clock = createServerClock({ now: () => 1_000_000 });
    const server = new Date(1_000_000 + 3 * 60 * 1000);
    clock.observe(server.toUTCString(), 999_900, 1_000_100);
    assert.ok(Math.abs(clock.now() - server.getTime()) <= 1000);
  });

  it('ignores offsets within the header resolution and unreadable dates', () => {
    const clock = createServerClock({ now: () => 5_000_000 });
    clock.observe(new Date(5_001_000).toUTCString(), 5_000_000, 5_000_000);
    assert.equal(clock.now(), 5_000_000);
    clock.observe('not a date', 0, 0);
    assert.equal(clock.offset(), 0);
  });
});

describe('stroke recorder', () => {
  it('records points relative to the first one, with pen pressure', () => {
    const recorder = createStrokeRecorder();
    recorder.begin(10.04, 20, 1000, 0.333);
    recorder.extend(10.04, 20, 1005, 0.5);
    recorder.extend(38.8000001, 25.06, 1016, 2);
    recorder.end();
    recorder.begin(30, 30, 1500);
    recorder.end();

    assert.deepEqual(recorder.payload({ width: 600.4, height: 300 }), {
      strokes: [
        {
          points: [
            { x: 10, y: 20, t: 0, pressure: 0.33 },
            { x: 38.8, y: 25.1, t: 16, pressure: 1 }
          ]
        },
        { points: [{ x: 30, y: 30, t: 500 }] }
      ],
      width: 600,
      height: 300
    });
  });

  it('undoes the last stroke and restarts time once empty', () => {
    const recorder = createStrokeRecorder();
    recorder.begin(0, 0, 100);
    recorder.undo();
    assert.equal(recorder.isEmpty(), true);
    recorder.begin(0, 0, 900);
    assert.equal(recorder.strokes[0].points[0].t, 0);
    assert.equal(recorder.extend(1, 1, 950) !== null, true);
    recorder.clear();
    assert.equal(recorder.extend(1, 1, 950), null);
  });

  it('thickens firm strokes only', () => {
    assert.equal(strokeWidth(2, undefined), 2);
    assert.equal(strokeWidth(2, 0), 1);
    assert.equal(strokeWidth(2, 1), 4);
  });

  it('carries the tool style on the stroke it was drawn with', () => {
    const recorder = createStrokeRecorder();
    recorder.begin(0, 0, 1000, undefined, { color: '#1d4ed8', tool: 'pen', width: 4 });
    recorder.end();
    recorder.begin(10, 10, 1100, undefined, { color: '#facc15', tool: 'highlighter', width: 14 });
    recorder.end();

    assert.deepEqual(recorder.payload({ width: 100, height: 100 }).strokes, [
      { points: [{ x: 0, y: 0, t: 0 }], color: '#1d4ed8', tool: 'pen', width: 4 },
      { points: [{ x: 10, y: 10, t: 100 }], color: '#facc15', tool: 'highlighter', width: 14 }
    ]);
  });

  it('erases only the points within radius, splitting a stroke in two', () => {
    const recorder = createStrokeRecorder();
    recorder.begin(0, 0, 1000);
    for (let x = 1; x <= 10; x += 1) {
      recorder.extend(x, 0, 1000 + x * 10);
    }
    recorder.end();

    const changed = recorder.eraseAt(5, 0, 1.5);
    assert.equal(changed, true);
    assert.deepEqual(
      recorder.strokes.map((stroke) => stroke.points.map((p) => `${p.x},${p.y}`)),
      [
        ['0,0', '1,0', '2,0', '3,0'],
        ['7,0', '8,0', '9,0', '10,0']
      ]
    );
  });

  it('leaves strokes untouched when nothing is within the erase radius', () => {
    const recorder = createStrokeRecorder();
    recorder.begin(0, 0, 1000);
    recorder.extend(10, 0, 1010);
    recorder.end();

    assert.equal(recorder.eraseAt(500, 500, 3), false);
    assert.equal(recorder.strokes.length, 1);
  });

  it('undoes a whole erase gesture, and a finished pen stroke, as one action', () => {
    const recorder = createStrokeRecorder();
    recorder.begin(0, 0, 1000);
    recorder.extend(10, 0, 1010);
    recorder.end();
    recorder.begin(100, 100, 1100);
    recorder.end();

    recorder.beginErase();
    recorder.eraseAt(100, 100, 3);
    assert.equal(recorder.strokes.length, 1);

    recorder.undo();
    assert.equal(recorder.strokes.length, 2);

    recorder.undo();
    assert.equal(recorder.strokes.length, 1);

    recorder.undo();
    assert.equal(recorder.isEmpty(), true);

    recorder.undo();
    assert.equal(recorder.isEmpty(), true);
  });
});

describe('device access request', () => {
  function server(replies) {
    const calls = [];
    const fetch = async (url, options = {}) => {
      calls.push({ url, options });
      const [status, body] = replies.shift();
      return { status, ok: status < 400, json: async () => body };
    };
    return { fetch, calls };
  }

  function requester(fetch, store = storage()) {
    const tokens = createTokenStore(store);
    return {
      store,
      tokens,
      access: createAccessRequester({
        fetch,
        storage: store,
        tokenStore: tokens,
        description: 'Tablet'
      })
    };
  }

  it('asks for readwrite access, waits for approval and keeps the token', async () => {
    const { fetch, calls } = server([
      [202, { state: 'PENDING', href: '/signalk/v1/requests/r1' }],
      [200, { state: 'PENDING' }],
      [200, { state: 'COMPLETED', accessRequest: { permission: 'APPROVED', token: 'jwt' } }]
    ]);
    const { access, tokens } = requester(fetch);

    assert.deepEqual(await access.request(), { state: 'pending' });
    const sent = JSON.parse(calls[0].options.body);
    assert.equal(sent.permissions, 'readwrite');
    assert.equal(sent.description, 'Tablet');
    assert.match(sent.clientId, /^[0-9a-f-]{36}$/);

    assert.deepEqual(await access.poll(), { state: 'pending' });
    assert.equal(calls[1].url, '/signalk/v1/requests/r1');
    assert.deepEqual(await access.poll(), { state: 'approved' });
    assert.equal(tokens.get(), 'jwt');
    assert.equal(access.hasPendingRequest(), false);
  });

  it('keeps the same client id across requests', async () => {
    const { fetch, calls } = server([
      [202, { state: 'PENDING', href: '/r/1' }],
      [202, { state: 'PENDING', href: '/r/2' }]
    ]);
    const { access } = requester(fetch);
    await access.request();
    access.cancel();
    await access.request();
    const ids = calls.map((call) => JSON.parse(call.options.body).clientId);
    assert.equal(ids[0], ids[1]);
  });

  it('reports a denial, a forgotten request and servers that do not take requests', async () => {
    const denied = requester(
      server([
        [202, { state: 'PENDING', href: '/r/1' }],
        [200, { state: 'COMPLETED', accessRequest: { permission: 'DENIED' } }]
      ]).fetch
    ).access;
    await denied.request();
    assert.deepEqual(await denied.poll(), { state: 'denied' });

    const forgotten = requester(
      server([[404, null]]).fetch,
      storage({ 'chiplog.accessRequest': '/r/9' })
    ).access;
    assert.deepEqual(await forgotten.poll(), { state: 'expired' });
    assert.equal(forgotten.hasPendingRequest(), false);

    assert.deepEqual(await requester(server([[404, { message: 'off' }]]).fetch).access.request(), {
      state: 'unavailable'
    });
    assert.deepEqual(
      await requester(
        server([[403, { state: 'COMPLETED', statusCode: 403 }]]).fetch
      ).access.request(),
      { state: 'disabled' }
    );
    assert.deepEqual(await requester(server([]).fetch).access.poll(), { state: 'idle' });
  });
});

describe('random ids', () => {
  it('are version 4 UUIDs', () => {
    const id = randomId();
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.notEqual(randomId(), id);
  });
});

describe('service worker', () => {
  it('precaches only files that exist', () => {
    const directory = path.join(import.meta.dirname, '..', 'public', 'entry');
    const source = fs.readFileSync(path.join(directory, 'sw.js'), 'utf8');
    const shell = vm.runInNewContext(`${source};SHELL`, { self: { addEventListener() {} } });
    assert.ok(shell.length > 5);
    for (const file of shell) {
      const target = path.join(directory, file === './' ? 'index.html' : file);
      assert.ok(fs.existsSync(target), `${file} exists`);
    }
  });
});

describe('entry journal', () => {
  function setup({ online = true, refusal = null } = {}) {
    const calls = [];
    const server = { online, refusal, nextId: 1 };
    const request = async (method, url, body) => {
      calls.push({ method, url, body });
      if (!server.online) {
        throw failure(0, 'network');
      }
      if (server.refusal) {
        throw server.refusal;
      }
      return method === 'POST' ? { id: server.nextId++, ...body } : null;
    };
    let counter = 0;
    const journal = createJournal({
      request,
      storage: storage(),
      clock: { now: () => Date.parse('2026-09-13T10:00:00.000Z') },
      newRef: () => `ref-${(counter += 1)}`
    });
    return { journal, calls, server };
  }

  it('sends an entry at once, with no time so the server dates it and takes a snapshot', async () => {
    const { journal, calls } = setup();

    const outcome = await journal.log({ type: 'manoeuvre', subtype: 'tack' });

    assert.equal(outcome.status, 'sent');
    assert.equal(calls[0].url, '/events');
    assert.equal(calls[0].body.time, undefined);
    assert.equal(calls[0].body.clientRef, outcome.ref);
    assert.equal(journal.eventFor(outcome.ref).id, 1);
  });

  it('queues an entry with the time it was made when the server cannot be reached', async () => {
    const { journal, calls, server } = setup({ online: false });

    const outcome = await journal.log({ type: 'manoeuvre', subtype: 'tack' });
    assert.equal(outcome.status, 'queued');
    assert.equal(journal.isQueued(outcome.ref), true);

    const later = await journal.log({ type: 'text_annotation', comment: 'x' });
    assert.equal(later.status, 'queued', 'waits behind the queue');
    assert.equal(calls.length, 1, 'no attempt out of order');

    server.online = true;
    await journal.flush();
    assert.deepEqual(
      calls.slice(1).map((call) => [call.body.clientRef, call.body.time]),
      [
        [outcome.ref, '2026-09-13T10:00:00.000Z'],
        [later.ref, '2026-09-13T10:00:00.000Z']
      ]
    );
    assert.equal(journal.eventFor(later.ref).id, 2);
  });

  it('passes refusals on without queueing them', async () => {
    const { journal } = setup({ refusal: failure(409, 'no_passage') });
    await assert.rejects(journal.log({ type: 'manoeuvre', subtype: 'tack' }), {
      code: 'no_passage'
    });
    assert.equal(journal.outbox.size, 0);
  });

  it('undoes a logged entry, and a queued one without sending it', async () => {
    const { journal, calls, server } = setup();
    const sent = await journal.log({ type: 'manoeuvre', subtype: 'cast_off' });
    await journal.undo(sent.ref);
    assert.deepEqual(calls.at(-1), { method: 'DELETE', url: '/events/1', body: undefined });

    server.online = false;
    const queued = await journal.log({ type: 'manoeuvre', subtype: 'tack' });
    await journal.undo(queued.ref);
    server.online = true;
    await journal.flush();
    assert.equal(
      calls.filter((call) => call.body?.subtype === 'tack').length,
      1,
      'only the failed try'
    );
  });

  it('deletes an entry undone while its replay was under way', async () => {
    const { journal, calls, server } = setup({ online: false });
    const queued = await journal.log({ type: 'manoeuvre', subtype: 'tack' });
    server.online = true;

    const replay = journal.flush();
    await journal.undo(queued.ref);
    await replay;
    await journal.flush();

    assert.deepEqual(calls.at(-1), { method: 'DELETE', url: '/events/1', body: undefined });
  });

  it('adds a comment to a queued entry or to the logged event', async () => {
    const { journal, calls, server } = setup({ online: false });
    const queued = await journal.log({ type: 'manoeuvre', subtype: 'reef_in' });
    await journal.edit(queued.ref, { comment: 'second reef' });
    assert.equal(journal.outbox.snapshot().pending[0].body.comment, 'second reef');

    server.online = true;
    await journal.flush();
    await journal.edit(queued.ref, { comment: 'third reef' });
    assert.deepEqual(calls.at(-1), {
      method: 'PATCH',
      url: '/events/1',
      body: { comment: 'third reef' }
    });
  });

  it('sends a time the crew supplied themselves, online as well as queued', async () => {
    const { journal, calls } = setup();

    const sent = await journal.log({
      type: 'text_annotation',
      comment: 'dolphins',
      time: '2026-09-13T09:15:00.000Z'
    });
    assert.equal(sent.status, 'sent');
    assert.equal(calls[0].body.time, '2026-09-13T09:15:00.000Z');

    const offline = setup({ online: false });
    await offline.journal.log({
      type: 'text_annotation',
      comment: 'dolphins',
      time: '2026-09-13T09:15:00.000Z'
    });
    assert.equal(
      offline.journal.outbox.snapshot().pending[0].body.time,
      '2026-09-13T09:15:00.000Z',
      'the typed time wins over the moment the entry was made'
    );
  });

  it('corrects the time of a queued entry in place, and of a logged one over PATCH', async () => {
    const { journal, calls, server } = setup({ online: false });
    const queued = await journal.log({ type: 'manoeuvre', subtype: 'tack' });

    await journal.edit(queued.ref, { time: '2026-09-13T09:30:00.000Z' });
    assert.equal(journal.outbox.snapshot().pending[0].body.time, '2026-09-13T09:30:00.000Z');
    assert.equal(calls.length, 1, 'nothing goes out while the queue holds it');

    server.online = true;
    await journal.flush();
    await journal.edit(queued.ref, { time: '2026-09-13T09:45:00.000Z', comment: 'at the buoy' });
    assert.deepEqual(calls.at(-1), {
      method: 'PATCH',
      url: '/events/1',
      body: { time: '2026-09-13T09:45:00.000Z', comment: 'at the buoy' }
    });
  });

  it('reads back the entry behind a ref, logged or still queued', async () => {
    const { journal, server } = setup({ online: false });
    const queued = await journal.log({ type: 'manoeuvre', subtype: 'gybe' });
    assert.equal(journal.entryFor(queued.ref).type, 'manoeuvre');
    assert.equal(journal.entryFor(queued.ref).time, '2026-09-13T10:00:00.000Z');

    server.online = true;
    await journal.flush();
    assert.equal(journal.entryFor(queued.ref).id, 1);
    assert.equal(journal.entryFor('ref-nothing'), null);
  });

  it('queues the undo of a logged entry when the connection drops', async () => {
    const { journal, calls, server } = setup();
    const sent = await journal.log({ type: 'manoeuvre', subtype: 'tack' });
    server.online = false;
    const error = await journal.undo(sent.ref);
    assert.equal(error.code, 'network');
    server.online = true;
    await journal.flush();
    assert.deepEqual(calls.at(-1), { method: 'DELETE', url: '/events/1', body: undefined });
  });
});

describe('entry app files', () => {
  it('lists every module the app loads in the service worker precache', () => {
    const entry = path.join(import.meta.dirname, '..', 'public', 'entry');
    const source = fs.readFileSync(path.join(entry, 'sw.js'), 'utf8');
    const shell = new Set(
      vm
        .runInNewContext(`${source};SHELL`, { self: { addEventListener() {} } })
        .map((file) => path.resolve(entry, file))
    );

    const seen = new Set();
    const visit = (file) => {
      if (seen.has(file)) {
        return;
      }
      seen.add(file);
      const code = fs.readFileSync(file, 'utf8');
      for (const [, specifier] of code.matchAll(/^import[^'"]*['"]([^'"]+)['"]/gm)) {
        visit(path.resolve(path.dirname(file), specifier));
      }
    };
    visit(path.join(entry, 'js', 'main.mjs'));

    for (const file of seen) {
      assert.ok(shell.has(file), `${path.relative(entry, file)} is precached`);
    }
  });
});

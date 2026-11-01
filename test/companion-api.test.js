const assert = require('node:assert/strict');
const { describe, it, beforeEach, afterEach } = require('node:test');
const { T0, at, startServer, insert, insertEntry } = require('./helpers');

const HERE = { lat: 46.2, lon: -1.3 };

const levelOf = (permissions, method, path) =>
  permissions.find((route) => route.method === method && route.path === path)?.level ?? 'admin';

describe('the versioned API', () => {
  let ctx;

  beforeEach(async () => {
    ctx = await startServer();
  });

  afterEach(() => ctx.close());

  it('answers the same under /api/v1 as under /api', async () => {
    const entryId = insertEntry(ctx.db);
    const plain = await ctx.request('GET', `/entries/${entryId}`);
    const versioned = await ctx.request('GET', `/v1/entries/${entryId}`);
    assert.equal(versioned.status, 200);
    assert.deepEqual(versioned.body, plain.body);
  });

  it('keeps each route at the same access level under both prefixes', () => {
    for (const route of ctx.permissions.filter((item) => item.path.startsWith('/api/v1/'))) {
      assert.equal(
        levelOf(ctx.permissions, route.method, route.path.replace('/api/v1/', '/api/')),
        route.level,
        `${route.method} ${route.path}`
      );
    }
  });

  it('leaves the webapp’s own maintenance routes out of v1', async () => {
    assert.equal((await ctx.request('GET', '/cloud-sync')).status, 200);
    assert.equal((await ctx.request('GET', '/v1/cloud-sync')).status, 404);
    assert.equal((await ctx.request('GET', '/v1/replay')).status, 404);
    assert.equal((await ctx.request('GET', '/v1/export/usb')).status, 404);
  });

  it('says which versions and features it serves', async () => {
    const { body } = await ctx.request('GET', '/v1/state');
    assert.deepEqual(body.apiVersions, [1]);
    assert.deepEqual(body.features, ['plans', 'defects', 'changes', 'endTanks']);
    assert.equal(body.pluginVersion, require('../package.json').version);
    assert.match(body.logbookId, /^[0-9a-f-]{36}$/);
  });

  it('opens the new routes to readwrite users', () => {
    for (const [method, path] of [
      ['POST', '/api/v1/plans'],
      ['PATCH', '/api/v1/plans/:id'],
      ['DELETE', '/api/v1/plans/:id'],
      ['POST', '/api/v1/defects'],
      ['PATCH', '/api/v1/defects/:id']
    ]) {
      assert.equal(levelOf(ctx.permissions, method, path), 'readwrite', `${method} ${path}`);
    }
    assert.equal(levelOf(ctx.permissions, 'GET', '/api/v1/changes'), 'readonly');
  });
});

describe('tanks at arrival', () => {
  let ctx;

  beforeEach(async () => {
    const timestamp = new Date().toISOString();
    ctx = await startServer({
      self: {
        navigation: {
          position: { value: { latitude: HERE.lat, longitude: HERE.lon }, timestamp }
        },
        tanks: { fuel: { 0: { currentLevel: { value: 0.45, timestamp } } } }
      }
    });
  });

  afterEach(() => ctx.close());

  it('are noted as the crew closes the passage', async () => {
    const id = insertEntry(ctx.db, { state: 'active' });
    const { status, body } = await ctx.request('POST', `/entries/${id}/close`);
    assert.equal(status, 200);
    assert.deepEqual(body.endTanks, [{ type: 'fuel', id: '0', level: 0.45 }]);
  });

  it('can be noted by hand on a closed passage, not on one under way', async () => {
    const active = insertEntry(ctx.db, { state: 'active' });
    const refused = await ctx.request('PATCH', `/entries/${active}`, {
      endTanks: [{ type: 'fuel', id: '0', level: 0.3 }]
    });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error.code, 'entry_active');

    ctx.db.prepare('DELETE FROM log_entries').run();
    const closed = insertEntry(ctx.db);
    const { status, body } = await ctx.request('PATCH', `/entries/${closed}`, {
      startTanks: [{ type: 'fuel', id: '0', volume: 0.1 }],
      endTanks: [{ type: 'fuel', id: '0', volume: 0.06, capacity: 0.12 }]
    });
    assert.equal(status, 200);
    assert.deepEqual(body.startTanks, [{ type: 'fuel', id: '0', volume: 0.1 }]);
    assert.deepEqual(body.endTanks, [{ type: 'fuel', id: '0', volume: 0.06, capacity: 0.12 }]);

    const cleared = await ctx.request('PATCH', `/entries/${closed}`, { endTanks: null });
    assert.equal(cleared.body.endTanks, null);

    const invalid = await ctx.request('PATCH', `/entries/${closed}`, {
      endTanks: [{ type: 'fuel', id: '0' }]
    });
    assert.equal(invalid.status, 400);
  });

  it('come with an imported passage', async () => {
    const { status, body } = await ctx.request('POST', '/entries', {
      startTime: at(-10),
      endTime: at(-8),
      startTanks: [{ type: 'fuel', id: '0', level: 0.9 }],
      endTanks: [{ type: 'fuel', id: '0', level: 0.7 }]
    });
    assert.equal(status, 201);
    assert.deepEqual(body.endTanks, [{ type: 'fuel', id: '0', level: 0.7 }]);
  });
});

describe('plans', () => {
  let ctx;

  beforeEach(async () => {
    ctx = await startServer();
  });

  afterEach(() => ctx.close());

  const PLAN = {
    clientRef: '0b7f3a1e-5c2d-4e8f-9a6b-1c2d3e4f5a6b',
    title: 'La Rochelle – Île d’Yeu',
    departureTime: at(24),
    departurePlaceName: 'La Rochelle',
    departurePosition: { lat: 46.15, lon: -1.17 },
    arrivalTime: at(33),
    arrivalPlaceName: 'Port-Joinville',
    routeRef: '/resources/routes/6f1b2c3d-0000-4000-8000-000000000001',
    fallbackRefs: ['/resources/waypoints/aaaa', '/resources/waypoints/bbbb'],
    criteria: { maxWindSpeed: 12.9, maxWaveHeight: 2 }
  };

  it('creates a draft, and answers a replay of it with the same plan', async () => {
    const first = await ctx.request('POST', '/v1/plans', PLAN);
    assert.equal(first.status, 201);
    assert.equal(first.body.status, 'draft');
    assert.equal(first.body.entryId, null);
    assert.deepEqual(first.body.fallbackRefs, PLAN.fallbackRefs);
    assert.deepEqual(first.body.criteria, PLAN.criteria);
    assert.deepEqual(first.body.crew, []);
    assert.deepEqual(first.body.departurePosition, PLAN.departurePosition);
    assert.equal(first.body.arrivalPosition, null);

    const replay = await ctx.request('POST', '/v1/plans', { ...PLAN, title: 'Something else' });
    assert.equal(replay.status, 200);
    assert.deepEqual(replay.body, first.body);
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM plans').get().n, 1);
  });

  it('refuses what it cannot hold', async () => {
    for (const body of [
      { ...PLAN, clientRef: undefined, title: undefined },
      { title: 'x', routeRef: 'routes/abc' },
      { title: 'x', fallbackRefs: ['/resources/routes/abc'] },
      { title: 'x', status: 'sailing' },
      { title: 'x', departureTime: at(5), arrivalTime: at(4) },
      { title: 'x', watches: [{ name: 'Jo', start: at(2), end: at(1) }] },
      { title: 'x', crew: [{ name: 'Jo', phone: '06' }] },
      { title: 'x', colour: 'blue' }
    ]) {
      const { status } = await ctx.request('POST', '/v1/plans', JSON.parse(JSON.stringify(body)));
      assert.equal(status, 400, JSON.stringify(body));
    }
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM plans').get().n, 0);
    const unknownMember = await ctx.request('POST', '/v1/plans', {
      title: 'x',
      crew: [{ crewMemberId: 99 }]
    });
    assert.equal(unknownMember.status, 404);
  });

  it('copies roster members in, and keeps typed names as typed', async () => {
    const alex = insert(ctx.db, 'crew_members', {
      name: 'Alex Martin',
      role: 'skipper',
      created_at: T0,
      updated_at: T0
    });
    const { body } = await ctx.request('POST', '/v1/plans', {
      title: 'Night passage',
      crew: [{ crewMemberId: alex }, { name: 'Jo', role: 'crew' }],
      watches: [
        { crewMemberId: alex, start: at(20), end: at(23) },
        { name: 'Jo', start: at(23), end: at(26) }
      ]
    });
    assert.deepEqual(body.crew, [
      { crewMemberId: alex, name: 'Alex Martin', role: 'skipper' },
      { crewMemberId: null, name: 'Jo', role: 'crew' }
    ]);
    assert.deepEqual(body.watches, [
      { start: at(20), end: at(23), crewMemberId: alex, name: 'Alex Martin', role: 'skipper' },
      { start: at(23), end: at(26), crewMemberId: null, name: 'Jo', role: null }
    ]);
  });

  it('boards the planned crew and goes active once linked to its passage', async () => {
    const previous = insertEntry(ctx.db, { start_time: at(-30), end_time: at(-28) });
    insert(ctx.db, 'log_entry_crew', {
      entry_id: previous,
      name: 'Carried over',
      created_at: T0
    });
    const entryId = insertEntry(ctx.db, { state: 'active', start_time: at(1) });
    insert(ctx.db, 'log_entry_crew', { entry_id: entryId, name: 'Carried over', created_at: T0 });

    const { body: plan } = await ctx.request('POST', '/v1/plans', {
      title: 'Day sail',
      status: 'ready',
      crew: [{ name: 'Alex Martin', role: 'skipper' }, { name: 'Jo' }]
    });
    const linked = await ctx.request('PATCH', `/v1/plans/${plan.id}`, { entryId });
    assert.equal(linked.status, 200);
    assert.equal(linked.body.entryId, entryId);
    assert.equal(linked.body.status, 'active');

    const { body: entry } = await ctx.request('GET', `/entries/${entryId}`);
    assert.deepEqual(
      entry.crew.map((member) => [member.name, member.role]),
      [
        ['Alex Martin', 'skipper'],
        ['Jo', null]
      ]
    );

    const { body: found } = await ctx.request('GET', `/v1/plans?entryId=${entryId}`);
    assert.deepEqual(
      found.items.map((item) => item.id),
      [plan.id]
    );

    const { body: other } = await ctx.request('POST', '/v1/plans', { title: 'Other' });
    const taken = await ctx.request('PATCH', `/v1/plans/${other.id}`, { entryId });
    assert.equal(taken.status, 409);
    assert.equal(taken.body.error.code, 'entry_has_plan');
  });

  it('keeps its status when linked after it was done, and edits field by field', async () => {
    const entryId = insertEntry(ctx.db);
    const { body: plan } = await ctx.request('POST', '/v1/plans', {
      title: 'Late',
      status: 'done'
    });
    const { body } = await ctx.request('PATCH', `/v1/plans/${plan.id}`, {
      entryId,
      arrivalPlaceName: 'Ars-en-Ré',
      criteria: null
    });
    assert.equal(body.status, 'done');
    assert.equal(body.title, 'Late');
    assert.equal(body.arrivalPlaceName, 'Ars-en-Ré');

    const unlinked = await ctx.request('PATCH', `/v1/plans/${plan.id}`, { entryId: null });
    assert.equal(unlinked.body.entryId, null);
    assert.equal(
      (await ctx.request('PATCH', `/v1/plans/${plan.id}`, { clientRef: 'x' })).status,
      400,
      'the idempotency key is set once'
    );
  });

  it('lists by status, and is deleted on request', async () => {
    await ctx.request('POST', '/v1/plans', { title: 'A', departureTime: at(10) });
    const { body: b } = await ctx.request('POST', '/v1/plans', {
      title: 'B',
      status: 'ready',
      departureTime: at(20)
    });
    const all = await ctx.request('GET', '/v1/plans');
    assert.deepEqual(
      all.body.items.map((item) => item.title),
      ['B', 'A']
    );
    const ready = await ctx.request('GET', '/v1/plans?status=ready');
    assert.equal(ready.body.total, 1);
    assert.equal((await ctx.request('GET', '/v1/plans?status=nope')).status, 400);

    assert.equal((await ctx.request('DELETE', `/v1/plans/${b.id}`)).status, 204);
    assert.equal((await ctx.request('GET', `/v1/plans/${b.id}`)).status, 404);
  });

  it('loses its passage when the passage is deleted, and follows it through a merge', async () => {
    const earlier = insertEntry(ctx.db, { start_time: at(0), end_time: at(2) });
    const later = insertEntry(ctx.db, { start_time: at(3), end_time: at(5) });
    const gone = insertEntry(ctx.db, { start_time: at(10), end_time: at(12) });
    const { body: kept } = await ctx.request('POST', '/v1/plans', {
      title: 'Kept',
      entryId: later
    });
    assert.equal(kept.status, 'active', 'a plan made for a passage under way is active');
    const { body: orphan } = await ctx.request('POST', '/v1/plans', {
      title: 'Orphan',
      entryId: gone
    });

    await ctx.request('DELETE', `/entries/${gone}`);
    assert.equal((await ctx.request('GET', `/v1/plans/${orphan.id}`)).body.entryId, null);

    const merged = await ctx.request('POST', `/entries/${earlier}/merge`, { withEntryId: later });
    assert.equal(merged.status, 200);
    assert.equal((await ctx.request('GET', `/v1/plans/${kept.id}`)).body.entryId, earlier);
  });
});

describe('defects', () => {
  let ctx;
  let entryId;
  let eventId;

  beforeEach(async () => {
    ctx = await startServer();
    entryId = insertEntry(ctx.db);
    eventId = insert(ctx.db, 'events', {
      entry_id: entryId,
      time: at(1),
      type: 'text_annotation',
      comment: 'Bilge pump runs every 10 minutes',
      created_at: at(1)
    });
  });

  afterEach(() => ctx.close());

  it('opens a minor defect by default, on the passage of the line that reported it', async () => {
    const { status, body } = await ctx.request('POST', '/v1/defects', {
      clientRef: 'd-1',
      title: 'Bilge pump',
      eventId
    });
    assert.equal(status, 201);
    assert.equal(body.severity, 'minor');
    assert.equal(body.status, 'open');
    assert.equal(body.fixedAt, null);
    assert.equal(body.entryId, entryId);
    assert.equal(body.eventId, eventId);

    const replay = await ctx.request('POST', '/v1/defects', { clientRef: 'd-1', title: 'Again' });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.id, body.id);
  });

  it('refuses links that do not hold', async () => {
    const other = insertEntry(ctx.db, { start_time: at(10), end_time: at(12) });
    const mismatch = await ctx.request('POST', '/v1/defects', {
      title: 'x',
      entryId: other,
      eventId
    });
    assert.equal(mismatch.status, 400);
    assert.equal((await ctx.request('POST', '/v1/defects', { title: 'x', planId: 5 })).status, 404);
    assert.equal(
      (await ctx.request('POST', '/v1/defects', { title: 'x', severity: 'fatal' })).status,
      400
    );
    assert.equal(
      (await ctx.request('POST', '/v1/defects', { title: 'x', fixedAt: at(2) })).status,
      400,
      'an open defect has no repair date'
    );
  });

  it('dates the repair when fixed, and forgets it when reopened', async () => {
    const { body } = await ctx.request('POST', '/v1/defects', {
      title: 'Torn genoa',
      severity: 'major',
      time: at(2)
    });
    const fixed = await ctx.request('PATCH', `/v1/defects/${body.id}`, { status: 'fixed' });
    assert.equal(fixed.status, 200);
    assert.equal(fixed.body.status, 'fixed');
    assert.ok(fixed.body.fixedAt);

    const redated = await ctx.request('PATCH', `/v1/defects/${body.id}`, { fixedAt: at(30) });
    assert.equal(redated.body.fixedAt, at(30));

    const reopened = await ctx.request('PATCH', `/v1/defects/${body.id}`, { status: 'open' });
    assert.equal(reopened.body.fixedAt, null);
    assert.equal(reopened.body.time, at(2));
    assert.equal(reopened.body.severity, 'major');
  });

  it('lists the newest first, by status, passage or plan', async () => {
    const { body: plan } = await ctx.request('POST', '/v1/plans', { title: 'P' });
    await ctx.request('POST', '/v1/defects', { title: 'Old', time: at(1), entryId });
    await ctx.request('POST', '/v1/defects', {
      title: 'New',
      time: at(3),
      planId: plan.id,
      status: 'fixed'
    });
    const all = await ctx.request('GET', '/v1/defects');
    assert.deepEqual(
      all.body.items.map((item) => item.title),
      ['New', 'Old']
    );
    assert.equal((await ctx.request('GET', '/v1/defects?status=open')).body.total, 1);
    assert.equal((await ctx.request('GET', `/v1/defects?entryId=${entryId}`)).body.total, 1);
    assert.equal((await ctx.request('GET', `/v1/defects?planId=${plan.id}`)).body.total, 1);
  });

  it('outlives the passage it came from', async () => {
    const { body } = await ctx.request('POST', '/v1/defects', { title: 'Bilge pump', eventId });
    await ctx.request('DELETE', `/entries/${entryId}`);
    const { body: after } = await ctx.request('GET', `/v1/defects/${body.id}`);
    assert.equal(after.entryId, null);
    assert.equal(after.eventId, null);
    assert.equal(after.status, 'open');
  });
});

describe('GET /changes', () => {
  let ctx;

  beforeEach(async () => {
    ctx = await startServer();
  });

  afterEach(() => ctx.close());

  const changes = (since, limit) =>
    ctx.request('GET', `/v1/changes?since=${since}${limit ? `&limit=${limit}` : ''}`);

  it('starts from what is there, then follows every change once, latest state only', async () => {
    const entryId = insertEntry(ctx.db);
    const start = await changes(0);
    assert.equal(start.status, 200);
    assert.deepEqual(
      start.body.items.map((item) => [item.resource, item.id, item.deleted]),
      [['entry', entryId, false]]
    );
    assert.equal(start.body.items[0].item.id, entryId);
    assert.equal(start.body.more, false);
    let cursor = start.body.cursor;

    const { body: event } = await ctx.request('POST', `/entries/${entryId}/events`, {
      type: 'text_annotation',
      comment: 'first'
    });
    await ctx.request('PATCH', `/events/${event.id}`, { comment: 'second' });
    await ctx.request('PUT', `/entries/${entryId}/crew`, { members: [{ name: 'Jo' }] });

    const next = await changes(cursor);
    const byResource = Object.fromEntries(
      next.body.items.map((item) => [`${item.resource}:${item.id}`, item])
    );
    assert.equal(byResource[`event:${event.id}`].item.comment, 'second', 'once, as it stands');
    assert.deepEqual(
      byResource[`entryCrew:${entryId}`].item.crew.map((member) => member.name),
      ['Jo']
    );
    assert.ok(byResource['crewMember:1'], 'the roster grew');
    assert.equal(next.body.items.length, 3);
    cursor = next.body.cursor;

    assert.deepEqual((await changes(cursor)).body.items, [], 'nothing since');
  });

  it('reports deletions, cascades included', async () => {
    const entryId = insertEntry(ctx.db);
    const { body: event } = await ctx.request('POST', `/entries/${entryId}/events`, {
      type: 'text_annotation',
      comment: 'note'
    });
    const { cursor } = (await changes(0)).body;

    await ctx.request('DELETE', `/entries/${entryId}`);
    const { body } = await changes(cursor);
    const gone = body.items.map((item) => `${item.resource}:${item.id}:${item.deleted}`).sort();
    assert.deepEqual(gone, [`entry:${entryId}:true`, `event:${event.id}:true`]);
    assert.ok(body.items.every((item) => item.item === null));
  });

  it('follows plans and defects', async () => {
    const { cursor } = (await changes(0)).body;
    const { body: plan } = await ctx.request('POST', '/v1/plans', { title: 'P' });
    const { body: defect } = await ctx.request('POST', '/v1/defects', {
      title: 'D',
      planId: plan.id
    });
    const { body } = await changes(cursor);
    assert.deepEqual(
      body.items.map((item) => [item.resource, item.id]),
      [
        ['plan', plan.id],
        ['defect', defect.id]
      ]
    );
    assert.deepEqual(body.items[1].item, defect);
  });

  it('pages, and refuses a cursor it never gave', async () => {
    for (let hour = 0; hour < 5; hour += 1) {
      insertEntry(ctx.db, { start_time: at(hour * 10), end_time: at(hour * 10 + 1) });
    }
    const first = await changes(0, 2);
    assert.equal(first.body.items.length, 2);
    assert.equal(first.body.more, true);
    const rest = await changes(first.body.cursor, 10);
    assert.equal(rest.body.items.length, 3);
    assert.equal(rest.body.more, false);

    const ahead = await changes(rest.body.cursor + 100);
    assert.equal(ahead.status, 410);
    assert.equal(ahead.body.error.code, 'cursor_expired');
    assert.equal((await changes(-1)).status, 400);
    assert.equal((await ctx.request('GET', '/v1/changes?limit=501')).status, 400);
  });
});

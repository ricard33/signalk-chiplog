const assert = require('node:assert/strict');
const { describe, it, beforeEach, afterEach } = require('node:test');
const { T0, at, startServer, insert, insertEntry } = require('./helpers');

const STROKES = {
  strokes: [
    {
      points: [
        { x: 0, y: 0, t: 0, pressure: 0.4 },
        { x: 10, y: 12, t: 16, pressure: 0.6 }
      ]
    }
  ]
};

describe('events', () => {
  let ctx;
  let entryId;

  beforeEach(async () => {
    ctx = await startServer({
      self: { navigation: { position: { value: { latitude: 46.2, longitude: -1.3 } } } }
    });
    entryId = insertEntry(ctx.db, { state: 'active' });
  });

  afterEach(() => ctx.close());

  describe('POST /entries/:id/events', () => {
    it('logs a manoeuvre shortcut with the current time and vessel position', async () => {
      const before = Date.now();

      const { status, body } = await ctx.request('POST', `/entries/${entryId}/events`, {
        type: 'manoeuvre',
        subtype: 'reef_in',
        comment: '25 kn, second reef',
        payload: { sail: 'main' }
      });

      assert.equal(status, 201);
      assert.equal(body.type, 'manoeuvre');
      assert.equal(body.subtype, 'reef_in');
      assert.equal(body.source, 'manual');
      assert.deepEqual(body.payload, { sail: 'main' });
      assert.deepEqual(body.position, { lat: 46.2, lon: -1.3 });
      assert.ok(Date.parse(body.time) >= before - 1000);
    });

    it('keeps an explicit time and a null position', async () => {
      const { body } = await ctx.request('POST', `/entries/${entryId}/events`, {
        type: 'text_annotation',
        comment: 'Dolphins off the bow',
        time: at(1),
        position: null
      });
      assert.equal(body.time, at(1));
      assert.equal(body.position, null);
    });

    it('rejects an unknown manoeuvre type', async () => {
      const { status, body } = await ctx.request('POST', `/entries/${entryId}/events`, {
        type: 'manoeuvre',
        subtype: 'barrel_roll'
      });
      assert.equal(status, 400);
      assert.equal(body.error.code, 'unknown_manoeuvre_type');
    });

    it('requires a comment on a text annotation', async () => {
      const { status } = await ctx.request('POST', `/entries/${entryId}/events`, {
        type: 'text_annotation'
      });
      assert.equal(status, 400);
    });

    it('accepts well-formed handwritten strokes and rejects malformed ones', async () => {
      const valid = await ctx.request('POST', `/entries/${entryId}/events`, {
        type: 'handwritten_annotation',
        payload: STROKES
      });
      assert.equal(valid.status, 201);
      assert.deepEqual(valid.body.payload, STROKES);

      const invalid = await ctx.request('POST', `/entries/${entryId}/events`, {
        type: 'handwritten_annotation',
        payload: { strokes: [{ points: [{ x: 1, y: 'two' }] }] }
      });
      assert.equal(invalid.status, 400);
    });

    it('accepts a stroke color, tool and width, and rejects malformed ones', async () => {
      const styled = {
        strokes: [
          { points: STROKES.strokes[0].points, color: '#1d4ed8', tool: 'highlighter', width: 14 }
        ]
      };
      const valid = await ctx.request('POST', `/entries/${entryId}/events`, {
        type: 'handwritten_annotation',
        payload: styled
      });
      assert.equal(valid.status, 201);
      assert.deepEqual(valid.body.payload, styled);

      for (const stroke of [{ color: 'blue' }, { tool: 'crayon' }, { width: 0 }, { width: -1 }]) {
        const { status } = await ctx.request('POST', `/entries/${entryId}/events`, {
          type: 'handwritten_annotation',
          payload: { strokes: [{ points: STROKES.strokes[0].points, ...stroke }] }
        });
        assert.equal(status, 400, JSON.stringify(stroke));
      }
    });

    it('refuses event types that only the plugin produces', async () => {
      const { status } = await ctx.request('POST', `/entries/${entryId}/events`, {
        type: 'sk_alarm',
        subtype: 'notifications.mob'
      });
      assert.equal(status, 400);
    });

    it('answers 404 for an unknown entry', async () => {
      const { status } = await ctx.request('POST', '/entries/999/events', {
        type: 'text_annotation',
        comment: 'lost'
      });
      assert.equal(status, 404);
    });
  });

  describe('GET /entries/:id/events', () => {
    it('lists oldest first and filters by type', async () => {
      insert(ctx.db, 'events', {
        entry_id: entryId,
        time: at(2),
        type: 'text_annotation',
        comment: 'later',
        created_at: T0
      });
      insert(ctx.db, 'events', {
        entry_id: entryId,
        time: at(1),
        type: 'manoeuvre',
        subtype: 'tack',
        created_at: T0
      });

      const all = await ctx.request('GET', `/entries/${entryId}/events`);
      assert.deepEqual(
        all.body.items.map((event) => event.time),
        [at(1), at(2)]
      );

      const manoeuvres = await ctx.request('GET', `/entries/${entryId}/events?type=manoeuvre`);
      assert.equal(manoeuvres.body.total, 1);

      assert.equal((await ctx.request('GET', `/entries/${entryId}/events?type=bogus`)).status, 400);
    });
  });

  describe('PATCH and DELETE /events/:id', () => {
    it('edits a manual event and validates the result', async () => {
      const created = await ctx.request('POST', `/entries/${entryId}/events`, {
        type: 'text_annotation',
        comment: 'Wind backing'
      });

      const edited = await ctx.request('PATCH', `/events/${created.body.id}`, {
        comment: 'Wind backing SW'
      });
      assert.equal(edited.status, 200);
      assert.equal(edited.body.comment, 'Wind backing SW');

      const cleared = await ctx.request('PATCH', `/events/${created.body.id}`, { comment: null });
      assert.equal(cleared.status, 400);
    });

    it('only allows the comment of an automatic event to change', async () => {
      const id = insert(ctx.db, 'events', {
        entry_id: entryId,
        time: T0,
        type: 'sk_alarm',
        subtype: 'notifications.mob',
        source: 'auto',
        created_at: T0
      });

      assert.equal(
        (await ctx.request('PATCH', `/events/${id}`, { comment: 'False alarm' })).status,
        200
      );
      assert.equal((await ctx.request('PATCH', `/events/${id}`, { time: at(1) })).status, 400);
    });

    it('reads the position back from the track when an event is redated', async () => {
      insert(ctx.db, 'track_points', {
        entry_id: entryId,
        time: at(2),
        lat: 46.15,
        lon: -1.17
      });
      const { body: note } = await ctx.request('POST', `/entries/${entryId}/events`, {
        type: 'text_annotation',
        comment: 'Dolphins'
      });
      assert.deepEqual(note.position, { lat: 46.2, lon: -1.3 }, 'logged where the vessel was');

      const edited = await ctx.request('PATCH', `/events/${note.id}`, { time: at(2) });
      assert.equal(edited.status, 200);
      assert.equal(edited.body.time, at(2));
      assert.deepEqual(edited.body.position, { lat: 46.15, lon: -1.17 });
    });

    it('records no position when the track says nothing about the new time', async () => {
      insert(ctx.db, 'track_points', {
        entry_id: entryId,
        time: at(2),
        lat: 46.15,
        lon: -1.17
      });
      const { body: note } = await ctx.request('POST', `/entries/${entryId}/events`, {
        type: 'text_annotation',
        comment: 'Dolphins'
      });

      const edited = await ctx.request('PATCH', `/events/${note.id}`, { time: at(3) });
      assert.equal(edited.status, 200);
      assert.equal(edited.body.position, null, 'never the vessel position of the moment');
    });

    it('keeps the position when only the comment changes', async () => {
      const { body: note } = await ctx.request('POST', `/entries/${entryId}/events`, {
        type: 'text_annotation',
        comment: 'Dolphins'
      });

      const edited = await ctx.request('PATCH', `/events/${note.id}`, {
        comment: 'Dolphins, many'
      });
      assert.deepEqual(edited.body.position, { lat: 46.2, lon: -1.3 });
      assert.equal(edited.body.time, note.time);
    });

    it('refuses a time the passage could not have been logged at', async () => {
      const { body: note } = await ctx.request('POST', `/entries/${entryId}/events`, {
        type: 'text_annotation',
        comment: 'Dolphins'
      });

      const ahead = new Date(Date.now() + 3600 * 1000).toISOString();
      const future = await ctx.request('PATCH', `/events/${note.id}`, { time: ahead });
      assert.equal(future.status, 400);
      assert.match(future.body.error.message, /future/);

      const before = await ctx.request('PATCH', `/events/${note.id}`, { time: at(-1) });
      assert.equal(before.status, 400);
      assert.match(before.body.error.message, /within the passage/);

      const closed = insertEntry(ctx.db, {});
      const id = insert(ctx.db, 'events', {
        entry_id: closed,
        time: at(2),
        type: 'manoeuvre',
        subtype: 'tack',
        created_at: at(2)
      });
      // at(4) is that passage's arrival; an hour later is past it.
      assert.equal((await ctx.request('PATCH', `/events/${id}`, { time: at(5) })).status, 400);
      assert.equal((await ctx.request('PATCH', `/events/${id}`, { time: at(3) })).status, 200);
    });

    it('refuses to redate the event that opened the passage', async () => {
      const { body: event } = await ctx.request('POST', '/events', {
        type: 'manoeuvre',
        subtype: 'cast_off'
      });
      ctx.db
        .prepare('UPDATE log_entries SET opened_by_event_id = ? WHERE id = ?')
        .run(event.id, event.entryId);

      const refused = await ctx.request('PATCH', `/events/${event.id}`, { time: at(1) });
      assert.equal(refused.status, 400);
      assert.match(refused.body.error.message, /departure time/);
    });

    it('deletes an event', async () => {
      const created = await ctx.request('POST', `/entries/${entryId}/events`, {
        type: 'text_annotation',
        comment: 'Oops'
      });
      assert.equal((await ctx.request('DELETE', `/events/${created.body.id}`)).status, 204);
      assert.equal((await ctx.request('DELETE', `/events/${created.body.id}`)).status, 404);
    });

    describe('alarm pairing', () => {
      function alarm(entry, time, state) {
        return insert(ctx.db, 'events', {
          entry_id: entry,
          time,
          type: 'sk_alarm',
          subtype: 'notifications.mob',
          source: 'auto',
          payload: JSON.stringify({ state, message: 'MOB' }),
          created_at: T0
        });
      }

      async function remainingIds() {
        const page = await ctx.request('GET', `/entries/${entryId}/events`);
        return page.body.items.map((event) => event.id);
      }

      it('deleting the raised alarm also deletes its resolution', async () => {
        const raised = alarm(entryId, T0, 'alarm');
        alarm(entryId, at(1), 'normal');

        assert.equal((await ctx.request('DELETE', `/events/${raised}`)).status, 204);

        assert.deepEqual(await remainingIds(), []);
      });

      it('deleting the resolution also deletes the alarm it resolved', async () => {
        alarm(entryId, T0, 'alarm');
        const resolved = alarm(entryId, at(1), 'normal');

        assert.equal((await ctx.request('DELETE', `/events/${resolved}`)).status, 204);

        assert.deepEqual(await remainingIds(), []);
      });

      it('deletes a still-open alarm on its own, with no resolution to pair', async () => {
        const raised = alarm(entryId, T0, 'alarm');
        assert.equal((await ctx.request('DELETE', `/events/${raised}`)).status, 204);
        assert.deepEqual(await remainingIds(), []);
      });

      it('does not pair an escalation, both states being critical', async () => {
        const raised = alarm(entryId, T0, 'alarm');
        const escalated = alarm(entryId, at(1), 'emergency');

        assert.equal((await ctx.request('DELETE', `/events/${raised}`)).status, 204);

        assert.deepEqual(await remainingIds(), [escalated]);
      });
    });
  });
});

describe('instrument snapshot with a manoeuvre', () => {
  let ctx;
  let entryId;

  beforeEach(async () => {
    const now = new Date().toISOString();
    ctx = await startServer({
      self: {
        navigation: { position: { value: { latitude: 46.2, longitude: -1.3 }, timestamp: now } },
        environment: { wind: { speedTrue: { value: 8.2, timestamp: now } } }
      }
    });
    entryId = insertEntry(ctx.db, { state: 'active' });
  });

  afterEach(() => ctx.close());

  const observations = async () =>
    (await ctx.request('GET', `/entries/${entryId}/observations`)).body;

  it('is taken when a manoeuvre is logged as it happens', async () => {
    const { body: event } = await ctx.request('POST', `/entries/${entryId}/events`, {
      type: 'manoeuvre',
      subtype: 'reef_in'
    });

    const { total, items } = await observations();
    assert.equal(total, 1);
    assert.equal(items[0].reason, 'event');
    assert.equal(items[0].time, event.time);
    assert.equal(items[0].tws, 8.2);
    assert.deepEqual(items[0].position, { lat: 46.2, lon: -1.3 });
  });

  it('goes with the old time when the event is redated', async () => {
    const { body: event } = await ctx.request('POST', `/entries/${entryId}/events`, {
      type: 'manoeuvre',
      subtype: 'reef_in'
    });
    assert.equal((await observations()).total, 1, 'taken when the manoeuvre was logged');

    await ctx.request('PATCH', `/events/${event.id}`, { time: at(1) });

    assert.equal(
      (await observations()).total,
      0,
      'the readings belong to the moment the button was pressed, not to the new time'
    );
  });

  it('stays when another event of the passage still stands at that time', async () => {
    const { body: event } = await ctx.request('POST', `/entries/${entryId}/events`, {
      type: 'manoeuvre',
      subtype: 'reef_in'
    });
    // A propulsion change takes a snapshot of its own at the same instant.
    insert(ctx.db, 'events', {
      entry_id: entryId,
      time: event.time,
      type: 'propulsion_change',
      source: 'auto',
      created_at: event.time
    });

    await ctx.request('PATCH', `/events/${event.id}`, { time: at(1) });

    assert.equal((await observations()).total, 1);
  });

  it('is not taken for a manoeuvre logged after the fact', async () => {
    await ctx.request('POST', `/entries/${entryId}/events`, {
      type: 'manoeuvre',
      subtype: 'tack',
      time: at(1)
    });

    assert.equal((await observations()).total, 0);
  });

  it('is also taken for a live note or handwritten annotation, not just a manoeuvre', async () => {
    const { body: note } = await ctx.request('POST', `/entries/${entryId}/events`, {
      type: 'text_annotation',
      comment: 'Dolphins'
    });
    const { body: sketch } = await ctx.request('POST', `/entries/${entryId}/events`, {
      type: 'handwritten_annotation',
      payload: { strokes: [{ points: [{ x: 0, y: 0, t: 0 }] }] }
    });

    const { total, items } = await observations();
    assert.equal(total, 2);
    assert.deepEqual(
      items.map((item) => item.time),
      [note.time, sketch.time]
    );
    assert.ok(items.every((item) => item.reason === 'event'));
  });

  it('is not taken for a note logged after the fact, replayed from an offline queue', async () => {
    await ctx.request('POST', `/entries/${entryId}/events`, {
      type: 'text_annotation',
      comment: 'Dolphins',
      time: at(1)
    });

    assert.equal((await observations()).total, 0);
  });
});

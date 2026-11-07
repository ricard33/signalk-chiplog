const assert = require('node:assert/strict');
const { describe, it, beforeEach, afterEach } = require('node:test');
const { at, startServer, insert, insertEntry } = require('./helpers');

describe('propulsion', () => {
  let ctx;

  beforeEach(async () => {
    ctx = await startServer();
  });

  afterEach(() => ctx.close());

  it('lists the segments of an entry', async () => {
    const entryId = insertEntry(ctx.db);
    insert(ctx.db, 'propulsion_segments', {
      entry_id: entryId,
      type: 'engine',
      start_time: at(0),
      end_time: at(1),
      average_rpm: 1800
    });

    const { status, body } = await ctx.request('GET', `/entries/${entryId}/propulsion`);

    assert.equal(status, 200);
    assert.equal(body.total, 1);
    assert.equal(body.items[0].averageRpm, 1800);
  });

  it('deletes a segment, the previous one taking its place, but never the first', async () => {
    const entryId = insertEntry(ctx.db, { engine_duration: 3600, sail_duration: 7200 });
    const first = insert(ctx.db, 'propulsion_segments', {
      entry_id: entryId,
      type: 'engine',
      start_time: at(0),
      end_time: at(1)
    });
    const second = insert(ctx.db, 'propulsion_segments', {
      entry_id: entryId,
      type: 'sail',
      start_time: at(1),
      end_time: at(3)
    });

    const refused = await ctx.request('DELETE', `/propulsion/${first}`);
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error.code, 'first_segment');

    const { status, body } = await ctx.request('DELETE', `/propulsion/${second}`);
    assert.equal(status, 200);
    assert.equal(body.id, first);
    assert.equal(body.endTime, at(3));
    assert.equal(body.source, 'manual');
    const entry = ctx.db.prepare('SELECT * FROM log_entries WHERE id = ?').get(entryId);
    assert.equal(entry.engine_duration, 10800);
    assert.equal(entry.sail_duration, 0);
    assert.equal((await ctx.request('DELETE', `/propulsion/${second}`)).status, 404);
  });

  it('corrects a mis-detected segment, recomputes totals and logs the correction', async () => {
    const entryId = insertEntry(ctx.db, { engine_duration: 7200 });
    const segmentId = insert(ctx.db, 'propulsion_segments', {
      entry_id: entryId,
      type: 'engine',
      start_time: at(1),
      end_time: at(3)
    });

    const { status, body } = await ctx.request('PATCH', `/propulsion/${segmentId}`, {
      type: 'sail'
    });

    assert.equal(status, 200);
    assert.equal(body.type, 'sail');
    assert.equal(body.source, 'manual');

    const entry = await ctx.request('GET', `/entries/${entryId}`);
    assert.equal(entry.body.engineDuration, 0);
    assert.equal(entry.body.sailDuration, 7200);

    const corrections = await ctx.request(
      'GET',
      `/entries/${entryId}/events?type=manual_correction`
    );
    assert.equal(corrections.body.total, 1);
    const [correction] = corrections.body.items;
    assert.equal(correction.time, at(1));
    assert.equal(correction.source, 'auto');
    assert.deepEqual(correction.payload, {
      segmentId,
      before: { type: 'engine' },
      after: { type: 'sail' }
    });
  });

  it('does nothing when the type is unchanged', async () => {
    const entryId = insertEntry(ctx.db);
    const segmentId = insert(ctx.db, 'propulsion_segments', {
      entry_id: entryId,
      type: 'sail',
      start_time: at(0),
      end_time: at(1)
    });

    const { body } = await ctx.request('PATCH', `/propulsion/${segmentId}`, { type: 'sail' });

    assert.equal(body.source, 'auto');
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 0);
  });

  it('rejects an invalid type', async () => {
    const entryId = insertEntry(ctx.db);
    const segmentId = insert(ctx.db, 'propulsion_segments', {
      entry_id: entryId,
      type: 'sail',
      start_time: at(0)
    });
    assert.equal(
      (await ctx.request('PATCH', `/propulsion/${segmentId}`, { type: 'oars' })).status,
      400
    );
  });

  describe('switching by hand', () => {
    const active = (ctx) => insertEntry(ctx.db, { state: 'active' });
    const open = (ctx, entryId, type = 'sail') =>
      insert(ctx.db, 'propulsion_segments', {
        entry_id: entryId,
        type,
        start_time: at(0)
      });

    it('ends the segment under way and starts the other, held as manual', async () => {
      const entryId = active(ctx);
      const first = open(ctx, entryId);

      const { status, body } = await ctx.request('POST', `/entries/${entryId}/propulsion`, {
        type: 'engine',
        engines: { Port: true, Starboard: false }
      });

      assert.equal(status, 200);
      assert.equal(body.type, 'engine');
      assert.equal(body.source, 'manual');
      assert.equal(body.endTime, null);
      const ended = ctx.db.prepare('SELECT * FROM propulsion_segments WHERE id = ?').get(first);
      assert.equal(
        ended.end_time,
        ctx.db.prepare('SELECT start_time FROM propulsion_segments WHERE id = ?').get(body.id)
          .start_time
      );
      const events = await ctx.request('GET', `/entries/${entryId}/events?type=propulsion_change`);
      assert.equal(events.body.total, 1);
      assert.equal(events.body.items[0].source, 'manual');
      assert.deepEqual(events.body.items[0].payload.engines, { Port: true, Starboard: false });
      assert.deepEqual(events.body.items[0].payload.before, { type: 'sail' });
    });

    it('logs which engine runs when the type stays, without a new segment', async () => {
      const entryId = active(ctx);
      open(ctx, entryId, 'engine');

      const { body } = await ctx.request('POST', `/entries/${entryId}/propulsion`, {
        type: 'engine',
        engines: { Port: false, Starboard: true }
      });

      assert.equal(body.source, 'auto');
      assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM propulsion_segments').get().n, 1);
      assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 1);
    });

    it('answers a repeated clientRef without switching again', async () => {
      const entryId = active(ctx);
      open(ctx, entryId);
      const body = { type: 'engine', clientRef: 'abc' };

      const first = await ctx.request('POST', `/entries/${entryId}/propulsion`, body);
      const again = await ctx.request('POST', `/entries/${entryId}/propulsion`, {
        ...body,
        type: 'sail'
      });

      assert.equal(again.status, 200);
      assert.equal(again.body.id, first.body.id);
      assert.equal(again.body.type, 'engine');
      assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM propulsion_segments').get().n, 2);
      assert.equal(ctx.db.prepare('SELECT client_ref FROM events').get().client_ref, 'abc');
    });

    it('does nothing at all when nothing changes', async () => {
      const entryId = active(ctx);
      open(ctx, entryId);

      await ctx.request('POST', `/entries/${entryId}/propulsion`, { type: 'sail' });

      assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 0);
    });

    it('refuses a passage that is closed, and bad bodies', async () => {
      const closed = insertEntry(ctx.db);
      const refused = await ctx.request('POST', `/entries/${closed}/propulsion`, {
        type: 'engine'
      });
      assert.equal(refused.status, 409);
      assert.equal(refused.body.error.code, 'entry_not_active');

      const entryId = active(ctx);
      for (const body of [
        { type: 'oars' },
        { type: 'engine', engines: { Port: 'yes' } },
        { type: 'engine', engines: {} },
        { type: 'engine', extra: 1 }
      ]) {
        assert.equal(
          (await ctx.request('POST', `/entries/${entryId}/propulsion`, body)).status,
          400
        );
      }
    });
  });
});

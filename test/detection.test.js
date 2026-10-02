const assert = require('node:assert/strict');
const { describe, it, afterEach } = require('node:test');
const { closeEntry } = require('../lib/entries');
const { createBoat, addPlace, iso, MINUTE, BERTH } = require('./boat');

describe('passage detection', () => {
  let boat;

  afterEach(() => boat.close());

  describe('with the speed fallback', () => {
    it('opens a passage dated and placed where the vessel left its berth', () => {
      boat = createBoat().start().sail(5, { sog: 0.1 });
      assert.equal(boat.entries().length, 0);

      const leftAt = boat.nextTick();
      const berthLat = boat.position.lat;
      boat.sail(5, { sog: 5 });

      const [entry] = boat.entries();
      assert.equal(entry.state, 'active');
      assert.equal(entry.start_time, iso(leftAt));
      assert.ok(Math.abs(entry.start_lat - berthLat) < 0.00001, 'starts at the berth');
      assert.equal(boat.detector.mode(), 'fallback');
      assert.equal(boat.detector.motion(), 'underway');
    });

    it('ignores a speed spike while swinging at anchor', () => {
      boat = createBoat()
        .start()
        .sail(30, { sog: (i) => (i % 20 === 10 ? 4 : 0.3) });
      assert.equal(boat.entries().length, 0);
    });

    it('ends the passage as soon as it sees the stop, dated and placed where it stopped', () => {
      boat = createBoat().start().sail(20, { sog: 5 });
      const stoppedAt = boat.nextTick();
      const stopLat = boat.position.lat;

      boat.sail(5, { sog: 0 });

      const entries = boat.entries();
      assert.equal(entries.length, 1);
      assert.equal(entries[0].state, 'closed');
      assert.equal(entries[0].closed_by, 'detection');
      assert.equal(entries[0].end_time, iso(stoppedAt));
      assert.ok(Math.abs(entries[0].end_lat - stopLat) < 0.0001, 'ends where it stopped');
    });

    it('reopens the passage when the vessel leaves again within the tolerance', () => {
      boat = createBoat().start().sail(20, { sog: 5 });
      const stoppedAt = boat.nextTick();
      const stopLat = boat.position.lat;
      boat.sail(20, { sog: 0 });
      assert.equal(boat.entries()[0].state, 'closed');
      // As if the summary of that arrival had already gone out.
      boat.db
        .prepare(
          `INSERT INTO passage_summary_mails (entry_id, sent_at, created_at)
           VALUES (?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
        )
        .run(boat.entries()[0].id);

      const resumedAt = boat.nextTick();
      boat.sail(10, { sog: 5 });

      const entries = boat.entries();
      assert.equal(entries.length, 1);
      assert.equal(entries[0].state, 'active');
      assert.equal(entries[0].end_time, null);
      assert.deepEqual(
        boat
          .observations()
          .filter((o) => o.reason === 'entry_start')
          .map((o) => o.time),
        [boat.observations()[0].time, iso(resumedAt)],
        'a departure reading at the start and another where it set off again'
      );
      assert.equal(entries[0].closed_by, null);
      assert.equal(entries[0].end_place_name, null);
      assert.equal(
        boat.db.prepare('SELECT COUNT(*) AS n FROM passage_summary_mails').get().n,
        0,
        'any summary already sent is forgotten: the passage is not over (SPEC §4.16)'
      );
      const [stopover] = boat.events().filter((event) => event.type === 'stopover');
      assert.equal(stopover.entry_id, entries[0].id);
      assert.equal(stopover.time, iso(stoppedAt));
      assert.ok(Math.abs(stopover.lat - stopLat) < 0.0001, 'where it stopped');
      assert.ok(stopover.comment, 'named after the stop');

      boat.sail(5, { sog: 0 });
      assert.equal(boat.entries()[0].state, 'closed', 'and closes it again at the next stop');
      assert.equal(boat.entries().length, 1);
    });

    it('opens a new passage when the vessel leaves after the tolerance', () => {
      boat = createBoat().start().sail(20, { sog: 5 }).sail(40, { sog: 0 }).sail(10, { sog: 5 });

      const [first, second] = boat.entries();
      assert.equal(first.state, 'closed');
      assert.equal(second.state, 'active');
      assert.equal(boat.events().filter((event) => event.type === 'stopover').length, 0);
    });

    it('carries the crew over from the previous passage when a new one opens', () => {
      boat = createBoat().start().sail(20, { sog: 5 }).sail(40, { sog: 0 });
      const [first] = boat.entries();
      const memberId = boat.db
        .prepare(
          `INSERT INTO crew_members (name, role, created_at, updated_at)
           VALUES ('Alex', 'skipper', ?, ?)`
        )
        .run(iso(boat.now), iso(boat.now)).lastInsertRowid;
      boat.db
        .prepare(
          `INSERT INTO log_entry_crew (entry_id, crew_member_id, name, role, created_at)
           VALUES (?, ?, 'Alex', 'skipper', ?)`
        )
        .run(first.id, memberId, iso(boat.now));

      boat.sail(10, { sog: 5 });

      const [, second] = boat.entries();
      const crew = boat.db
        .prepare('SELECT * FROM log_entry_crew WHERE entry_id = ?')
        .all(second.id);
      assert.equal(crew.length, 1);
      assert.equal(crew[0].crew_member_id, Number(memberId));
      assert.equal(crew[0].name, 'Alex');
      assert.equal(crew[0].role, 'skipper');
    });

    it('honours a configured tolerance and under-way speed', () => {
      boat = createBoat({ settings: { stopClosureMinutes: 5, fallbackUnderwaySpeed: 3 } }).start();

      boat.sail(10, { sog: 2 });
      assert.equal(boat.entries().length, 0, '2 kn is below the configured 3 kn');

      boat.sail(10, { sog: 4 }).sail(8, { sog: 0 }).sail(10, { sog: 4 });
      assert.equal(boat.entries().length, 2, 'left again after the 5 min tolerance');
    });
  });

  describe('with navigation.state', () => {
    it('follows the published state and dates transitions from speed, despite its lag', () => {
      boat = createBoat().start().sail(5, { sog: 0, state: 'moored' });

      const leftAt = boat.nextTick();
      boat.sail(10, { sog: 5, state: 'moored' });
      assert.equal(boat.entries().length, 0, 'navigation.state has the final say');

      boat.sail(1, { sog: 5, state: 'sailing' });
      let [entry] = boat.entries();
      assert.equal(entry.start_time, iso(leftAt));
      assert.ok(Math.abs(entry.start_lat - BERTH.lat) < 0.0001);
      assert.equal(boat.detector.mode(), 'autostate');

      const stoppedAt = boat.nextTick();
      boat.sail(10, { sog: 0, state: 'sailing' }).sail(1, { sog: 0, state: 'moored' });
      [entry] = boat.entries();
      assert.equal(entry.state, 'closed');
      assert.equal(entry.end_time, iso(stoppedAt));
    });

    it('treats an unrecognised state as absent', () => {
      boat = createBoat().start().sail(10, { sog: 5, state: 'not defined (example)' });
      assert.equal(boat.detector.mode(), 'fallback');
      assert.equal(boat.entries().length, 1);
      assert.deepEqual(
        { ...boat.detector.stateIssue(), updatedAt: undefined },
        {
          reason: 'unrecognised',
          source: null,
          value: 'not defined (example)',
          updatedAt: undefined
        }
      );
    });

    it('follows the source the server resolved navigation.state to', () => {
      // signalk-autostate and the boat's own AIS transponder both publish the
      // path. Which one wins is the server's answer -- its source priorities --
      // not a preference of Chiplog's: here signalk-autostate published last.
      boat = createBoat()
        .start()
        .sail(10, {
          sog: 0,
          stateSources: { 'nmea0183.AI': 'motoring', 'signalk-autostate.XX': 'moored' }
        });

      assert.equal(boat.detector.mode(), 'autostate');
      assert.equal(boat.detector.motion(), 'stopped');
      assert.equal(boat.detector.stateIssue(), null);
      assert.equal(boat.entries().length, 0);

      // The other way round, a transponder left at "under way using engine"
      // is followed just the same: correcting that is the server's business.
      boat.sail(10, {
        sog: 0,
        stateSources: { 'signalk-autostate.XX': 'moored', 'nmea0183.AI': 'motoring' }
      });

      assert.equal(boat.detector.motion(), 'underway');
    });

    it('uses the only source there is, whatever it is', () => {
      boat = createBoat()
        .start()
        .sail(5, { sog: 0, stateSources: { 'nmea0183.AI': 'moored' } })
        .sail(5, { sog: 0, stateSources: { 'n2k.43': 'default' } });
      assert.equal(boat.detector.mode(), 'fallback');
      assert.deepEqual(
        { ...boat.detector.stateIssue(), updatedAt: undefined },
        { reason: 'unrecognised', source: 'n2k.43', value: 'default', updatedAt: undefined }
      );
    });

    it('tells why it falls back to speed', () => {
      boat = createBoat().start().sail(1, { sog: 0 });
      assert.deepEqual(boat.detector.stateIssue(), { reason: 'absent' });

      boat.sail(1, { sog: 0, stateSources: { 'signalk-autostate.XX': null } });
      assert.equal(boat.detector.stateIssue().reason, 'pending');
      assert.equal(boat.detector.stateIssue().source, 'signalk-autostate.XX');
    });

    it('falls back to speed once navigation.state stops being refreshed', () => {
      boat = createBoat().start().sail(1, { sog: 0, state: 'moored' });
      const lastUpdate = iso(boat.now);
      boat.sail(25, { sog: 0 });
      assert.equal(boat.detector.mode(), 'fallback');
      assert.deepEqual(boat.detector.stateIssue(), {
        reason: 'stale',
        source: null,
        value: 'moored',
        updatedAt: lastUpdate
      });

      boat.sail(5, { sog: 5 });
      assert.equal(boat.entries().length, 1);
    });
  });

  it('names departure and arrival after known places', () => {
    boat = createBoat();
    addPlace(boat.db, 'Les Minimes', BERTH);
    boat.start().sail(5, { sog: 0 }).sail(30, { sog: 6 });
    addPlace(boat.db, 'Île de Ré', boat.position);

    boat.sail(40, { sog: 0 });

    const [entry] = boat.entries();
    assert.equal(entry.start_place_name, 'Les Minimes');
    assert.equal(entry.end_place_name, 'Île de Ré');
    assert.ok(entry.start_place_id && entry.end_place_id);
  });

  it('keeps an arrival name set by hand before the passage closed', () => {
    boat = createBoat().start().sail(20, { sog: 5 });
    addPlace(boat.db, 'Detected', boat.position);
    boat.db.prepare("UPDATE log_entries SET end_place_name = 'Typed by crew'").run();

    boat.sail(40, { sog: 0 });

    assert.equal(boat.entries()[0].end_place_name, 'Typed by crew');
  });

  describe('across restarts', () => {
    it('ends a passage left open by a power cut at its last recorded movement', () => {
      boat = createBoat().start().sail(30, { sog: 5 });
      const { last_moving_at: lastMoving } = boat.entries()[0];

      boat.now += 2 * 24 * 60 * MINUTE;
      boat.start().sail(1, { sog: 0 });

      const entries = boat.entries();
      assert.equal(entries.length, 1);
      assert.equal(entries[0].state, 'closed');
      assert.equal(entries[0].end_time, lastMoving);
    });

    it('carries on with the same passage after a short restart', () => {
      boat = createBoat().start().sail(30, { sog: 5 });
      boat.now += MINUTE;
      boat.start().sail(5, { sog: 5 });

      const entries = boat.entries();
      assert.equal(entries.length, 1);
      assert.equal(entries[0].state, 'active');
    });

    it('splits the log when the plugin was down for longer than the tolerance mid-passage', () => {
      boat = createBoat().start().sail(30, { sog: 5 });
      const { last_moving_at: lastMoving } = boat.entries()[0];

      boat.now += 3 * 60 * MINUTE;
      boat.start().sail(5, { sog: 5 });

      const [first, second] = boat.entries();
      assert.equal(first.state, 'closed');
      assert.equal(first.end_time, lastMoving);
      assert.equal(second.state, 'active');
      assert.ok(second.start_time >= first.end_time);
    });
  });

  it('does not reopen a passage closed by hand while still moving', () => {
    boat = createBoat().start().sail(10, { sog: 5 });
    const [entry] = boat.entries();
    closeEntry(boat.db, entry.id, { now: iso(boat.now), position: null, placeMatchRadius: 200 });

    boat.sail(10, { sog: 5 });
    assert.equal(boat.entries().length, 1);

    boat.sail(5, { sog: 0 }).sail(5, { sog: 5 });
    assert.equal(boat.entries().length, 2, 'a real departure opens the next passage');
    assert.equal(boat.entries()[0].closed_by, 'crew', 'rather than reopening this one');
  });

  it('neither opens nor ends a passage while data is missing', () => {
    boat = createBoat().start().sail(60);
    assert.equal(boat.detector.motion(), 'unknown');
    assert.equal(boat.entries().length, 0);

    boat.sail(10, { sog: 5 }).sail(90);
    assert.equal(boat.detector.motion(), 'unknown');
    assert.equal(boat.entries()[0].state, 'active');
  });

  it('works when the system clock disagrees with Signal K timestamps', () => {
    boat = createBoat({ clockOffsetMs: -3 * 365 * 24 * 60 * MINUTE })
      .start()
      .sail(5, { sog: 0 })
      .sail(5, { sog: 5 });
    assert.equal(boat.entries().length, 1);
  });
});

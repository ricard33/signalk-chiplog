const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, it, afterEach } = require('node:test');
const { openDatabase } = require('../lib/database');
const { createAlarmFilter, createEventWatcher, EVENT_DEFAULTS } = require('../lib/event-watcher');

const KNOT = 1852 / 3600;
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const T0 = Date.parse('2026-09-13T22:00:00.000Z');
const ANCHORAGE = { lat: 46.2, lon: -1.4 };

const iso = (ms) => new Date(ms).toISOString();

// A nested Signal K model read like the server's getSelfPath.
function createVessel({ settings = {} } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chiplog-events-'));
  const { db } = openDatabase(dataDir);
  const self = {};
  const snapshots = [];
  let watcher = null;

  const vessel = {
    db,
    now: T0,
    snapshots,
    settings: { ...EVENT_DEFAULTS, ...settings },

    publish(skPath, value) {
      const keys = skPath.split('.');
      let node = self;
      for (const key of keys.slice(0, -1)) {
        node[key] = node[key] ?? {};
        node = node[key];
      }
      node[keys.at(-1)] = { value, timestamp: iso(vessel.now) };
      return vessel;
    },

    remove(skPath) {
      const keys = skPath.split('.');
      const parent = keys.slice(0, -1).reduce((node, key) => node?.[key], self);
      delete parent[keys.at(-1)];
      return vessel;
    },

    at(position) {
      return vessel.publish('navigation.position', {
        latitude: position.lat,
        longitude: position.lon
      });
    },

    start() {
      watcher = createEventWatcher({
        db,
        readSelfPath: (skPath) => skPath.split('.').reduce((node, key) => node?.[key], self),
        settings: vessel.settings,
        observe: (entryId, time) => snapshots.push({ entryId, time }),
        clock: () => vessel.now
      });
      return vessel;
    },

    // Check every `step` seconds for `seconds`, republishing `values` first.
    run(seconds, { step = 1, values = {} } = {}) {
      for (let elapsed = 0; elapsed < seconds; elapsed += step) {
        vessel.now += step * SECOND;
        for (const [skPath, value] of Object.entries(values)) {
          vessel.publish(skPath, value);
        }
        if (vessel.lastPosition) {
          vessel.at(vessel.lastPosition);
        }
        watcher.check();
      }
      return vessel;
    },

    openEntry(fields = {}) {
      const row = {
        state: 'active',
        start_time: iso(T0 - HOUR),
        created_at: iso(T0),
        updated_at: iso(T0),
        ...fields
      };
      if (row.state === 'closed' && row.end_time === undefined) {
        row.end_time = iso(T0 - 1);
      }
      const columns = Object.keys(row);
      const { lastInsertRowid } = db
        .prepare(
          `INSERT INTO log_entries (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`
        )
        .run(...Object.values(row));
      return Number(lastInsertRowid);
    },

    events(type) {
      return db
        .prepare('SELECT * FROM events WHERE type = ? ORDER BY time, id')
        .all(type)
        .map((event) => ({ ...event, payload: JSON.parse(event.payload) }));
    },

    close() {
      db.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  };

  return vessel;
}

describe('automatic events', () => {
  let vessel;

  afterEach(() => vessel.close());

  describe('Signal K notifications', () => {
    it('logs a critical notification when raised and when cleared', () => {
      vessel = createVessel().start();
      const entryId = vessel.openEntry();

      vessel.publish('notifications.mob', { state: 'emergency', message: 'Person overboard' });
      vessel.run(5);

      let alarms = vessel.events('sk_alarm');
      assert.equal(alarms.length, 1, 'once, not on every check');
      assert.equal(alarms[0].entry_id, entryId);
      assert.equal(alarms[0].subtype, 'notifications.mob');
      assert.equal(alarms[0].comment, 'Person overboard');
      assert.equal(alarms[0].source, 'auto');
      assert.deepEqual(alarms[0].payload, { state: 'emergency', message: 'Person overboard' });
      assert.deepEqual(vessel.snapshots, [{ entryId, time: alarms[0].time }], 'with conditions');

      vessel.publish('notifications.mob', { state: 'normal', message: 'Recovered' });
      vessel.run(1);

      alarms = vessel.events('sk_alarm');
      assert.equal(alarms.length, 2);
      assert.equal(alarms[1].payload.state, 'normal');
      assert.equal(vessel.snapshots.length, 1, 'no snapshot for the clearing');
    });

    it('takes one snapshot for alarms raised together', () => {
      vessel = createVessel().start();
      vessel.openEntry();

      vessel.publish('notifications.mob', { state: 'emergency', message: 'MOB' });
      vessel.publish('notifications.navigation.anchor', { state: 'alarm', message: 'Anchor' });
      vessel.run(1);

      assert.equal(vessel.events('sk_alarm').length, 2);
      assert.equal(vessel.snapshots.length, 1);
    });

    it('ignores warnings and alerts', () => {
      vessel = createVessel().start();
      vessel.openEntry();

      vessel.publish('notifications.environment.depth.belowTransducer', {
        state: 'warn',
        message: 'Shallow water'
      });
      vessel.run(3);

      assert.equal(vessel.events('sk_alarm').length, 0);
    });

    it('logs no alarm when alarms are turned off', () => {
      vessel = createVessel({ settings: { alarmsEnabled: false } }).start();
      vessel.openEntry();

      vessel.publish('notifications.mob', { state: 'emergency', message: 'MOB' });
      vessel.run(2);
      vessel.publish('notifications.mob', { state: 'normal', message: 'Recovered' });
      vessel.run(1);

      assert.equal(vessel.events('sk_alarm').length, 0);
      assert.equal(vessel.snapshots.length, 0);
    });

    it('leaves out the alarms matching an ignored pattern', () => {
      vessel = createVessel({
        settings: { ignoredAlarms: ['notifications.chartplotter.unknown*', 'ais.*'] }
      }).start();
      vessel.openEntry();

      for (const code of [114, 115, 116]) {
        vessel.publish(`notifications.chartplotter.unknown${code}`, { state: 'alarm' });
      }
      vessel.publish('notifications.ais.collision.123', { state: 'alarm' });
      vessel.publish('notifications.chartplotter.depth', { state: 'alarm', message: 'Shallow' });
      vessel.run(2);

      assert.deepEqual(
        vessel.events('sk_alarm').map((event) => event.subtype),
        ['notifications.chartplotter.depth']
      );
    });

    it('still closes an alarm logged before it was ignored', () => {
      vessel = createVessel().start();
      vessel.openEntry();
      vessel.publish('notifications.chartplotter.unknown114', { state: 'alarm' });
      vessel.run(1);

      vessel.settings.ignoredAlarms = ['chartplotter.unknown*'];
      vessel.start();
      vessel.run(1);
      vessel.remove('notifications.chartplotter.unknown114');
      vessel.run(1);

      assert.deepEqual(
        vessel.events('sk_alarm').map((event) => event.payload.state),
        ['alarm', 'normal']
      );
    });

    it('logs an escalation, and a notification that disappears as cleared', () => {
      vessel = createVessel().start();
      vessel.openEntry();

      vessel.publish('notifications.propulsion.main.temperature', {
        state: 'alarm',
        message: 'Engine hot'
      });
      vessel.run(1);
      vessel.publish('notifications.propulsion.main.temperature', {
        state: 'emergency',
        message: 'Engine overheating'
      });
      vessel.run(1);
      vessel.remove('notifications.propulsion.main.temperature');
      vessel.run(1);

      assert.deepEqual(
        vessel.events('sk_alarm').map((event) => event.payload.state),
        ['alarm', 'emergency', 'normal']
      );
    });

    it('neither repeats an alarm after a restart nor forgets it was open', () => {
      vessel = createVessel().start();
      vessel.openEntry();
      vessel.publish('notifications.mob', { state: 'emergency', message: 'MOB' });
      vessel.run(1);

      vessel.start().run(5);
      assert.equal(vessel.events('sk_alarm').length, 1);

      vessel.publish('notifications.mob', { state: 'normal', message: 'Recovered' });
      vessel.start().run(1);
      assert.deepEqual(
        vessel.events('sk_alarm').map((event) => event.payload.state),
        ['emergency', 'normal'],
        'cleared while the plugin was restarting'
      );
    });

    it('does not log the clearing of an alarm that could not be logged', () => {
      vessel = createVessel().start();
      vessel.publish('notifications.mob', { state: 'emergency', message: 'MOB' });
      vessel.run(1);
      assert.equal(vessel.events('sk_alarm').length, 0, 'no passage to log it in');

      vessel.openEntry();
      vessel.publish('notifications.mob', { state: 'normal', message: 'Recovered' });
      vessel.run(1);

      assert.equal(vessel.events('sk_alarm').length, 0);
    });

    it('logs an anchor alarm between passages in the one that ended at the anchorage', () => {
      vessel = createVessel().start();
      const passage = vessel.openEntry({
        state: 'closed',
        end_lat: ANCHORAGE.lat,
        end_lon: ANCHORAGE.lon
      });

      vessel.lastPosition = { lat: ANCHORAGE.lat + 0.001, lon: ANCHORAGE.lon };
      vessel.publish('notifications.navigation.anchor', {
        state: 'emergency',
        message: 'Anchor dragging'
      });
      vessel.run(1);

      const [alarm] = vessel.events('sk_alarm');
      assert.equal(alarm.entry_id, passage);
      assert.ok(alarm.lat > ANCHORAGE.lat);
    });

    it('logs nothing between passages once the vessel has left the last arrival', () => {
      vessel = createVessel().start();
      vessel.openEntry({ state: 'closed', end_lat: ANCHORAGE.lat, end_lon: ANCHORAGE.lon });

      vessel.lastPosition = { lat: ANCHORAGE.lat + 0.05, lon: ANCHORAGE.lon };
      vessel.publish('notifications.navigation.anchor', { state: 'emergency', message: 'Anchor' });
      vessel.run(1);

      assert.equal(vessel.events('sk_alarm').length, 0);
    });
  });

  describe('autopilot', () => {
    it('logs engagement, mode changes and disengagement reported through state', () => {
      vessel = createVessel().start();
      vessel.openEntry();

      vessel.run(2, { values: { 'steering.autopilot.state': 'standby' } });
      vessel.run(2, {
        values: {
          'steering.autopilot.state': 'auto',
          'steering.autopilot.target.headingMagnetic': 4.2
        }
      });
      vessel.run(2, { values: { 'steering.autopilot.state': 'wind' } });
      vessel.run(2, { values: { 'steering.autopilot.state': 'standby' } });

      const events = vessel.events('autopilot');
      assert.deepEqual(
        events.map((event) => event.subtype),
        ['engaged', 'mode_changed', 'disengaged']
      );
      assert.deepEqual(events[0].payload, {
        mode: null,
        state: 'auto',
        target: { headingMagnetic: 4.2 }
      });
      assert.equal(events[1].payload.state, 'wind');
      assert.equal(events[2].payload.target, null, 'no stale target once disengaged');
      assert.equal(vessel.snapshots.length, 3, 'a snapshot with each engagement/mode change');
    });

    it('follows engaged and mode from the Autopilot API', () => {
      vessel = createVessel().start();
      vessel.openEntry();

      vessel.run(2, {
        values: { 'steering.autopilot.engaged': false, 'steering.autopilot.mode': 'compass' }
      });
      vessel.run(2, {
        values: {
          'steering.autopilot.engaged': true,
          'steering.autopilot.state': 'enabled',
          'steering.autopilot.target': 1.57
        }
      });

      const [event] = vessel.events('autopilot');
      assert.equal(event.subtype, 'engaged');
      assert.deepEqual(event.payload, { mode: 'compass', state: 'enabled', target: 1.57 });
    });

    it('reads an enabled/disabled state with an off/heading/wind/route mode', () => {
      vessel = createVessel().start();
      vessel.openEntry();

      vessel.run(2, {
        values: { 'steering.autopilot.state': 'disabled', 'steering.autopilot.mode': 'off' }
      });
      vessel.run(2, {
        values: { 'steering.autopilot.state': 'enabled', 'steering.autopilot.mode': 'heading' }
      });
      vessel.run(2, { values: { 'steering.autopilot.mode': 'wind' } });
      vessel.run(2, {
        values: { 'steering.autopilot.state': 'disabled', 'steering.autopilot.mode': 'off' }
      });

      assert.deepEqual(
        vessel.events('autopilot').map((event) => event.subtype),
        ['engaged', 'mode_changed', 'disengaged']
      );
    });

    it('ignores the autopilot outside a passage', () => {
      vessel = createVessel().start();
      vessel.openEntry({ state: 'closed', end_lat: ANCHORAGE.lat, end_lon: ANCHORAGE.lon });
      vessel.lastPosition = ANCHORAGE;

      vessel.run(2, { values: { 'steering.autopilot.state': 'standby' } });
      vessel.run(2, { values: { 'steering.autopilot.state': 'auto' } });

      assert.equal(vessel.events('autopilot').length, 0);
    });

    it('logs an autopilot found engaged at start-up unless that is already in the log', () => {
      vessel = createVessel().start();
      vessel.openEntry();

      vessel.run(1, { values: { 'steering.autopilot.state': 'auto' } });
      assert.deepEqual(
        vessel.events('autopilot').map((event) => event.subtype),
        ['engaged']
      );

      vessel.start().run(1, { values: { 'steering.autopilot.state': 'auto' } });
      assert.equal(vessel.events('autopilot').length, 1);
    });
  });

  describe('wind thresholds', () => {
    const wind = (knots) => ({ values: { 'environment.wind.speedTrue': knots * KNOT } });

    it('logs the average wind crossing a threshold, both ways, with hysteresis', () => {
      vessel = createVessel({ settings: { windSpeedThresholds: [20] } }).start();
      vessel.openEntry();

      vessel.run(3 * 60, wind(15)).run(5 * 60, wind(25));
      vessel.run(3 * 60, wind(19));
      assert.deepEqual(
        vessel.events('weather_threshold').map((event) => event.subtype),
        ['wind_above'],
        '19 kn is within the hysteresis band'
      );

      vessel.run(3 * 60, wind(17));
      const events = vessel.events('weather_threshold');
      assert.deepEqual(
        events.map((event) => event.subtype),
        ['wind_above', 'wind_below']
      );
      assert.ok(Math.abs(events[0].payload.threshold - 20 * KNOT) < 1e-9);
      assert.ok(events[0].payload.windSpeed >= 20 * KNOT);
      assert.equal(vessel.snapshots.length, 2);
    });

    it('ignores a gust', () => {
      vessel = createVessel({ settings: { windSpeedThresholds: [20] } }).start();
      vessel.openEntry();

      vessel
        .run(3 * 60, wind(15))
        .run(5, wind(45))
        .run(3 * 60, wind(15));

      assert.equal(vessel.events('weather_threshold').length, 0);
    });

    it('takes strong wind already blowing at start-up as the starting point, not a crossing', () => {
      vessel = createVessel({ settings: { windSpeedThresholds: [20] } }).start();
      vessel.openEntry();

      vessel.run(5 * 60, wind(28));

      assert.equal(vessel.events('weather_threshold').length, 0);
    });

    it('logs each threshold as the wind builds through it', () => {
      vessel = createVessel({ settings: { windSpeedThresholds: [20, 30] } }).start();
      vessel.openEntry();

      vessel
        .run(3 * 60, wind(15))
        .run(5 * 60, wind(25))
        .run(5 * 60, wind(35));

      assert.deepEqual(
        vessel
          .events('weather_threshold')
          .map((event) => Math.round(event.payload.threshold / KNOT)),
        [20, 30]
      );
    });
  });

  describe('barometric drop', () => {
    const pressure = (hectopascals) => ({
      step: 30,
      values: { 'environment.outside.pressure': hectopascals * 100 }
    });

    it('logs a fall of the configured amount over three hours, once', () => {
      vessel = createVessel({ settings: { pressureDropThreshold: 4 } }).start();
      vessel.openEntry();

      vessel.run(3 * 3600, pressure(1020));
      for (let hectopascals = 1019; hectopascals >= 1014; hectopascals -= 1) {
        vessel.run(1800, pressure(hectopascals));
      }

      const events = vessel.events('weather_threshold');
      assert.deepEqual(
        events.map((event) => event.subtype),
        ['pressure_drop']
      );
      assert.ok(events[0].payload.drop >= 400);
      assert.equal(events[0].payload.over, 3 * 3600);
    });

    it('can be disabled', () => {
      vessel = createVessel({ settings: { pressureDropThreshold: 0 } }).start();
      vessel.openEntry();

      vessel.run(3 * 3600, pressure(1020)).run(3 * 3600, pressure(1000));

      assert.equal(vessel.events('weather_threshold').length, 0);
    });
  });

  describe('heading changes', () => {
    const DEG = Math.PI / 180;
    const heading = (degrees, knots = 5) => ({
      values: {
        'navigation.headingTrue': (((degrees % 360) + 360) % 360) * DEG,
        'navigation.speedOverGround': knots * KNOT
      }
    });
    const settings = {
      headingChangeThreshold: 30,
      headingChangeTolerance: 10,
      headingChangeHoldSeconds: 60,
      headingChangeMinSpeed: 2,
      headingChangeCooldownMinutes: 5
    };

    it('logs the average heading once a change holds for the configured time', () => {
      vessel = createVessel({ settings }).start();
      vessel.openEntry();

      vessel.run(5, heading(0));
      vessel.run(65, heading(40));

      const events = vessel.events('heading_change');
      assert.equal(events.length, 1);
      assert.equal(events[0].subtype, null);
      assert.ok(Math.abs(events[0].payload.heading - 40 * DEG) < 0.01);
      assert.ok(Math.abs(events[0].payload.previousHeading) < 0.01);
      assert.equal(vessel.snapshots.length, 1, 'a snapshot with the change');
    });

    it('ignores a change under the threshold', () => {
      vessel = createVessel({ settings }).start();
      vessel.openEntry();

      vessel.run(5, heading(0));
      vessel.run(65, heading(20));

      assert.equal(vessel.events('heading_change').length, 0);
    });

    it('ignores a swing that does not hold', () => {
      vessel = createVessel({ settings }).start();
      vessel.openEntry();

      vessel.run(5, heading(0));
      vessel.run(30, heading(40));
      vessel.run(30, heading(0));

      assert.equal(vessel.events('heading_change').length, 0);
    });

    it('needs at least the configured speed', () => {
      vessel = createVessel({ settings }).start();
      vessel.openEntry();

      vessel.run(5, heading(0));
      vessel.run(65, heading(40, 1));

      assert.equal(vessel.events('heading_change').length, 0);
    });

    it('keeps the reference heading moving during the cooldown, without logging twice', () => {
      vessel = createVessel({ settings }).start();
      vessel.openEntry();

      vessel.run(5, heading(0));
      vessel.run(65, heading(40));
      vessel.run(65, heading(80));

      let events = vessel.events('heading_change');
      assert.equal(events.length, 1, 'the second change is within the cooldown');
      assert.ok(Math.abs(events[0].payload.heading - 40 * DEG) < 0.01);

      vessel.run(5 * 60, heading(80));
      vessel.run(65, heading(120));

      events = vessel.events('heading_change');
      assert.equal(events.length, 2);
      assert.ok(Math.abs(events[1].payload.previousHeading - 80 * DEG) < 0.01);
    });

    it('can be disabled', () => {
      vessel = createVessel({ settings: { ...settings, headingChangeEnabled: false } }).start();
      vessel.openEntry();

      vessel.run(5, heading(0));
      vessel.run(65, heading(90));

      assert.equal(vessel.events('heading_change').length, 0);
    });

    it('logs nothing outside a passage', () => {
      vessel = createVessel({ settings }).start();

      vessel.run(5, heading(0));
      vessel.run(65, heading(40));

      assert.equal(vessel.events('heading_change').length, 0);
    });
  });
});

describe('ignored alarm patterns', () => {
  it('matches whole paths, * standing for any characters', () => {
    const ignored = createAlarmFilter(['notifications.chartplotter.unknown*', 'engine.?', '']);

    assert.equal(ignored('notifications.chartplotter.unknown114'), true);
    assert.equal(ignored('notifications.chartplotter.unknown'), true);
    assert.equal(ignored('notifications.chartplotter.depth'), false);
    assert.equal(ignored('notifications.engine.?'), true, 'no character but * is special');
    assert.equal(ignored('notifications.engine.1'), false);
    assert.equal(ignored('notifications.mob'), false, 'an empty pattern matches nothing');
  });

  it('matches nothing without patterns', () => {
    assert.equal(createAlarmFilter(undefined)('notifications.mob'), false);
  });
});

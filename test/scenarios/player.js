// Plays a shared scenario on the plugin's own logbook engine and describes the logbook it
// leaves. The scenarios are shared with the Chiplog Skipper app, which keeps the logbook itself
// on boats without a server: it plays the same files on its port of these rules and compares
// with the results written here (`npm run scenarios`), so that a rule changed on one side only
// shows in a test, not at sea. See README.md in this directory for the format.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDatabase } = require('../../lib/database');
const {
  createPassageDetector,
  DETECTION_DEFAULTS,
  TICK_INTERVAL_MS
} = require('../../lib/detection');
const { OBSERVATION_DEFAULTS } = require('../../lib/observation-recorder');
const { PROPULSION_DEFAULTS } = require('../../lib/propulsion-detector');
const { createTrackRecorder, TRACK_DEFAULTS } = require('../../lib/track-recorder');
const { createEventWatcher, EVENT_DEFAULTS } = require('../../lib/event-watcher');
const { closeEntry, toEntry } = require('../../lib/entries');
const { logCrewEvent, CLIENT_EVENT_TYPES } = require('../../lib/events');
const { correctSegment, allSegments } = require('../../lib/propulsion');
const { allObservations } = require('../../lib/track');

const METRES_PER_DEGREE_LAT = 111320;
const MINUTE = 60 * 1000;
const DEFAULT_START = '2026-09-13T08:00:00.000Z';
const DEFAULT_POSITION = { lat: 46.1466, lon: -1.1686 };
const SOG = 'navigation.speedOverGround';
const PLACE_MATCH_RADIUS = 200;

const iso = (ms) => new Date(ms).toISOString();

// Numbers rounded so that the last bits of floating-point arithmetic, which may differ between
// two languages' maths libraries, do not count.
function rounded(value, decimals = 6) {
  if (typeof value === 'number') {
    const factor = 10 ** decimals;
    return Number.isInteger(value) ? value : Math.round(value * factor) / factor;
  }
  if (Array.isArray(value)) {
    return value.map((item) => rounded(item, decimals));
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, rounded(item, decimals)])
    );
  }
  return value;
}

// A value spec: a constant, a list of one value per minute (the last one held), or
// { "cycle": [...] }, one value per tick in turn.
function valueAt(spec, tick) {
  if (Array.isArray(spec)) {
    const minute = Math.floor((tick * TICK_INTERVAL_MS) / MINUTE);
    return spec[Math.min(minute, spec.length - 1)];
  }
  if (spec !== null && typeof spec === 'object' && Array.isArray(spec.cycle)) {
    return spec.cycle[tick % spec.cycle.length];
  }
  return spec;
}

function play(scenario) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chiplog-scenario-'));
  const { db } = openDatabase(dataDir);
  const self = {};
  const clockOffsetMs = (scenario.clockOffsetMinutes ?? 0) * MINUTE;
  let now = Date.parse(scenario.start ?? DEFAULT_START);
  let position = { ...(scenario.position ?? DEFAULT_POSITION) };
  const settings = {
    ...DETECTION_DEFAULTS,
    ...PROPULSION_DEFAULTS,
    ...OBSERVATION_DEFAULTS,
    ...TRACK_DEFAULTS,
    ...EVENT_DEFAULTS,
    placeMatchRadius: PLACE_MATCH_RADIUS,
    ...scenario.settings
  };
  const clock = () => now;

  // A branch such as readSelfPath('propulsion') returns the tree below it, like the server.
  function readSelfPath(skPath) {
    if (self[skPath]) {
      return self[skPath];
    }
    const prefix = `${skPath}.`;
    let tree;
    for (const [key, node] of Object.entries(self)) {
      if (!key.startsWith(prefix)) {
        continue;
      }
      tree = tree ?? {};
      const parts = key.slice(prefix.length).split('.');
      let branch = tree;
      for (const part of parts.slice(0, -1)) {
        branch[part] = branch[part] ?? {};
        branch = branch[part];
      }
      branch[parts.at(-1)] = node;
    }
    return tree;
  }

  const publish = (skPath, value) => {
    self[skPath] = { value, timestamp: iso(now + clockOffsetMs) };
  };

  function publishSources(skPath, bySource) {
    const node = self[skPath]?.values ? self[skPath] : { values: {} };
    const timestamp = iso(now + clockOffsetMs);
    for (const [source, value] of Object.entries(bySource)) {
      node.values[source] = { value, timestamp };
      Object.assign(node, { value, timestamp, $source: source });
    }
    self[skPath] = node;
  }

  function addPlace(name, at) {
    db.prepare(
      `INSERT INTO places (name, lat, lon, source, created_at, updated_at)
       VALUES (?, ?, ?, 'manual', ?, ?)`
    ).run(name, at.lat, at.lon, iso(now), iso(now));
  }

  function vesselPosition() {
    const value = self['navigation.position']?.value;
    return value && Number.isFinite(value.latitude) && Number.isFinite(value.longitude)
      ? { lat: value.latitude, lon: value.longitude }
      : null;
  }

  // What runs again after a restart: the detector, the track recorder and the event watcher.
  let detector;
  let recorder;
  let watcher;
  function start() {
    detector = createPassageDetector({ db, readSelfPath, settings, clock });
    recorder = createTrackRecorder({ db, readSelfPath, settings, clock });
    watcher = createEventWatcher({
      db,
      readSelfPath,
      settings,
      clock,
      observe: (entryId, time) => detector.observeEvent(entryId, time)
    });
  }

  const activeEntry = () => db.prepare("SELECT * FROM log_entries WHERE state = 'active'").get();
  const entryIds = () =>
    db
      .prepare('SELECT id FROM log_entries ORDER BY id')
      .all()
      .map((r) => r.id);

  for (const place of scenario.places ?? []) {
    addPlace(place.name, place);
  }
  start();

  const steps = [];
  for (const step of scenario.steps) {
    if (step.sail !== undefined) {
      const ticks = Math.round((step.sail * MINUTE) / TICK_INTERVAL_MS);
      for (let tick = 0; tick < ticks; tick += 1) {
        now += TICK_INTERVAL_MS;
        for (const [skPath, spec] of Object.entries(step.values ?? {})) {
          const value = valueAt(spec, tick);
          if (skPath === SOG && typeof value === 'number') {
            const metres = value * (TICK_INTERVAL_MS / 1000);
            position = { lat: position.lat + metres / METRES_PER_DEGREE_LAT, lon: position.lon };
            publish('navigation.position', { latitude: position.lat, longitude: position.lon });
          }
          publish(skPath, value);
        }
        for (const [skPath, spec] of Object.entries(step.sources ?? {})) {
          publishSources(
            skPath,
            Object.fromEntries(
              Object.entries(spec).map(([source, value]) => [source, valueAt(value, tick)])
            )
          );
        }
        recorder.sample();
        watcher.check();
        detector.tick();
      }
    } else if (step.restart !== undefined) {
      now += step.restart * MINUTE;
      start();
    } else if (step.crew !== undefined) {
      const input = { ...step.crew };
      const outcome = logCrewEvent(db, input, {
        now: iso(now),
        vesselPosition: vesselPosition(),
        stopClosureMinutes: settings.stopClosureMinutes,
        placeMatchRadius: settings.placeMatchRadius
      });
      if (outcome.created && CLIENT_EVENT_TYPES.includes(outcome.event.type)) {
        detector.observeEvent(outcome.event.entryId, outcome.event.time);
        if (outcome.openedEntry) {
          detector.noteDeparture(outcome.event.entryId);
        }
      }
    } else if (step.close) {
      const entry = activeEntry();
      closeEntry(db, entry.id, {
        now: iso(now),
        position: vesselPosition(),
        placeMatchRadius: settings.placeMatchRadius
      });
      detector.noteArrival(entry.id);
    } else if (step.correct !== undefined) {
      const segment = db
        .prepare(
          `SELECT s.id FROM propulsion_segments s JOIN log_entries e ON e.id = s.entry_id
           WHERE e.state = 'active' ORDER BY s.start_time DESC, s.id DESC LIMIT 1`
        )
        .get();
      correctSegment(db, segment.id, { type: step.correct }, { now: iso(now) });
    } else if (step.crewMembers !== undefined) {
      const entry = activeEntry();
      for (const name of step.crewMembers) {
        db.prepare(
          `INSERT INTO log_entry_crew (entry_id, crew_member_id, name, role, created_at)
           VALUES (?, NULL, ?, NULL, ?)`
        ).run(entry.id, name, iso(now));
      }
    } else if (step.nameArrival !== undefined) {
      db.prepare("UPDATE log_entries SET end_place_name = ? WHERE state = 'active'").run(
        step.nameArrival
      );
    } else if (step.addPlace !== undefined) {
      addPlace(step.addPlace, position);
    } else {
      throw new Error(`unknown step ${JSON.stringify(step)}`);
    }
    const active = activeEntry();
    steps.push({
      mode: detector.mode(),
      motion: detector.motion(),
      propulsion: detector.propulsion(),
      activePassage: active ? entryIds().indexOf(active.id) : null
    });
  }

  const result = describe(db);
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
  return { steps, ...result };
}

// The logbook in comparable terms: passages by their order, no ids nor creation dates.
function describe(db) {
  const ids = db
    .prepare('SELECT id FROM log_entries ORDER BY id')
    .all()
    .map((row) => row.id);
  const passage = (id) => ids.indexOf(id);
  const position = (lat, lon) => (lat === null ? null : rounded([lat, lon]));
  const rows = db.prepare('SELECT * FROM log_entries ORDER BY id').all();

  return {
    passages: rows.map((row) => {
      const entry = toEntry(row);
      return {
        state: entry.state,
        startTime: entry.startTime,
        endTime: entry.endTime,
        start: position(row.start_lat, row.start_lon),
        end: position(row.end_lat, row.end_lon),
        startPlace: entry.startPlaceName,
        startPlacePending: entry.startPlacePending,
        endPlace: entry.endPlaceName,
        endPlacePending: entry.endPlacePending,
        closedBy: row.closed_by,
        lastMovingAt: row.last_moving_at,
        stoppedSince: entry.stoppedSince,
        distance: rounded(entry.distance, 1),
        engineDuration: entry.engineDuration,
        sailDuration: entry.sailDuration,
        openedByCrew: entry.openedByEventId !== null,
        startTanks: rounded(entry.startTanks),
        startBatteries: rounded(entry.startBatteries),
        endTanks: rounded(entry.endTanks),
        crew: db
          .prepare('SELECT name FROM log_entry_crew WHERE entry_id = ? ORDER BY id')
          .all(row.id)
          .map((member) => member.name)
      };
    }),
    track: rows.map((row) => {
      const points = db
        .prepare('SELECT time, lat, lon FROM track_points WHERE entry_id = ? ORDER BY time, id')
        .all(row.id);
      const ends = (point) =>
        point ? { time: point.time, position: position(point.lat, point.lon) } : null;
      return {
        passage: passage(row.id),
        points: points.length,
        first: ends(points[0]),
        last: ends(points.at(-1))
      };
    }),
    segments: rows.flatMap((row) =>
      allSegments(db, row.id).map((segment) => ({
        passage: passage(segment.entryId),
        type: segment.type,
        startTime: segment.startTime,
        endTime: segment.endTime,
        source: segment.source,
        averageRpm: segment.averageRpm === null ? null : rounded(segment.averageRpm, 2)
      }))
    ),
    events: db
      .prepare('SELECT * FROM events ORDER BY time, id')
      .all()
      .map((row) => ({
        passage: passage(row.entry_id),
        time: row.time,
        type: row.type,
        subtype: row.subtype,
        position: position(row.lat, row.lon),
        comment: row.comment,
        payload: rounded(row.payload === null ? null : JSON.parse(row.payload)),
        source: row.source
      })),
    observations: rows.flatMap((row) =>
      allObservations(db, row.id).map(({ id, time, reason, position: at, ...values }) => ({
        passage: passage(row.id),
        time,
        reason,
        position: at === null ? null : rounded([at.lat, at.lon]),
        values: rounded(
          Object.fromEntries(Object.entries(values).filter(([, value]) => value !== null))
        )
      }))
    )
  };
}

function scenarioFiles(directory) {
  return fs
    .readdirSync(directory)
    .filter((name) => name.endsWith('.json') && !name.endsWith('.result.json'))
    .sort();
}

module.exports = { play, scenarioFiles };

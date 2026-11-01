const OBSERVATION_DEFAULTS = { observationIntervalMinutes: 60 };

// Navigation, wind and depth arrive several times a second; barometer and
// temperatures can be minutes apart.
const FAST_MAX_AGE_MS = 2 * 60 * 1000;
const SLOW_MAX_AGE_MS = 15 * 60 * 1000;

const COLUMNS = [
  'lat',
  'lon',
  'sog',
  'cog',
  'heading',
  'stw',
  'twd',
  'tws',
  'awa',
  'aws',
  'depth',
  'pressure',
  'air_temp',
  'water_temp',
  'trip_log',
  'engine_runtime',
  'engine_runtimes'
];

// Tanks listed in this order, the ones a skipper checks first at the top.
const TANK_TYPES = [
  'fuel',
  'freshWater',
  'wasteWater',
  'blackWater',
  'lubrication',
  'gas',
  'liveWell',
  'baitWell',
  'ballast'
];

function iso(ms) {
  return new Date(ms).toISOString();
}

function finiteOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizeAngle(radians) {
  return ((radians % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
}

function engineColumns(runtimes) {
  const values = Object.values(runtimes);
  return {
    engine_runtime: values.length > 0 ? values[0] : null,
    engine_runtimes: values.length > 0 ? JSON.stringify(runtimes) : null
  };
}

const byId = (a, b) => a.localeCompare(b, 'en', { numeric: true });

function tankTypeOrder(type) {
  const index = TANK_TYPES.indexOf(type);
  return index === -1 ? TANK_TYPES.length : index;
}

// A JSON array, or null for an empty one, so a boat without such sensors
// records nothing rather than `[]`.
function jsonList(items) {
  return items.length > 0 ? JSON.stringify(items) : null;
}

// What a reading holds, without the ones that are missing.
function withoutNulls(item) {
  return Object.fromEntries(Object.entries(item).filter(([, value]) => value !== null));
}

function createObservationRecorder({ db, readSelfPath, readFresh, settings }) {
  const intervalMs = settings.observationIntervalMinutes * 60 * 1000;
  let latest = {};
  let boatState = { tanks: null, batteries: null };

  const fast = (path, now) => finiteOrNull(readFresh(path, now, FAST_MAX_AGE_MS));
  const slow = (path, now) => finiteOrNull(readFresh(path, now, SLOW_MAX_AGE_MS));
  // A counter's last value stays a true reading while it does not move: engine
  // hours with the engine off, the trip log at anchor.
  const counter = (path) => finiteOrNull(readSelfPath(path)?.value);

  // The branches under a Signal K path -- engine, tank or battery ids -- as
  // the server's tree has them.
  function childrenOf(path) {
    const tree = readSelfPath(path);
    if (!tree || typeof tree !== 'object') {
      return [];
    }
    return Object.keys(tree).filter(
      (key) => key !== 'meta' && tree[key] !== null && typeof tree[key] === 'object'
    );
  }

  const text = (path) => {
    const value = readSelfPath(path)?.value;
    return typeof value === 'string' && value !== '' ? value : null;
  };

  // A tank's level only moves when something is drawn or filled, and many
  // senders publish only then: like a counter, its last value stays true.
  function tanks() {
    const list = [];
    const types = childrenOf('tanks').sort(
      (a, b) => tankTypeOrder(a) - tankTypeOrder(b) || byId(a, b)
    );
    for (const type of types) {
      for (const id of childrenOf(`tanks.${type}`).sort(byId)) {
        const base = `tanks.${type}.${id}`;
        const level = counter(`${base}.currentLevel`);
        const volume = counter(`${base}.currentVolume`);
        if (level === null && volume === null) {
          continue;
        }
        list.push(
          withoutNulls({
            type,
            id,
            name: text(`${base}.name`),
            level,
            volume,
            capacity: counter(`${base}.capacity`)
          })
        );
      }
    }
    return list;
  }

  // Battery readings move all the time; like the barometer, they are allowed
  // to be minutes apart. Followed on every cycle all the same, so the reading
  // at departure is known to be current.
  function batteries(now) {
    const list = [];
    for (const id of childrenOf('electrical.batteries').sort(byId)) {
      const base = `electrical.batteries.${id}`;
      const reading = {
        voltage: slow(`${base}.voltage`, now),
        current: slow(`${base}.current`, now),
        stateOfCharge: slow(`${base}.capacity.stateOfCharge`, now),
        temperature: slow(`${base}.temperature`, now)
      };
      if (Object.values(reading).every((value) => value === null)) {
        continue;
      }
      list.push(withoutNulls({ id, name: text(`${base}.name`), ...reading }));
    }
    return list;
  }

  // Every engine's hour counter, the main engine first, then by id — so that
  // the recorded JSON, and the columns exports make of it, keep one order.
  function engineRuntimes() {
    const ids = childrenOf('propulsion').sort((a, b) =>
      a === 'main' ? -1 : b === 'main' ? 1 : byId(a, b)
    );
    const runtimes = {};
    for (const id of ids) {
      const runtime = counter(`propulsion.${id}.runTime`);
      if (runtime !== null) {
        runtimes[id] = runtime;
      }
    }
    return runtimes;
  }

  // Called every detection cycle, not only when a snapshot is due: freshness is
  // judged by timestamps changing between reads, so a sensor read once an hour
  // would look current as long as it had changed at any point in that hour.
  function sense(now) {
    const position = readFresh('navigation.position', now, FAST_MAX_AGE_MS);
    const headingTrue = fast('navigation.headingTrue', now);
    const headingMagnetic = fast('navigation.headingMagnetic', now);
    const variation = slow('navigation.magneticVariation', now);
    const belowSurface = fast('environment.depth.belowSurface', now);
    const belowTransducer = fast('environment.depth.belowTransducer', now);

    const hasPosition =
      position && Number.isFinite(position.latitude) && Number.isFinite(position.longitude);

    latest = {
      lat: hasPosition ? position.latitude : null,
      lon: hasPosition ? position.longitude : null,
      sog: fast('navigation.speedOverGround', now),
      cog: fast('navigation.courseOverGroundTrue', now),
      heading:
        headingTrue ??
        (headingMagnetic !== null && variation !== null
          ? normalizeAngle(headingMagnetic + variation)
          : null),
      stw: fast('navigation.speedThroughWater', now),
      twd: fast('environment.wind.directionTrue', now),
      tws: fast('environment.wind.speedTrue', now),
      awa: fast('environment.wind.angleApparent', now),
      aws: fast('environment.wind.speedApparent', now),
      depth: belowSurface ?? belowTransducer,
      pressure: slow('environment.outside.pressure', now),
      air_temp: slow('environment.outside.temperature', now),
      water_temp: slow('environment.water.temperature', now),
      trip_log: counter('navigation.log'),
      ...engineColumns(engineRuntimes())
    };
    boatState = { tanks: jsonList(tanks()), batteries: jsonList(batteries(now)) };
  }

  function record(entryId, reason, time) {
    if (COLUMNS.every((column) => latest[column] === null)) {
      return null;
    }
    const { lastInsertRowid } = db
      .prepare(
        `INSERT INTO observations (entry_id, time, reason, ${COLUMNS.join(', ')})
         VALUES (?, ?, ?, ${COLUMNS.map(() => '?').join(', ')})`
      )
      .run(entryId, time, reason, ...COLUMNS.map((column) => latest[column]));
    return Number(lastInsertRowid);
  }

  // The boat's state is noted once on the passage, as it opens -- as a skipper
  // does before casting off -- not with the readings along the way.
  function noteBoatState(entryId) {
    db.prepare('UPDATE log_entries SET start_tanks = ?, start_batteries = ? WHERE id = ?').run(
      boatState.tanks,
      boatState.batteries,
      entryId
    );
  }

  // And the tanks once more as it ends, for what the passage consumed. A passage that carries
  // on after a short stop has not ended: what was noted at the stop no longer holds.
  function noteArrivalState(entryId) {
    db.prepare('UPDATE log_entries SET end_tanks = ? WHERE id = ?').run(boatState.tanks, entryId);
  }

  // Periodic snapshots fall on clock boundaries — on the hour by default — as
  // on a paper log. Any snapshot already in the slot, such as one taken for an
  // event, stands in for the periodic one.
  function recordPeriodic(entry, now) {
    const { lastTime } = db
      .prepare('SELECT MAX(time) AS lastTime FROM observations WHERE entry_id = ?')
      .get(entry.id);
    const lastSlot = Math.floor(Date.parse(lastTime ?? entry.start_time) / intervalMs);
    if (Math.floor(now / intervalMs) > lastSlot) {
      record(entry.id, 'periodic', iso(now));
    }
  }

  return {
    sense,

    // Runs inside detection's transaction, with what this cycle did to passages.
    afterDetection(now, { opened, reopened, resumedAt, closed }) {
      if (closed && !closed.late) {
        // Dated from the actual end of the passage, not from this tick that
        // found out about it once detection saw the stop -- a stopover event
        // (SPEC §3.1) needs to sort after this reading, not before it, and
        // readings taken since the boat has been still say the same thing
        // regardless.
        record(closed.id, 'entry_end', closed.endTime);
        noteArrivalState(closed.id);
      }
      if (opened) {
        record(opened, 'entry_start', iso(now));
        noteBoatState(opened);
        return;
      }
      // A passage reopened after a short stop sets off again: its departure
      // reading is dated from when it did, like the propulsion segment.
      if (reopened) {
        db.prepare('UPDATE log_entries SET end_tanks = NULL WHERE id = ?').run(reopened);
        record(reopened, 'entry_start', iso(resumedAt));
        return;
      }
      const entry = db
        .prepare("SELECT id, start_time FROM log_entries WHERE state = 'active'")
        .get();
      if (entry) {
        recordPeriodic(entry, now);
      }
    },

    // A passage the crew opened by hand, as they logged casting off.
    noteDeparture(entryId, now) {
      sense(now);
      noteBoatState(entryId);
    },

    // A passage the crew closed by hand, as they confirmed the arrival.
    noteArrival(entryId, now) {
      sense(now);
      noteArrivalState(entryId);
    },

    recordEvent(entryId, time, now) {
      sense(now);
      return record(entryId, 'event', time);
    }
  };
}

module.exports = { createObservationRecorder, OBSERVATION_DEFAULTS };

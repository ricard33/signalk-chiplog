const { recomputeDurations } = require('./entries');

// Engine data is published continuously: NMEA 2000 revolutions several times
// a second, signalk-alternator-engine-on's state on every alternator reading.
const ENGINE_DATA_MAX_AGE_MS = 2 * 60 * 1000;

const PROPULSION_DEFAULTS = { defaultPropulsion: 'sail' };

function iso(ms) {
  return new Date(ms).toISOString();
}

function createPropulsionTracker({ db, readSelfPath, readFresh, settings, observations }) {
  let previousType = null;
  let rpmAverage = null;

  // Engine data wins over navigation.state, which signalk-autostate derives
  // from the same sources or from its own default when it has none.
  function sense(now, navigationState) {
    let hasEngineData = false;
    let running = false;
    const rpms = [];

    for (const id of Object.keys(readSelfPath('propulsion') ?? {})) {
      const revolutions = readFresh(`propulsion.${id}.revolutions`, now, ENGINE_DATA_MAX_AGE_MS);
      if (typeof revolutions === 'number' && Number.isFinite(revolutions)) {
        hasEngineData = true;
        if (revolutions > 0) {
          running = true;
          rpms.push(revolutions * 60);
        }
        continue;
      }
      const state = readFresh(`propulsion.${id}.state`, now, ENGINE_DATA_MAX_AGE_MS);
      if (state === 'started' || state === 'stopped') {
        hasEngineData = true;
        running = running || state === 'started';
      }
    }

    let type = settings.defaultPropulsion;
    if (hasEngineData) {
      type = running ? 'engine' : 'sail';
    } else if (navigationState === 'motoring') {
      type = 'engine';
    } else if (navigationState === 'sailing') {
      type = 'sail';
    }
    const rpm = rpms.length > 0 ? rpms.reduce((sum, value) => sum + value, 0) / rpms.length : null;
    return { type, rpm };
  }

  // Each engine Signal K lists and whether it runs now: null without fresh data.
  function engines(now) {
    return Object.keys(readSelfPath('propulsion') ?? {}).map((id) => {
      const revolutions = readFresh(`propulsion.${id}.revolutions`, now, ENGINE_DATA_MAX_AGE_MS);
      if (typeof revolutions === 'number' && Number.isFinite(revolutions)) {
        return { id, running: revolutions > 0 };
      }
      const state = readFresh(`propulsion.${id}.state`, now, ENGINE_DATA_MAX_AGE_MS);
      return { id, running: state === 'started' ? true : state === 'stopped' ? false : null };
    });
  }

  function closeSegment(segment, endTime) {
    const end = endTime < segment.start_time ? segment.start_time : endTime;
    db.prepare('UPDATE propulsion_segments SET end_time = ? WHERE id = ?').run(end, segment.id);
  }

  function openSegment(entry, type, requestedStart, now) {
    const { lastEnd } = db
      .prepare('SELECT MAX(end_time) AS lastEnd FROM propulsion_segments WHERE entry_id = ?')
      .get(entry.id);
    let start = lastEnd === null ? entry.start_time : requestedStart;
    if (lastEnd !== null && start < lastEnd) {
      start = lastEnd;
    }
    if (start > iso(now)) {
      start = iso(now);
    }
    const { lastInsertRowid } = db
      .prepare(
        "INSERT INTO propulsion_segments (entry_id, type, start_time, source) VALUES (?, ?, ?, 'auto')"
      )
      .run(entry.id, type, start);
    return db
      .prepare('SELECT * FROM propulsion_segments WHERE id = ?')
      .get(Number(lastInsertRowid));
  }

  // An automatic switch is logged the same way a manual correction is, so it
  // shows in the passage log with the conditions it happened in.
  function logTransition(entryId, segment, beforeType, now) {
    const time = iso(now);
    const payload = JSON.stringify({
      segmentId: segment.id,
      before: { type: beforeType },
      after: { type: segment.type }
    });
    db.prepare(
      `INSERT INTO events (entry_id, time, type, payload, source, created_at)
       VALUES (?, ?, 'propulsion_change', ?, 'auto', ?)`
    ).run(entryId, time, payload, time);
    observations.recordEvent(entryId, time, now);
  }

  function trackRpm(segment, rpm) {
    if (rpmAverage?.segmentId !== segment.id) {
      rpmAverage = {
        segmentId: segment.id,
        sum: segment.average_rpm ?? 0,
        count: segment.average_rpm === null ? 0 : 1
      };
    }
    rpmAverage.sum += rpm;
    rpmAverage.count += 1;
    db.prepare('UPDATE propulsion_segments SET average_rpm = ? WHERE id = ?').run(
      rpmAverage.sum / rpmAverage.count,
      segment.id
    );
  }

  // Runs inside detection's transaction, after it has updated the passage, so
  // segment boundaries reuse the departure, stop and resume times it worked out.
  function reconcile(now, sensed, { resumedAt = null } = {}) {
    const entry = db.prepare("SELECT * FROM log_entries WHERE state = 'active'").get();
    const moving = entry !== undefined && entry.stopped_since === null;
    const touched = new Set(moving ? [entry.id] : []);
    let current = null;
    let transitionFrom = null;

    const open = db
      .prepare(
        `SELECT s.*, e.state AS entry_state, e.end_time AS entry_end, e.stopped_since AS entry_stopped
         FROM propulsion_segments s JOIN log_entries e ON e.id = s.entry_id
         WHERE s.end_time IS NULL
         ORDER BY s.start_time`
      )
      .all();

    for (const segment of open) {
      let end = null;
      if (segment.entry_state === 'closed') {
        end = segment.entry_end;
      } else if (segment.entry_stopped !== null) {
        end = segment.entry_stopped;
      } else if (current) {
        end = iso(now);
      } else if (segment.type !== sensed.type) {
        // Split only when the engine actually changes state, so a manual
        // correction of the ongoing segment holds on a boat whose sensors keep
        // reporting the old value. After a restart, only automatic segments
        // are brought back in line.
        const changed = previousType !== null && sensed.type !== previousType;
        const restarted = previousType === null && segment.source === 'auto';
        if (changed || restarted) {
          end = iso(now);
          if (changed) {
            transitionFrom = segment.type;
          }
        }
      }

      if (end === null) {
        current = segment;
      } else {
        closeSegment(segment, end);
        touched.add(segment.entry_id);
      }
    }

    if (moving && !current) {
      current = openSegment(entry, sensed.type, iso(resumedAt ?? now), now);
    }
    if (moving && current.type === 'engine' && sensed.rpm !== null) {
      trackRpm(current, sensed.rpm);
    }
    if (transitionFrom !== null && current) {
      logTransition(entry.id, current, transitionFrom, now);
    }

    for (const entryId of touched) {
      recomputeDurations(db, entryId, iso(now));
    }
    previousType = sensed.type;
  }

  return { sense, reconcile, engines };
}

module.exports = { createPropulsionTracker, PROPULSION_DEFAULTS };

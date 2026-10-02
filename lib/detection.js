const { withTransaction } = require('./database');
const crew = require('./crew');
const { recordStopover, reopenableEntry } = require('./entries');
const { initialPlaceName } = require('./place-names');
const { createObservationRecorder } = require('./observation-recorder');
const { createPropulsionTracker } = require('./propulsion-detector');
const { toPosition } = require('./rows');

const METRES_PER_SECOND_PER_KNOT = 1852 / 3600;

const TICK_INTERVAL_MS = 15 * 1000;
// Speed is averaged over this window, so a gust swinging the boat at anchor
// does not start a passage.
const SPEED_WINDOW_MS = 3 * 60 * 1000;
const MIN_SPEED_SAMPLES = 6;
const HEARTBEAT_INTERVAL_MS = 60 * 1000;
const LATE_CLOSURE_MARGIN_MS = 5 * 60 * 1000;
// signalk-autostate needs about ten minutes to notice a change; raw speed
// samples older than this are no longer trusted to date one.
const MAX_REFINEMENT_AGE_MS = 20 * 60 * 1000;

// How long a Signal K value stays current after it last changed.
// signalk-autostate republishes navigation.state at least every ten minutes.
const MAX_AGE_MS = {
  'navigation.state': 20 * 60 * 1000,
  'navigation.speedOverGround': 2 * 60 * 1000,
  'navigation.position': 2 * 60 * 1000
};

const STOPPED_STATES = new Set(['moored', 'anchored', 'aground', 'not-under-way']);
const UNDERWAY_STATES = new Set([
  'sailing',
  'motoring',
  'not under command',
  'towing < 200m',
  'towing > 200m',
  'pushing',
  'fishing',
  'fishing-hampered',
  'trawling',
  'trawling-shooting',
  'trawling-hauling',
  'pilotage',
  'restricted manouverability',
  'restricted manouverability towing < 200m',
  'restricted manouverability towing > 200m',
  'restricted manouverability underwater operations',
  'constrained by draft',
  'mine clearance'
]);

const DETECTION_DEFAULTS = { stopClosureMinutes: 30, fallbackUnderwaySpeed: 1 };

function iso(ms) {
  return new Date(ms).toISOString();
}

function classifyState(state) {
  if (STOPPED_STATES.has(state)) {
    return 'stopped';
  }
  return UNDERWAY_STATES.has(state) ? 'underway' : null;
}

// A value is trusted when its timestamp changed recently by our own clock, so
// a system clock that is off — a Raspberry Pi without a real-time clock boots
// with the wrong date — does not make live data look stale. Only a value seen
// for the first time is judged against the system clock.
function createFreshnessTracker(readSelfPath) {
  const seen = new Map();

  // `key` names what is tracked; `node` defaults to the value at that path, and
  // is given to track one source of a path on its own.
  return function readFresh(key, now, maxAge = MAX_AGE_MS[key], node = readSelfPath(key)) {
    if (!node || node.value === null || node.value === undefined || !node.timestamp) {
      return undefined;
    }

    const record = seen.get(key);
    if (!record || record.timestamp !== node.timestamp) {
      let observedAt = now;
      if (!record) {
        const stamped = Date.parse(node.timestamp);
        observedAt = Math.abs(now - stamped) <= maxAge ? Math.min(now, stamped) : null;
      }
      seen.set(key, { timestamp: node.timestamp, observedAt });
    }

    const { observedAt } = seen.get(key);
    return observedAt !== null && now - observedAt <= maxAge ? node.value : undefined;
  };
}

// The reading of navigation.state detection relies on, with the source the
// server resolved it to. A boat publishing the path from several sources — its
// own AIS class A transponder alongside signalk-autostate, typically — settles
// which one wins with the server's source priorities, not here.
function stateReading(node) {
  if (!node) {
    return null;
  }
  return { source: node.$source ?? null, node };
}

// Why detection is not following navigation.state, for the apps to explain.
function describeStateIssue(reading, freshValue) {
  const value = reading?.node?.value;
  if (!reading || value === undefined) {
    return { reason: 'absent' };
  }
  const detail = { source: reading.source, value, updatedAt: reading.node.timestamp ?? null };
  if (value === null) {
    return { reason: 'pending', ...detail };
  }
  return { reason: freshValue === undefined ? 'stale' : 'unrecognised', ...detail };
}

function createSpeedTracker({ underwaySpeed, stoppedSpeed }) {
  const samples = [];
  let motion = 'unknown';
  // Contiguous streaks of raw samples, used to date and place transitions more
  // precisely than the averaged or autostate decision can.
  let lastStill = null;
  let leftStillAt = null;
  let stillSince = null;

  function prune(now) {
    while (samples.length > 0 && samples[0].time < now - SPEED_WINDOW_MS) {
      samples.shift();
    }
  }

  return {
    observe(time, sog, position) {
      samples.push({ time, sog });
      const point = { time, position };
      if (sog < stoppedSpeed) {
        lastStill = point;
        leftStillAt = null;
        stillSince = stillSince ?? point;
      } else {
        leftStillAt = leftStillAt ?? point;
        stillSince = null;
      }
    },

    motion(now) {
      prune(now);
      if (samples.length === 0) {
        motion = 'unknown';
      } else if (samples.length >= MIN_SPEED_SAMPLES) {
        const mean = samples.reduce((sum, sample) => sum + sample.sog, 0) / samples.length;
        if (mean >= underwaySpeed) {
          motion = 'underway';
        } else if (mean < stoppedSpeed) {
          motion = 'stopped';
        }
      }
      return motion;
    },

    departure(now) {
      if (!leftStillAt || now - leftStillAt.time > MAX_REFINEMENT_AGE_MS) {
        return null;
      }
      const berth = lastStill && now - lastStill.time <= MAX_REFINEMENT_AGE_MS ? lastStill : null;
      return { time: leftStillAt.time, position: berth?.position ?? leftStillAt.position };
    },

    arrival(now) {
      return stillSince && now - stillSince.time <= MAX_REFINEMENT_AGE_MS ? stillSince : null;
    }
  };
}

function createPassageDetector({ db, readSelfPath, settings, clock = Date.now }) {
  const readFresh = createFreshnessTracker(readSelfPath);
  const underwaySpeed = settings.fallbackUnderwaySpeed * METRES_PER_SECOND_PER_KNOT;
  const speeds = createSpeedTracker({ underwaySpeed, stoppedSpeed: underwaySpeed / 2 });
  const closureMs = settings.stopClosureMinutes * 60 * 1000;
  const observations = createObservationRecorder({ db, readSelfPath, readFresh, settings });
  const propulsion = createPropulsionTracker({
    db,
    readSelfPath,
    readFresh,
    settings,
    observations
  });

  let mode = 'fallback';
  let stateIssue = { reason: 'absent' };
  let motion = 'unknown';
  let propulsionType = null;
  let resumed = false;

  const activeEntry = () => db.prepare("SELECT * FROM log_entries WHERE state = 'active'").get();

  function storedEnd(entry) {
    return toPosition(entry.end_lat, entry.end_lon);
  }

  function sense(now) {
    const position = readFresh('navigation.position', now);
    const current =
      position && Number.isFinite(position.latitude) && Number.isFinite(position.longitude)
        ? { lat: position.latitude, lon: position.longitude }
        : null;

    const sog = readFresh('navigation.speedOverGround', now);
    if (typeof sog === 'number' && Number.isFinite(sog)) {
      speeds.observe(now, sog, current);
    }

    observations.sense(now);
    const reading = stateReading(readSelfPath('navigation.state'));
    const navigationState = reading
      ? readFresh(
          `navigation.state@${reading.source}`,
          now,
          MAX_AGE_MS['navigation.state'],
          reading.node
        )
      : undefined;
    const fromState = classifyState(navigationState);
    mode = fromState ? 'autostate' : 'fallback';
    stateIssue = fromState ? null : describeStateIssue(reading, navigationState);
    return {
      motion: fromState ?? speeds.motion(now),
      position: current,
      propulsion: propulsion.sense(now, navigationState)
    };
  }

  // When a stopped passage gets going again, it resumed when raw speed left
  // standstill, not when the averaged or autostate decision caught up.
  function resumeTime(entry, now) {
    const moving = speeds.departure(now);
    const stoppedAt = Date.parse(entry.stopped_since);
    return moving && moving.time > stoppedAt ? moving.time : now;
  }

  function recordMovement(entry, now, position, { force = false } = {}) {
    const last = entry.last_moving_at === null ? null : Date.parse(entry.last_moving_at);
    if (!force && last !== null && now - last < HEARTBEAT_INTERVAL_MS) {
      return;
    }
    const at = position ?? storedEnd(entry);
    db.prepare(
      `UPDATE log_entries
       SET last_moving_at = ?, end_lat = ?, end_lon = ?, stopped_since = NULL, updated_at = ?
       WHERE id = ?`
    ).run(iso(now), at ? at.lat : null, at ? at.lon : null, iso(now), entry.id);
  }

  function markStopped(entry, { time, position }, now) {
    const at = position ?? storedEnd(entry);
    const stoppedAt = time < entry.start_time ? entry.start_time : time;
    db.prepare(
      `UPDATE log_entries SET stopped_since = ?, end_lat = ?, end_lon = ?, updated_at = ?
       WHERE id = ?`
    ).run(stoppedAt, at ? at.lat : null, at ? at.lon : null, iso(now), entry.id);
    return activeEntry();
  }

  function arrivalOf(entry, now, position) {
    const still = speeds.arrival(now);
    if (still && iso(still.time) >= entry.start_time) {
      return { time: iso(still.time), position: still.position ?? position };
    }
    // Without a speed streak, the last recorded movement is the best bound.
    return { time: entry.last_moving_at ?? iso(now), position: storedEnd(entry) ?? position };
  }

  // Returns what the tick reports about the closure. `late` means the plugin was
  // not running at the arrival: current conditions say nothing about it.
  function closePassage(entry, now, { late = false } = {}) {
    // A name the crew typed before arrival is kept as it is.
    const place =
      entry.end_place_name === null
        ? initialPlaceName(db, storedEnd(entry), settings.placeMatchRadius)
        : { id: entry.end_place_id, name: entry.end_place_name, pending: entry.end_place_pending };
    db.prepare(
      `UPDATE log_entries
       SET state = 'closed', end_time = stopped_since, stopped_since = NULL,
           end_place_id = ?, end_place_name = ?, end_place_pending = ?, closed_by = 'detection',
           updated_at = ?
       WHERE id = ?`
    ).run(place.id, place.name, place.pending, iso(now), entry.id);
    return { id: entry.id, endTime: entry.stopped_since, late };
  }

  // A departure soon after detection closed the last passage carries it on:
  // the stop it ended at stays on its timeline as a stopover.
  function reopenPassage(entry, now, position) {
    recordStopover(db, entry, iso(now));
    db.prepare(
      `UPDATE log_entries
       SET state = 'active', end_time = NULL, closed_by = NULL, end_place_id = NULL,
           end_place_name = NULL, end_place_pending = 0, updated_at = ?
       WHERE id = ?`
    ).run(iso(now), entry.id);
    // A cast-off can reopen a passage later than the mail window (SPEC §4.3),
    // so a summary may already have gone out. Forget it: the passage is not
    // over, and the one that closes it is the one worth sending (SPEC §4.16).
    db.prepare('DELETE FROM passage_summary_mails WHERE entry_id = ?').run(entry.id);
    recordMovement(activeEntry(), now, position, { force: true });
  }

  function openPassage(now, position, departure) {
    const startIso = iso(departure.time);
    // Only a passage that actually precedes this departure can push it later
    // -- not just whichever entry happens to hold the latest end_time. A
    // retrospective replay filling a gap before passages logged live (SPEC
    // §4.10) would otherwise have every reconstructed departure clamped to
    // the most recent (unrelated, later) passage's end.
    const previousEnd = db
      .prepare('SELECT MAX(end_time) AS endTime FROM log_entries WHERE start_time < ?')
      .get(startIso).endTime;
    const startTime = previousEnd && startIso < previousEnd ? previousEnd : startIso;
    const start = departure.position ?? position;
    const place = initialPlaceName(db, start, settings.placeMatchRadius);

    const { lastInsertRowid } = db
      .prepare(
        `INSERT INTO log_entries (
         state, start_time, start_lat, start_lon, start_place_id, start_place_name,
         start_place_pending, last_moving_at, end_lat, end_lon, created_at, updated_at
       ) VALUES ('active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        startTime,
        start ? start.lat : null,
        start ? start.lon : null,
        place.id,
        place.name,
        place.pending,
        iso(now),
        position ? position.lat : null,
        position ? position.lon : null,
        iso(now),
        iso(now)
      );
    const entryId = Number(lastInsertRowid);
    crew.copyCrewFromPreviousEntry(db, entryId, iso(now));
    return entryId;
  }

  function step(now, current, position, previous) {
    let entry = activeEntry();
    let resumedAt = null;
    let opened = null;
    let reopened = null;
    let closed = null;

    // A passage left open across a restart with no movement recorded for longer
    // than the tolerance ended while the plugin was not running — typically
    // power switched off on arrival.
    if (!resumed) {
      resumed = true;
      if (entry && entry.stopped_since === null) {
        const lastMoving = entry.last_moving_at ?? entry.start_time;
        if (now - Date.parse(lastMoving) >= closureMs) {
          entry = markStopped(entry, { time: lastMoving, position: storedEnd(entry) }, now);
          closed = closePassage(entry, now, { late: true });
          entry = null;
        }
      }
    }

    if (entry && entry.stopped_since === null) {
      if (current === 'underway') {
        recordMovement(entry, now, position);
      } else if (current === 'stopped') {
        // Closed as soon as the vessel stops; moving again soon reopens it.
        entry = markStopped(entry, arrivalOf(entry, now, position), now);
        closed = closePassage(entry, now);
        entry = null;
      }
    }

    // Still stopped while active: a passage the crew opened by casting off,
    // not under way yet (or one a previous version left waiting out its stop).
    if (entry && entry.stopped_since !== null) {
      const stoppedFor = now - Date.parse(entry.stopped_since);
      if (stoppedFor >= closureMs) {
        closed = closePassage(entry, now, {
          late: stoppedFor > closureMs + LATE_CLOSURE_MARGIN_MS
        });
        entry = null;
      } else if (current === 'underway') {
        resumedAt = resumeTime(entry, now);
        recordMovement(entry, now, position, { force: true });
      }
    }

    // Only a transition opens a passage: an entry closed by hand while still
    // moving must not be reopened on the next tick.
    if (!entry && current === 'underway' && previous !== 'underway') {
      const departure = speeds.departure(now) ?? { time: now, position };
      const previousEntry = reopenableEntry(db, iso(departure.time), closureMs);
      if (previousEntry) {
        reopenPassage(previousEntry, now, position);
        resumedAt = departure.time;
        reopened = previousEntry.id;
      } else {
        opened = openPassage(now, position, departure);
      }
    }

    return { resumedAt, opened, reopened, closed };
  }

  return {
    tick() {
      const now = clock();
      const sensed = sense(now);
      const previous = motion;
      withTransaction(db, () => {
        const outcome = step(now, sensed.motion, sensed.position, previous);
        propulsion.reconcile(now, sensed.propulsion, outcome);
        observations.afterDetection(now, outcome);
      });
      motion = sensed.motion;
      propulsionType = motion === 'underway' ? sensed.propulsion.type : null;
      return {
        mode,
        motion,
        propulsion: propulsionType,
        activeEntryId: activeEntry()?.id ?? null
      };
    },
    mode: () => mode,
    stateIssue: () => stateIssue,
    motion: () => motion,
    propulsion: () => propulsionType,
    observeEvent: (entryId, time) => observations.recordEvent(entryId, time, clock()),
    noteDeparture: (entryId) => observations.noteDeparture(entryId, clock())
  };
}

module.exports = {
  MAX_AGE_MS,
  METRES_PER_SECOND_PER_KNOT,
  UNDERWAY_STATES,
  createFreshnessTracker,
  createPassageDetector,
  DETECTION_DEFAULTS,
  MAX_REFINEMENT_AGE_MS,
  TICK_INTERVAL_MS
};

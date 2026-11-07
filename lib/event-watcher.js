const { createFreshnessTracker } = require('./detection');
const { activeEntryId, entryNearArrival } = require('./entries');
const { CRITICAL_STATES } = require('./events');

const METRES_PER_SECOND_PER_KNOT = 1852 / 3600;

const EVENT_DEFAULTS = {
  alarmsEnabled: true,
  ignoredAlarms: [],
  windSpeedThresholds: [20, 30],
  pressureDropThreshold: 4,
  headingChangeEnabled: true,
  headingChangeThreshold: 30,
  headingChangeTolerance: 10,
  headingChangeHoldSeconds: 60,
  headingChangeMinSpeed: 2,
  headingChangeCooldownMinutes: 5
};

const CHECK_INTERVAL_MS = 1000;
const NOTIFICATION_METADATA_KEYS = new Set([
  'meta',
  'values',
  '$source',
  'timestamp',
  'pgn',
  'sentence'
]);

// `standby` and `off-line` are the Signal K ones; `off` and `disabled` come from autopilots with an
// enabled/disabled state, which has no engaged flag of its own.
const DISENGAGED_AUTOPILOT_STATES = new Set(['standby', 'off', 'off-line', 'disabled']);

const POSITION_MAX_AGE_MS = 2 * 60 * 1000;
// Thresholds compare the average over this window, so a gust does not count.
const WIND_WINDOW_MS = 2 * 60 * 1000;
const MIN_WIND_COVERAGE_MS = 60 * 1000;
const WIND_MAX_AGE_MS = 2 * 60 * 1000;
const PRESSURE_WINDOW_MS = 3 * 60 * 60 * 1000;
const PRESSURE_SAMPLE_INTERVAL_MS = 60 * 1000;
const PRESSURE_MAX_AGE_MS = 15 * 60 * 1000;

// Heading, like the same reading elsewhere (track-recorder.js): current
// within this age, magnetic variation allowed to lag further behind.
const HEADING_MAX_AGE_MS = 2 * 60 * 1000;
const VARIATION_MAX_AGE_MS = 15 * 60 * 1000;

function iso(ms) {
  return new Date(ms).toISOString();
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function toRadians(degrees) {
  return (degrees * Math.PI) / 180;
}

function normalizeAngle(radians) {
  return ((radians % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
}

function headingDifference(a, b) {
  const diff = Math.abs(a - b) % (2 * Math.PI);
  return diff > Math.PI ? 2 * Math.PI - diff : diff;
}

// The mean of a set of headings, around the compass rather than along a line
// -- so 350° and 010° average to 000°, not 180°.
function circularMean(headings) {
  const sumSin = headings.reduce((sum, heading) => sum + Math.sin(heading), 0);
  const sumCos = headings.reduce((sum, heading) => sum + Math.cos(heading), 0);
  return normalizeAngle(Math.atan2(sumSin, sumCos));
}

function collectNotifications(node, path, found, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 12) {
    return;
  }
  if ('value' in node) {
    const { value } = node;
    if (value === null || (typeof value === 'object' && typeof value.state === 'string')) {
      found.set(path, value);
    }
    return;
  }
  for (const [key, child] of Object.entries(node)) {
    if (!NOTIFICATION_METADATA_KEYS.has(key)) {
      collectNotifications(child, `${path}.${key}`, found, depth + 1);
    }
  }
}

// A pattern names a notification path, `*` standing for any run of
// characters (dots included); the leading `notifications.` may be left out.
function compileAlarmPattern(pattern) {
  const trimmed = String(pattern).trim();
  if (trimmed === '') {
    return null;
  }
  const full = trimmed.startsWith('notifications.') ? trimmed : `notifications.${trimmed}`;
  const source = full
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${source}$`);
}

function createAlarmFilter(patterns) {
  const compiled = (patterns ?? []).map(compileAlarmPattern).filter(Boolean);
  return (path) => compiled.some((pattern) => pattern.test(path));
}

function createEventWatcher({ db, readSelfPath, settings, observe, clock = Date.now }) {
  const readFresh = createFreshnessTracker(readSelfPath);
  const alarmsEnabled = settings.alarmsEnabled ?? EVENT_DEFAULTS.alarmsEnabled;
  const isIgnoredAlarm = createAlarmFilter(settings.ignoredAlarms);

  const seenNotifications = new Map();
  const loggedNotifications = new Map();
  let autopilot = null;
  const windSamples = [];
  const windAbove = new Map();
  const pressureSamples = [];
  let pressureFalling = false;
  // The last confirmed heading, and the run of samples building towards the
  // next one; both null until the vessel is under way with a fresh heading.
  let headingRef = null;
  let headingCandidate = null;
  let lastHeadingChangeAt = undefined;

  // An anchor alarm goes off between passages, at the last one's destination.
  function entryFor(type, position) {
    const active = activeEntryId(db);
    if (active !== null || type === 'autopilot' || type === 'heading_change') {
      return active;
    }
    return entryNearArrival(db, position);
  }

  function logEvent(cycle, type, subtype, { comment = null, payload, snapshot }) {
    const entryId = entryFor(type, cycle.position);
    if (entryId === null) {
      return false;
    }
    const time = iso(cycle.now);
    db.prepare(
      `INSERT INTO events (entry_id, time, type, subtype, lat, lon, comment, payload, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'auto', ?)`
    ).run(
      entryId,
      time,
      type,
      subtype,
      cycle.position ? cycle.position.lat : null,
      cycle.position ? cycle.position.lon : null,
      comment,
      JSON.stringify(payload),
      time
    );
    if (snapshot) {
      cycle.snapshots.add(entryId);
    }
    return true;
  }

  // What was last written for a notification, read from the log the first
  // time it is seen, so a restart neither repeats an alarm nor forgets that
  // one was open.
  function lastLoggedState(path) {
    if (!loggedNotifications.has(path)) {
      const row = db
        .prepare(
          `SELECT payload FROM events WHERE type = 'sk_alarm' AND subtype = ?
           ORDER BY time DESC, id DESC LIMIT 1`
        )
        .get(path);
      loggedNotifications.set(path, row ? JSON.parse(row.payload).state : null);
    }
    return loggedNotifications.get(path);
  }

  function checkNotifications(cycle) {
    const current = new Map();
    collectNotifications(readSelfPath('notifications'), 'notifications', current);
    for (const path of seenNotifications.keys()) {
      if (!current.has(path)) {
        current.set(path, null);
      }
    }

    for (const [path, value] of current) {
      const state = value?.state ?? 'normal';
      if (seenNotifications.get(path) === state) {
        continue;
      }
      seenNotifications.set(path, state);

      const logged = lastLoggedState(path);
      const critical = CRITICAL_STATES.has(state);
      // Alarms turned off, or this one left out, are not raised in the log;
      // one already logged is still closed when it clears, so no raise is
      // left without its end.
      if (critical && (!alarmsEnabled || isIgnoredAlarm(path))) {
        continue;
      }
      // Log a critical state not yet logged, or the end of one that was; a
      // clearing whose alarm never made it into the log is not news.
      const worthLogging = critical ? logged !== state : CRITICAL_STATES.has(logged);
      if (!worthLogging) {
        continue;
      }
      const message = value?.message ?? null;
      if (
        logEvent(cycle, 'sk_alarm', path, {
          comment: message,
          payload: { state, message },
          snapshot: critical
        })
      ) {
        loggedNotifications.set(path, state);
      }
    }
  }

  function readAutopilotTarget() {
    const target = readSelfPath('steering.autopilot.target')?.value;
    if (isFiniteNumber(target)) {
      return target;
    }
    const byKind = {};
    for (const kind of ['headingTrue', 'headingMagnetic', 'windAngleApparent', 'windAngleTrue']) {
      const value = readSelfPath(`steering.autopilot.target.${kind}`)?.value;
      if (isFiniteNumber(value)) {
        byKind[kind] = value;
      }
    }
    return Object.keys(byKind).length > 0 ? byKind : null;
  }

  // The Autopilot API publishes `engaged`; older autopilot plugins only a
  // state such as auto, wind or standby.
  function readAutopilot() {
    const state = readSelfPath('steering.autopilot.state')?.value;
    const mode = readSelfPath('steering.autopilot.mode')?.value;
    const engagedValue = readSelfPath('steering.autopilot.engaged')?.value;

    let engaged = typeof engagedValue === 'boolean' ? engagedValue : null;
    if (engaged === null && typeof state === 'string' && state !== 'alarm') {
      engaged = !DISENGAGED_AUTOPILOT_STATES.has(state);
    }
    // No state at all, but a mode saying the pilot is off.
    if (engaged === null && mode === 'off') {
      engaged = false;
    }
    if (engaged === null) {
      return null;
    }
    return {
      engaged,
      mode: typeof mode === 'string' ? mode : null,
      state: typeof state === 'string' ? state : null
    };
  }

  function checkAutopilot(cycle) {
    const pilot = readAutopilot();
    if (!pilot) {
      return;
    }
    const activity = pilot.mode ?? pilot.state;
    const previous = autopilot;
    autopilot = { engaged: pilot.engaged, activity };

    let subtype = null;
    if (previous === null) {
      const last = db
        .prepare(
          "SELECT subtype FROM events WHERE type = 'autopilot' ORDER BY time DESC, id DESC LIMIT 1"
        )
        .get();
      if (pilot.engaged && (!last || last.subtype === 'disengaged')) {
        subtype = 'engaged';
      } else if (!pilot.engaged && last && last.subtype !== 'disengaged') {
        subtype = 'disengaged';
      }
    } else if (pilot.engaged !== previous.engaged) {
      subtype = pilot.engaged ? 'engaged' : 'disengaged';
    } else if (pilot.engaged && activity !== previous.activity) {
      subtype = 'mode_changed';
    }

    if (subtype) {
      // The last target lingers in the data model after disengaging.
      const target = pilot.engaged ? readAutopilotTarget() : null;
      logEvent(cycle, 'autopilot', subtype, {
        payload: { mode: pilot.mode, state: pilot.state, target },
        snapshot: true
      });
    }
  }

  function checkWind(cycle) {
    const speed = readFresh('environment.wind.speedTrue', cycle.now, WIND_MAX_AGE_MS);
    if (isFiniteNumber(speed)) {
      windSamples.push({ time: cycle.now, speed });
    }
    while (windSamples.length > 0 && windSamples[0].time <= cycle.now - WIND_WINDOW_MS) {
      windSamples.shift();
    }
    if (windSamples.length === 0 || cycle.now - windSamples[0].time < MIN_WIND_COVERAGE_MS) {
      return;
    }
    const mean = windSamples.reduce((sum, sample) => sum + sample.speed, 0) / windSamples.length;

    for (const knots of settings.windSpeedThresholds) {
      const threshold = knots * METRES_PER_SECOND_PER_KNOT;
      const clearsBelow = threshold - Math.max(2 * METRES_PER_SECOND_PER_KNOT, 0.1 * threshold);
      const wasAbove = windAbove.get(knots);
      let isAbove = wasAbove;
      if (mean >= threshold) {
        isAbove = true;
      } else if (mean < clearsBelow) {
        isAbove = false;
      }
      if (isAbove === undefined) {
        continue;
      }
      windAbove.set(knots, isAbove);
      // The first reading only sets where the wind stands: strong wind already
      // blowing when the plugin starts is a condition, not a crossing.
      if (wasAbove !== undefined && wasAbove !== isAbove) {
        logEvent(cycle, 'weather_threshold', isAbove ? 'wind_above' : 'wind_below', {
          payload: { threshold, windSpeed: mean },
          snapshot: true
        });
      }
    }
  }

  function checkPressure(cycle) {
    if (!settings.pressureDropThreshold) {
      return;
    }
    const pressure = readFresh('environment.outside.pressure', cycle.now, PRESSURE_MAX_AGE_MS);
    const latest = pressureSamples.at(-1);
    if (
      isFiniteNumber(pressure) &&
      (!latest || cycle.now - latest.time >= PRESSURE_SAMPLE_INTERVAL_MS)
    ) {
      pressureSamples.push({ time: cycle.now, pressure });
    }
    while (
      pressureSamples.length > 1 &&
      pressureSamples[1].time <= cycle.now - PRESSURE_WINDOW_MS
    ) {
      pressureSamples.shift();
    }

    const current = pressureSamples.at(-1);
    const reference = pressureSamples[0];
    if (
      !current ||
      cycle.now - current.time > PRESSURE_MAX_AGE_MS ||
      current.time - reference.time < PRESSURE_WINDOW_MS
    ) {
      return;
    }

    const drop = reference.pressure - current.pressure;
    const threshold = settings.pressureDropThreshold * 100;
    if (!pressureFalling && drop >= threshold) {
      pressureFalling = true;
      logEvent(cycle, 'weather_threshold', 'pressure_drop', {
        payload: { drop, over: PRESSURE_WINDOW_MS / 1000, pressure: current.pressure },
        snapshot: true
      });
    } else if (pressureFalling && drop < threshold / 2) {
      pressureFalling = false;
    }
  }

  // Read once, the first time it is needed, from the log itself -- so a
  // restart neither forgets the cooldown nor logs a change too soon after one
  // made just before it stopped.
  function lastHeadingChangeTime() {
    if (lastHeadingChangeAt === undefined) {
      const row = db
        .prepare(
          "SELECT time FROM events WHERE type = 'heading_change' ORDER BY time DESC, id DESC LIMIT 1"
        )
        .get();
      lastHeadingChangeAt = row ? Date.parse(row.time) : null;
    }
    return lastHeadingChangeAt;
  }

  function readHeading(now) {
    const headingTrue = readFresh('navigation.headingTrue', now, HEADING_MAX_AGE_MS);
    if (isFiniteNumber(headingTrue)) {
      return headingTrue;
    }
    const headingMagnetic = readFresh('navigation.headingMagnetic', now, HEADING_MAX_AGE_MS);
    const variation = readFresh('navigation.magneticVariation', now, VARIATION_MAX_AGE_MS);
    return isFiniteNumber(headingMagnetic) && isFiniteNumber(variation)
      ? normalizeAngle(headingMagnetic + variation)
      : null;
  }

  // A change counts once it is at least headingChangeThreshold away from the
  // last logged heading and holds there, within headingChangeTolerance, for
  // headingChangeHoldSeconds; the average over that hold is what gets logged
  // (SPEC §4.6). Below headingChangeMinSpeed, course over ground is noise, so
  // a turn is neither started nor kept building.
  function checkHeadingChange(cycle) {
    if (!settings.headingChangeEnabled) {
      return;
    }
    const sog = readFresh('navigation.speedOverGround', cycle.now);
    const minSpeed = settings.headingChangeMinSpeed * METRES_PER_SECOND_PER_KNOT;
    if (!isFiniteNumber(sog) || sog < minSpeed) {
      headingCandidate = null;
      return;
    }
    const heading = readHeading(cycle.now);
    if (heading === null) {
      return;
    }
    // The first reading under way only sets where the vessel is heading, not
    // a change from some earlier, unrelated course.
    if (headingRef === null) {
      headingRef = heading;
      return;
    }

    const thresholdRad = toRadians(settings.headingChangeThreshold);
    const toleranceRad = toRadians(settings.headingChangeTolerance);

    if (!headingCandidate) {
      if (headingDifference(heading, headingRef) >= thresholdRad) {
        headingCandidate = { start: cycle.now, headings: [heading] };
      }
      return;
    }

    const candidateMean = circularMean(headingCandidate.headings);
    if (headingDifference(heading, candidateMean) > toleranceRad) {
      // Still swinging, or swinging back: start a fresh candidate if it is
      // still far enough from the reference to be a change in the making,
      // else drop it -- back within the reference is not a change at all.
      headingCandidate =
        headingDifference(heading, headingRef) >= thresholdRad
          ? { start: cycle.now, headings: [heading] }
          : null;
      return;
    }

    headingCandidate.headings.push(heading);
    if (cycle.now - headingCandidate.start < settings.headingChangeHoldSeconds * 1000) {
      return;
    }

    const confirmed = circularMean(headingCandidate.headings);
    const previousHeading = headingRef;
    headingRef = confirmed;
    headingCandidate = null;

    const last = lastHeadingChangeTime();
    if (last !== null && cycle.now - last < settings.headingChangeCooldownMinutes * 60 * 1000) {
      return;
    }
    if (
      logEvent(cycle, 'heading_change', null, {
        payload: { heading: confirmed, previousHeading },
        snapshot: true
      })
    ) {
      lastHeadingChangeAt = cycle.now;
    }
  }

  return {
    check() {
      const now = clock();
      const fix = readFresh('navigation.position', now, POSITION_MAX_AGE_MS);
      const position =
        fix && Number.isFinite(fix.latitude) && Number.isFinite(fix.longitude)
          ? { lat: fix.latitude, lon: fix.longitude }
          : null;
      const cycle = { now, position, snapshots: new Set() };

      checkNotifications(cycle);
      checkAutopilot(cycle);
      checkWind(cycle);
      checkPressure(cycle);
      checkHeadingChange(cycle);

      for (const entryId of cycle.snapshots) {
        observe(entryId, iso(now));
      }
    }
  };
}

module.exports = { createEventWatcher, createAlarmFilter, EVENT_DEFAULTS, CHECK_INTERVAL_MS };

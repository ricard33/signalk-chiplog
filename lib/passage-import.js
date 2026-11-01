const { withTransaction } = require('./database');
const { badRequest, conflict } = require('./errors');
const { getEntry, recomputeDurations } = require('./entries');
const { initialPlaceName } = require('./place-names');
const { distanceBetween, findNearestPlace } = require('./places');

const TRACK_READINGS = ['sog', 'cog', 'stw', 'heading', 'tws', 'twd', 'aws', 'awa'];
// [column, request field]
const OBSERVATION_READINGS = [
  ...TRACK_READINGS.map((reading) => [reading, reading]),
  ['depth', 'depth'],
  ['pressure', 'pressure'],
  ['air_temp', 'airTemp'],
  ['water_temp', 'waterTemp'],
  ['trip_log', 'tripLog'],
  ['engine_runtime', 'engineRuntime']
];

// An anchorage is not left at the same spot twice: a place of the same name this close
// is the same place, though further than the matching radius.
const SAME_NAME_REACH_METRES = 500;

// A passage recorded elsewhere is only ever added next to the ones on record,
// never on top of them: the vessel was in one place at a time, so an overlap
// means the passage is already there, or that one of the two is wrong.
function requireNoOverlap(db, startTime, endTime) {
  const clash = db
    .prepare(
      `SELECT id FROM log_entries
       WHERE start_time < ? AND COALESCE(end_time, '9999-12-31T23:59:59.999Z') > ?
       ORDER BY start_time LIMIT 1`
    )
    .get(endTime, startTime);
  if (clash) {
    throw conflict('entry_overlaps', `The passage overlaps entry ${clash.id} already on record`);
  }
}

// The name comes from the source, so it is kept as given; the position is tied
// to a known place when there is one in reach, or made into one, so a later
// departure from the same spot is named the same way. Without a name it is
// named as a passage detected live would be.
function resolvePlace(db, position, name, radius, now) {
  if (!position) {
    return { id: null, name: name ?? null, pending: 0 };
  }
  if (name === null || name === undefined) {
    return initialPlaceName(db, position, radius);
  }
  const known =
    findNearestPlace(db, position, radius) ??
    db
      .prepare('SELECT * FROM places WHERE name = ? COLLATE NOCASE')
      .all(name)
      .find((place) => distanceBetween(position, place) <= SAME_NAME_REACH_METRES);
  if (known) {
    return { id: known.id, name, pending: 0 };
  }
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO places (name, lat, lon, source, created_at, updated_at)
       VALUES (?, ?, ?, 'manual', ?, ?)`
    )
    .run(name, position.lat, position.lon, now, now);
  return { id: Number(lastInsertRowid), name, pending: 0 };
}

function requireWithin(startTime, endTime, time, name) {
  if (time < startTime || time > endTime) {
    throw badRequest(`${name} must fall between startTime and endTime`);
  }
}

function trackDistance(points) {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    total += distanceBetween(points[i - 1], points[i]);
  }
  return total;
}

// Adds a finished passage recorded elsewhere -- another logbook's export --
// with its track, instrument readings and engine/sail periods. All or nothing.
// Unlike anything detection writes, its `closed_by` stays empty, so a departure
// soon after it never reopens it. Without a `distance`, the passage's is the
// sum over its track, as it is for one logged live.
function importPassage(db, input, { placeMatchRadius, now }) {
  const { startTime, endTime } = input;
  if (endTime < startTime) {
    throw badRequest('endTime must not be earlier than startTime');
  }
  input.trackPoints.forEach((point, index) =>
    requireWithin(startTime, endTime, point.time, `trackPoints[${index}].time`)
  );
  input.observations.forEach((observation, index) =>
    requireWithin(startTime, endTime, observation.time, `observations[${index}].time`)
  );
  input.propulsion.forEach((segment, index) => {
    requireWithin(startTime, endTime, segment.startTime, `propulsion[${index}].startTime`);
    requireWithin(startTime, endTime, segment.endTime, `propulsion[${index}].endTime`);
    if (segment.endTime < segment.startTime) {
      throw badRequest(`propulsion[${index}].endTime must not be earlier than its startTime`);
    }
  });

  return withTransaction(db, () => {
    requireNoOverlap(db, startTime, endTime);

    const start = resolvePlace(
      db,
      input.startPosition,
      input.startPlaceName,
      placeMatchRadius,
      now
    );
    const end = resolvePlace(db, input.endPosition, input.endPlaceName, placeMatchRadius, now);
    const { lastInsertRowid } = db
      .prepare(
        `INSERT INTO log_entries (
           state, start_time, end_time, start_lat, start_lon, end_lat, end_lon,
           start_place_id, end_place_id, start_place_name, end_place_name,
           start_place_pending, end_place_pending, distance, start_tanks, start_batteries, end_tanks,
           created_at, updated_at
         ) VALUES ('closed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        startTime,
        endTime,
        input.startPosition?.lat ?? null,
        input.startPosition?.lon ?? null,
        input.endPosition?.lat ?? null,
        input.endPosition?.lon ?? null,
        start.id,
        end.id,
        start.name,
        end.name,
        start.pending,
        end.pending,
        input.distance ?? trackDistance(input.trackPoints),
        input.startTanks.length > 0 ? JSON.stringify(input.startTanks) : null,
        input.startBatteries.length > 0 ? JSON.stringify(input.startBatteries) : null,
        (input.endTanks ?? []).length > 0 ? JSON.stringify(input.endTanks) : null,
        now,
        now
      );
    const entryId = Number(lastInsertRowid);

    const insertPoint = db.prepare(
      `INSERT INTO track_points (entry_id, time, lat, lon, ${TRACK_READINGS.join(', ')})
       VALUES (?, ?, ?, ?, ${TRACK_READINGS.map(() => '?').join(', ')})`
    );
    for (const point of input.trackPoints) {
      insertPoint.run(
        entryId,
        point.time,
        point.lat,
        point.lon,
        ...TRACK_READINGS.map((reading) => point[reading] ?? null)
      );
    }

    const insertObservation = db.prepare(
      `INSERT INTO observations (
         entry_id, time, reason, lat, lon, ${OBSERVATION_READINGS.map(([column]) => column).join(', ')}
       ) VALUES (?, ?, ?, ?, ?, ${OBSERVATION_READINGS.map(() => '?').join(', ')})`
    );
    for (const observation of input.observations) {
      insertObservation.run(
        entryId,
        observation.time,
        observation.reason,
        observation.position?.lat ?? null,
        observation.position?.lon ?? null,
        ...OBSERVATION_READINGS.map(([, field]) => observation[field] ?? null)
      );
    }

    const insertSegment = db.prepare(
      `INSERT INTO propulsion_segments (entry_id, type, start_time, end_time, source)
       VALUES (?, ?, ?, ?, 'auto')`
    );
    for (const segment of input.propulsion) {
      insertSegment.run(entryId, segment.type, segment.startTime, segment.endTime);
    }
    recomputeDurations(db, entryId, now);

    return getEntry(db, entryId);
  });
}

module.exports = { importPassage, TRACK_READINGS, OBSERVATION_READINGS };

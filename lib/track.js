const { requireEntryRow } = require('./entries');
const { notFound } = require('./errors');
const { toPosition, paginate } = require('./rows');

// A reading as the API promises it: a number, or null. SQLite keeps whatever it
// was given in a REAL column when that is not numeric text (`NaN`, an empty
// string), and one such value would make a client fail on the whole page.
function reading(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function toTrackPoint(row) {
  return {
    time: row.time,
    lat: reading(row.lat),
    lon: reading(row.lon),
    sog: reading(row.sog),
    cog: reading(row.cog),
    stw: reading(row.stw),
    heading: reading(row.heading),
    tws: reading(row.tws),
    twd: reading(row.twd),
    aws: reading(row.aws),
    awa: reading(row.awa)
  };
}

function toObservation(row) {
  return {
    id: row.id,
    time: row.time,
    reason: row.reason,
    position: toPosition(row.lat, row.lon),
    sog: reading(row.sog),
    cog: reading(row.cog),
    heading: reading(row.heading),
    stw: reading(row.stw),
    twd: reading(row.twd),
    tws: reading(row.tws),
    awa: reading(row.awa),
    aws: reading(row.aws),
    depth: reading(row.depth),
    pressure: reading(row.pressure),
    airTemp: reading(row.air_temp),
    waterTemp: reading(row.water_temp),
    tripLog: reading(row.trip_log),
    engineRuntime: reading(row.engine_runtime),
    engineRuntimes: row.engine_runtimes === null ? null : JSON.parse(row.engine_runtimes)
  };
}

function allTrackPoints(db, entryId) {
  return db
    .prepare('SELECT * FROM track_points WHERE entry_id = ? ORDER BY time, id')
    .all(entryId)
    .map(toTrackPoint);
}

function allObservations(db, entryId) {
  return db
    .prepare('SELECT * FROM observations WHERE entry_id = ? ORDER BY time, id')
    .all(entryId)
    .map(toObservation);
}

function listObservations(db, entryId, { limit, offset }) {
  requireEntryRow(db, entryId);
  return paginate(db, {
    table: 'observations',
    where: 'WHERE entry_id = ?',
    params: [entryId],
    orderBy: 'time, id',
    limit,
    offset,
    map: toObservation
  });
}

function deleteObservation(db, id) {
  const { changes } = db.prepare('DELETE FROM observations WHERE id = ?').run(id);
  if (changes === 0) {
    throw notFound('observation', id);
  }
}

module.exports = { allTrackPoints, allObservations, listObservations, deleteObservation };

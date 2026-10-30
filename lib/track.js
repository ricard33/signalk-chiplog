const { requireEntryRow } = require('./entries');
const { notFound } = require('./errors');
const { toPosition, paginate } = require('./rows');

function toTrackPoint(row) {
  return {
    time: row.time,
    lat: row.lat,
    lon: row.lon,
    sog: row.sog,
    cog: row.cog,
    stw: row.stw,
    heading: row.heading,
    tws: row.tws,
    twd: row.twd,
    aws: row.aws,
    awa: row.awa
  };
}

function toObservation(row) {
  return {
    id: row.id,
    time: row.time,
    reason: row.reason,
    position: toPosition(row.lat, row.lon),
    sog: row.sog,
    cog: row.cog,
    heading: row.heading,
    stw: row.stw,
    twd: row.twd,
    tws: row.tws,
    awa: row.awa,
    aws: row.aws,
    depth: row.depth,
    pressure: row.pressure,
    airTemp: row.air_temp,
    waterTemp: row.water_temp,
    tripLog: row.trip_log,
    engineRuntime: row.engine_runtime,
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

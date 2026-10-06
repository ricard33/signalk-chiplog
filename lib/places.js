const { notFound } = require('./errors');

const EARTH_RADIUS_M = 6371008.8;

function toRadians(degrees) {
  return (degrees * Math.PI) / 180;
}

function distanceBetween(a, b) {
  const dLat = toRadians(b.lat - a.lat);
  const dLon = toRadians(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(a.lat)) * Math.cos(toRadians(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

function findNearestPlace(db, position, radius) {
  const latDelta = (radius / EARTH_RADIUS_M) * (180 / Math.PI);
  const cosLat = Math.cos(toRadians(position.lat));
  const lonDelta = cosLat > 1e-6 ? latDelta / cosLat : 360;
  // Near the antimeridian a longitude window would wrap; filtering on latitude
  // alone keeps the candidate set small and the distance test stays exact.
  const wraps = position.lon - lonDelta < -180 || position.lon + lonDelta > 180;

  const candidates = wraps
    ? db
        .prepare('SELECT * FROM places WHERE lat BETWEEN ? AND ?')
        .all(position.lat - latDelta, position.lat + latDelta)
    : db
        .prepare('SELECT * FROM places WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?')
        .all(
          position.lat - latDelta,
          position.lat + latDelta,
          position.lon - lonDelta,
          position.lon + lonDelta
        );

  let nearest = null;
  let nearestDistance = Infinity;
  for (const place of candidates) {
    const distance = distanceBetween(position, place);
    if (distance <= radius && distance < nearestDistance) {
      nearest = place;
      nearestDistance = distance;
    }
  }
  return nearest;
}

function toPlace(row) {
  return {
    id: row.id,
    name: row.name,
    position: { lat: row.lat, lon: row.lon },
    source: row.source,
    countryCode: row.country_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function requirePlaceRow(db, id) {
  const row = db.prepare('SELECT * FROM places WHERE id = ?').get(id);
  if (!row) {
    throw notFound('place', id);
  }
  return row;
}

const nameCollator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

// Sorted in JavaScript because SQLite's NOCASE only folds ASCII and would put
// "Île de Ré" after "Rochefort". A vessel's gazetteer stays small enough.
function listPlaces(db, { limit, offset }) {
  const rows = db.prepare('SELECT * FROM places').all();
  rows.sort((a, b) => nameCollator.compare(a.name, b.name) || a.id - b.id);
  return {
    total: rows.length,
    limit,
    offset,
    items: rows.slice(offset, offset + limit).map(toPlace)
  };
}

// A user-supplied name becomes authoritative for its surroundings: it updates
// the nearest known place within the radius, or creates one.
function rememberPlaceName(db, position, name, radius, now) {
  const nearest = findNearestPlace(db, position, radius);
  if (nearest) {
    db.prepare("UPDATE places SET name = ?, source = 'manual', updated_at = ? WHERE id = ?").run(
      name,
      now,
      nearest.id
    );
    return nearest.id;
  }
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO places (name, lat, lon, source, created_at, updated_at)
       VALUES (?, ?, ?, 'manual', ?, ?)`
    )
    .run(name, position.lat, position.lon, now, now);
  return Number(lastInsertRowid);
}

function renamePlace(db, id, name, now) {
  requirePlaceRow(db, id);
  db.prepare("UPDATE places SET name = ?, source = 'manual', updated_at = ? WHERE id = ?").run(
    name,
    now,
    id
  );
  return toPlace(requirePlaceRow(db, id));
}

function deletePlace(db, id) {
  requirePlaceRow(db, id);
  db.prepare('DELETE FROM places WHERE id = ?').run(id);
}

// Every place, oldest first: what the online backup sends (SPEC §4.17).
function allPlaces(db) {
  return db.prepare('SELECT * FROM places ORDER BY id').all().map(toPlace);
}

module.exports = {
  allPlaces,
  distanceBetween,
  findNearestPlace,
  listPlaces,
  rememberPlaceName,
  renamePlace,
  deletePlace
};

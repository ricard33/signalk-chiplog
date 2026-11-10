// Pure track-point helpers: no vendor imports, so plain Node can test them.

// A longitude moved by whole turns to sit within half a turn of `reference`.
const nearTo = (reference, lon) => lon + 360 * Math.round((reference - lon) / 360);

// The track's [lon, lat] coordinates with longitudes unwrapped, each kept on the
// side its predecessor was, so a passage across the antimeridian is one
// continuous line (they may leave [-180, 180]; Leaflet draws that on the
// neighbouring copy of the world) rather than a segment across the whole map.
export function unwrapCoordinates(coordinates) {
  let previous = null;
  return coordinates.map(([lon, lat]) => {
    previous = previous === null ? lon : nearTo(previous, lon);
    return [previous, lat];
  });
}

// `lon` moved onto the copy of the world the unwrapped `coordinates` lie on:
// the one nearest to the closest of them. For markers and the boat, which come
// with plain longitudes.
export function lonAlongTrack(coordinates, lat, lon) {
  let best = null;
  let bestDistance = Infinity;
  for (const [otherLon, otherLat] of coordinates) {
    const wrapped = Math.abs(nearTo(lon, otherLon) - lon);
    const distance = wrapped + Math.abs(otherLat - lat);
    if (distance < bestDistance) {
      best = otherLon;
      bestDistance = distance;
    }
  }
  return best === null ? lon : nearTo(best, lon);
}

// Flattens the track GeoJSON into one object per point, position and
// instrument readings together, for the passage page's position scrubber.
export function trackPoints(track) {
  const geometry = track?.geometry;
  if (!geometry) {
    return [];
  }
  const coordinates =
    geometry.type === 'Point'
      ? [geometry.coordinates]
      : geometry.type === 'LineString'
        ? geometry.coordinates
        : [];
  const times = track.properties?.coordTimes ?? [];
  const readings = track.properties?.readings ?? [];
  return coordinates.map(([lon, lat], index) => ({
    lat,
    lon,
    time: times[index] ?? null,
    ...readings[index]
  }));
}

// The true wind angle relative to the bow (positive to starboard, like the
// apparent wind angle already published), derived from the true wind
// direction and heading rather than stored: it needs no sensor of its own.
export function trueWindAngle(twd, heading) {
  return twd === null || twd === undefined || heading === null || heading === undefined
    ? null
    : twd - heading;
}

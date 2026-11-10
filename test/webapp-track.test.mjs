import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  trackPoints,
  trueWindAngle,
  unwrapCoordinates,
  lonAlongTrack
} from '../public/js/track.mjs';

describe('track points', () => {
  it('flattens a LineString with its coordTimes and readings', () => {
    const track = {
      geometry: {
        type: 'LineString',
        coordinates: [
          [-1.1522, 46.1591],
          [-1.3, 46.25]
        ]
      },
      properties: {
        coordTimes: ['2026-09-13T08:00:00.000Z', '2026-09-13T09:00:00.000Z'],
        readings: [
          { sog: null, cog: null, stw: null, tws: null, twd: null, awa: null, heading: null },
          { sog: 3.08, cog: 1.57, stw: 2.9, tws: 7.7, twd: 6.28, awa: -0.5, heading: 1.5 }
        ]
      }
    };

    assert.deepEqual(trackPoints(track), [
      {
        lat: 46.1591,
        lon: -1.1522,
        time: '2026-09-13T08:00:00.000Z',
        sog: null,
        cog: null,
        stw: null,
        tws: null,
        twd: null,
        awa: null,
        heading: null
      },
      {
        lat: 46.25,
        lon: -1.3,
        time: '2026-09-13T09:00:00.000Z',
        sog: 3.08,
        cog: 1.57,
        stw: 2.9,
        tws: 7.7,
        twd: 6.28,
        awa: -0.5,
        heading: 1.5
      }
    ]);
  });

  it('treats a single-point Point geometry as one point', () => {
    const track = {
      geometry: { type: 'Point', coordinates: [-1.1522, 46.1591] },
      properties: { coordTimes: ['2026-09-13T08:00:00.000Z'], readings: [{ sog: 0 }] }
    };

    assert.deepEqual(trackPoints(track), [
      { lat: 46.1591, lon: -1.1522, time: '2026-09-13T08:00:00.000Z', sog: 0 }
    ]);
  });

  it('is empty with no geometry', () => {
    assert.deepEqual(trackPoints({ geometry: null, properties: {} }), []);
    assert.deepEqual(trackPoints(null), []);
  });
});

describe('true wind angle', () => {
  it('is the true wind direction relative to heading', () => {
    assert.equal(trueWindAngle(1.5, 1.0), 0.5);
  });

  it('is null without both a wind direction and a heading', () => {
    assert.equal(trueWindAngle(null, 1.0), null);
    assert.equal(trueWindAngle(1.5, null), null);
    assert.equal(trueWindAngle(undefined, undefined), null);
  });
});

it('unwrapCoordinates keeps a track across the antimeridian continuous', () => {
  const line = unwrapCoordinates([
    [179.5, -17],
    [-179.8, -17.1],
    [-179, -17.2]
  ]);
  assert.deepEqual(
    line.map(([lon]) => lon),
    [179.5, 180.2, 181]
  );
  assert.equal(lonAlongTrack(line, -17.1, -179.8), 180.2);
  assert.equal(lonAlongTrack([], 0, 12), 12);
});

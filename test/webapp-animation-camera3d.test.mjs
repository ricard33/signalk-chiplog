import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  BOAT_SIZES,
  boatSizeById,
  cameraFrame,
  CAMERA_FRAMINGS,
  chasePose,
  DEFAULT_BOAT_SIZE_ID,
  DEFAULT_FRAMING_ID,
  distanceForZoom,
  EARTH_CIRCUMFERENCE,
  FIELD_OF_VIEW,
  frameOrigin,
  framing3d,
  framingById,
  groundFootprint,
  MAX_TILES,
  PITCH,
  toScene,
  visibleTiles3d
} from '../public/js/animation/camera3d.mjs';
import { TILE_SIZE, worldX } from '../public/js/animation/mercator.mjs';
import { buildLegs, buildStoryboard, stateAt } from '../public/js/animation/storyboard.mjs';
import { TILE_LAYERS } from '../public/js/animation/tiles.mjs';

const FRAME = { width: 1920, height: 1080 };
const HOUR = 3_600_000;
const DAY = Date.UTC(2026, 8, 14, 6, 0, 0);
const NORTH_EAST = Math.PI / 4;

function passage(id, startMs, hours, from, heading) {
  const count = hours * 6 + 1;
  const points = Array.from({ length: count }, (unused, i) => ({
    time: new Date(startMs + (i * hours * HOUR) / (count - 1)).toISOString(),
    lat: from.lat + i * 0.01,
    lon: from.lon + i * 0.01,
    sog: 3,
    cog: heading,
    heading
  }));
  return { entry: { id, startTime: points[0].time }, points };
}

const HOME = { lat: 46.15, lon: -1.15 };

describe('chase pose', () => {
  const legs = buildLegs(
    [passage(1, DAY, 2, HOME, NORTH_EAST), passage(2, DAY + 24 * HOUR, 2, { lat: 47, lon: -2 }, 3)],
    FRAME
  );
  const storyboard = buildStoryboard(legs);
  const options = { height: FRAME.height };

  it('is the map view’s own camera: the same target, north at the top', () => {
    const state = stateAt(storyboard, 1);
    const pose = chasePose(state, options);
    assert.equal(pose.target.lat, state.camera.centre.lat);
    assert.equal(pose.target.lon, state.camera.centre.lon);
    assert.equal(pose.bearing, 0);
    assert.equal(pose.pitch, PITCH);
  });

  it('stands south of the boat, above it, looking down and north', () => {
    const pose = chasePose(stateAt(storyboard, 1), options);
    const frame = cameraFrame(pose, 16 / 9);
    assert.ok(Math.abs(frame.position.x) < 1e-6);
    assert.ok(frame.position.z > 0 && frame.position.y > 0);
    assert.ok(frame.forward.z < 0 && frame.forward.y < 0);
    // Right is east, as on the map.
    assert.ok(frame.right.x > 0.99);
  });

  it('keeps north at the top whichever way the boat is heading', () => {
    for (const [index, heading] of [
      [0, NORTH_EAST],
      [1, 3]
    ]) {
      const leg = legs[index];
      const at = storyboard.segments.find(
        (segment) => segment.kind === 'leg' && segment.legIndex === index
      );
      const pose = chasePose(stateAt(storyboard, (at.startUnits + at.endUnits) / 2), options);
      assert.equal(pose.bearing, 0, `leg ${leg.entry.id} heading ${heading}`);
    }
  });

  it('shows the ground under the boat at the map view’s scale', () => {
    for (const zoom of [8, 11.5, 15]) {
      const distance = distanceForZoom(zoom, FRAME.height);
      // Mercator metres a pixel across the middle of the frame, as in the
      // renderer, against the map's own at that zoom.
      const here = (2 * distance * Math.tan(FIELD_OF_VIEW / 2)) / FRAME.height;
      const there = EARTH_CIRCUMFERENCE / (TILE_SIZE * 2 ** zoom);
      assert.ok(Math.abs(here - there) / there < 1e-9, `zoom ${zoom}`);
    }
  });

  it('follows the passage’s zoom while sailing', () => {
    const legStart = storyboard.segments.find((segment) => segment.kind === 'leg').startUnits;
    const first = stateAt(storyboard, legStart + 1);
    const pose = chasePose(first, options);
    assert.equal(pose.distance, distanceForZoom(legs[0].frame.zoom, FRAME.height));
  });

  it('is closer at a higher zoom, and further at a lower one', () => {
    assert.ok(distanceForZoom(14, 1080) < distanceForZoom(12, 1080));
    assert.ok(distanceForZoom(12, 1080, 0.5) < distanceForZoom(12, 1080));
    assert.ok(distanceForZoom(12, 1080, 2) > distanceForZoom(12, 1080));
  });

  it('flies with the map camera between legs, zoom and all', () => {
    const move = storyboard.segments.find((segment) => segment.kind === 'transition');
    const start = stateAt(storyboard, move.startUnits);
    const middle = stateAt(storyboard, (move.startUnits + move.endUnits) / 2);
    const pose = chasePose(middle, options);
    assert.equal(pose.target.lat, middle.camera.centre.lat);
    assert.equal(pose.distance, distanceForZoom(middle.camera.zoom, FRAME.height));
    assert.notDeepEqual(pose.target, chasePose(start, options).target);
  });

  it('is the same pose for the same frame', () => {
    assert.deepEqual(
      chasePose(stateAt(storyboard, 1.7), options),
      chasePose(stateAt(storyboard, 1.7), options)
    );
  });
});

describe('framings', () => {
  it('offers three, closest first, the map’s own in the middle, and falls back to it', () => {
    assert.deepEqual(
      CAMERA_FRAMINGS.map((option) => option.id),
      ['close', 'map', 'wide']
    );
    assert.equal(framingById('map').factor, 1);
    assert.ok(CAMERA_FRAMINGS[0].factor < 1 && CAMERA_FRAMINGS[2].factor > 1);
    assert.equal(framingById('nope').id, DEFAULT_FRAMING_ID);
    assert.equal(DEFAULT_FRAMING_ID, 'map');
  });
});

describe('scene coordinates', () => {
  it('puts the camera target at the origin and measures in Mercator metres', () => {
    const pose = { target: HOME, bearing: 0, pitch: PITCH, distance: 700 };
    const origin = frameOrigin(pose);
    const here = toScene(origin, HOME.lat, HOME.lon);
    assert.ok(Math.abs(here.x) < 1e-6 && Math.abs(here.z) < 1e-6);
    // One degree of longitude is a 360th of the equator, whatever the latitude.
    const east = toScene(origin, HOME.lat, HOME.lon + 1);
    assert.ok(Math.abs(east.x - EARTH_CIRCUMFERENCE / 360) < 1e-3);
    // North is towards negative z.
    assert.ok(toScene(origin, HOME.lat + 0.01, HOME.lon).z < 0);
    assert.equal(origin.x, worldX(HOME.lon));
  });
});

describe('visible tiles', () => {
  const pose = { target: HOME, bearing: NORTH_EAST, pitch: PITCH, distance: 700 };
  const options = { aspect: 16 / 9, frameHeight: 1080 };

  it('covers the ground under the boat', () => {
    const { tiles, tileZoom } = visibleTiles3d(pose, options);
    const count = 2 ** tileZoom;
    const x = Math.floor(worldX(HOME.lon) * count);
    assert.ok(
      tiles.some((tile) => tile.x === x),
      'the boat’s own column is there'
    );
    assert.ok(tiles.length > 0);
    for (const tile of tiles) {
      assert.equal(tile.z, tileZoom);
      assert.ok(tile.wrappedX >= 0 && tile.wrappedX < count);
    }
  });

  it('picks a finer zoom the closer the camera is', () => {
    const close = visibleTiles3d({ ...pose, distance: 260 }, options).tileZoom;
    const far = visibleTiles3d({ ...pose, distance: 2000 }, options).tileZoom;
    assert.ok(close > far);
  });

  it('asks for coarser tiles for a smaller picture', () => {
    const full = visibleTiles3d(pose, options).tileZoom;
    const small = visibleTiles3d(pose, { ...options, frameHeight: 270 }).tileZoom;
    assert.ok(small < full);
  });

  it('never goes finer than the layer has tiles', () => {
    assert.ok(visibleTiles3d(pose, { ...options, layerMaxZoom: 15 }).tileZoom <= 15);
  });

  it('caps the count by coarsening', () => {
    for (const distance of [260, 700, 2000, 20000]) {
      for (const aspect of [9 / 16, 1, 16 / 9]) {
        const { tiles } = visibleTiles3d({ ...pose, distance }, { ...options, aspect });
        assert.ok(tiles.length <= MAX_TILES, `${tiles.length} tiles at ${distance}`);
      }
    }
  });

  it('keeps the ground out of the sky: the footprint has four corners near the target', () => {
    const footprint = groundFootprint(pose, 16 / 9);
    assert.equal(footprint.length, 4);
    for (const corner of footprint) {
      assert.ok(Math.hypot(corner.x, corner.z) <= 700 * 5 + 1e-6);
    }
  });

  it('does not ask for tiles beyond the poles', () => {
    const polar = { ...pose, target: { lat: 85.05, lon: 0 } };
    const { tiles } = visibleTiles3d(polar, options);
    for (const tile of tiles) {
      assert.ok(tile.y >= 0 && tile.y < 2 ** tile.z);
    }
  });

  it('gives the tiles of every layer at its own maximum zoom', () => {
    const legs = buildLegs([passage(1, DAY, 2, HOME, NORTH_EAST)], FRAME);
    const state = stateAt(buildStoryboard(legs), 0.5);
    const { tiles } = framing3d(state, {
      aspect: 16 / 9,
      height: 1080,
      layers: TILE_LAYERS,
      factor: 0.001
    });
    assert.ok(tiles.osm.length > 0);
    assert.ok(tiles.seamarks.every((tile) => tile.z <= 18));
    assert.ok(tiles.osm.every((tile) => tile.z <= 19));
  });
});

describe('boat sizes', () => {
  it('offers three, the largest being the boat as first drawn and the smallest half of it', () => {
    assert.deepEqual(
      BOAT_SIZES.map((option) => option.id),
      ['small', 'medium', 'large']
    );
    assert.equal(boatSizeById('large').factor, 1);
    assert.equal(boatSizeById('small').factor, 0.5);
    assert.ok(boatSizeById('medium').factor > 0.5 && boatSizeById('medium').factor < 1);
    assert.equal(DEFAULT_BOAT_SIZE_ID, 'medium');
    assert.equal(boatSizeById('nope').id, 'medium');
  });
});

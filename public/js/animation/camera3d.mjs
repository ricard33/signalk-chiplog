// Framing the 3D animation: where the camera stands, and which tiles the ground
// under it needs. Pure functions over numbers — no WebGL, no vendor imports.
//
// The scene is measured in Mercator metres: a Web Mercator world fraction times
// the length of the equator. They are not ground metres — a map metre shrinks
// by cos(latitude) — but the tiles are square in them, and the boat is drawn
// larger than life anyway, so one uniform unit keeps every part of the scene
// consistent. The origin is the point the camera looks at, recomputed every
// frame (`toScene`), which keeps the numbers small wherever in the world the
// boat is.
//
// Axes: x east, y up, z south — a right-handed frame, and the direction a
// Mercator world fraction's y already grows in.

import { TILE_SIZE, worldX, worldY } from './mercator.mjs';

export const EARTH_CIRCUMFERENCE = 40075016.686;

const DEGREES = Math.PI / 180;

// How much closer or wider than the map view the 3D view frames the boat. The
// default is the map's own zoom — the ground under the boat is at the same scale
// in both — and the other two are for a tighter or a wider shot.
export const CAMERA_FRAMINGS = [
  { id: 'close', labelKey: 'animation.framingClose', factor: 0.5 },
  { id: 'map', labelKey: 'animation.framingMap', factor: 1 },
  { id: 'wide', labelKey: 'animation.framingWide', factor: 2 }
];
export const DEFAULT_FRAMING_ID = 'map';

export function framingById(id) {
  return CAMERA_FRAMINGS.find((option) => option.id === id) ?? CAMERA_FRAMINGS[1];
}

// A plunging view: the camera looks down at the boat from 50° above the
// horizon, with the sea still running off to the horizon behind it.
export const PITCH = 50 * DEGREES;
export const FIELD_OF_VIEW = 38 * DEGREES;

// The length of the boat, as a share of the camera's distance: drawn larger than
// life, so it holds the same share of the frame at every zoom.
export const BOAT_SHARE = 0.15;

// Three sizes of boat: the share above is the large one, and the small one is half
// of it.
export const BOAT_SIZES = [
  { id: 'small', labelKey: 'animation.boatSizeSmall', factor: 0.5 },
  { id: 'medium', labelKey: 'animation.boatSizeMedium', factor: 0.75 },
  { id: 'large', labelKey: 'animation.boatSizeLarge', factor: 1 }
];
export const DEFAULT_BOAT_SIZE_ID = 'medium';

export function boatSizeById(id) {
  return (
    BOAT_SIZES.find((option) => option.id === id) ??
    BOAT_SIZES.find((option) => option.id === DEFAULT_BOAT_SIZE_ID)
  );
}

// The ground is only textured out to this many camera distances: beyond it
// the fog has taken over, and tiles there would be wasted downloads.
export const GROUND_RANGE = 5;

// However wide the view, no more tiles than this are asked for at once.
export const MAX_TILES = 150;

// How far the camera stands for the ground under the boat to be at the same scale
// as in the map view. There, a frame of `height` pixels at zoom `z` covers
// `height` × (equator / (256 × 2^z)) of Mercator metres; here the same height is
// seen at the camera's distance across the field of view.
export function distanceForZoom(zoom, height, factor = 1) {
  const metresPerPixel = EARTH_CIRCUMFERENCE / (TILE_SIZE * 2 ** zoom);
  return (factor * metresPerPixel * height) / (2 * Math.tan(FIELD_OF_VIEW / 2));
}

// The camera's place for a frame: what it looks at, and how far and how high.
// It is the map view's own camera — the same target and the same zoom, so the
// same stretch of sea, and north at the top of the frame — tilted to look down at
// the boat. `state` is `stateAt`'s; `height` is the frame's height in pixels.
export function chasePose(state, options) {
  const { height, factor = 1 } = options;
  return {
    target: state.camera.centre,
    // North is up, as on the map. The camera stands south of the boat.
    bearing: 0,
    pitch: PITCH,
    distance: distanceForZoom(state.camera.zoom, height, factor)
  };
}

// The scene's coordinates of a position, relative to the frame's origin.
export function toScene(origin, lat, lon) {
  return {
    x: (worldX(lon) - origin.x) * EARTH_CIRCUMFERENCE,
    z: (worldY(lat) - origin.y) * EARTH_CIRCUMFERENCE
  };
}

// The origin of a frame, as world fractions: the point the camera looks at.
export function frameOrigin(pose) {
  return { x: worldX(pose.target.lon), y: worldY(pose.target.lat) };
}

// The camera's place relative to the origin, and its axes.
export function cameraFrame(pose, aspect) {
  const horizontal = pose.distance * Math.cos(pose.pitch);
  const position = {
    x: -Math.sin(pose.bearing) * horizontal,
    y: pose.distance * Math.sin(pose.pitch),
    z: Math.cos(pose.bearing) * horizontal
  };
  const forward = { x: -position.x, y: -position.y, z: -position.z };
  const length = Math.hypot(forward.x, forward.y, forward.z);
  forward.x /= length;
  forward.y /= length;
  forward.z /= length;
  // right = forward × up, with up = (0, 1, 0).
  const right = { x: -forward.z, y: 0, z: forward.x };
  const across = Math.hypot(right.x, right.z);
  right.x /= across;
  right.z /= across;
  // up = right × forward.
  const up = {
    x: right.y * forward.z - right.z * forward.y,
    y: right.z * forward.x - right.x * forward.z,
    z: right.x * forward.y - right.y * forward.x
  };
  const tanV = Math.tan(FIELD_OF_VIEW / 2);
  return { position, forward, right, up, tanV, tanH: tanV * aspect };
}

// Where the frame's corners land on the sea, and so which stretch of it is
// seen. A corner above the horizon is cut at the ground range instead.
export function groundFootprint(pose, aspect) {
  const { position, forward, right, up, tanV, tanH } = cameraFrame(pose, aspect);
  const range = pose.distance * GROUND_RANGE;
  const corners = [
    [-1, 1],
    [1, 1],
    [1, -1],
    [-1, -1]
  ];
  return corners.map(([sx, sy]) => {
    const ray = {
      x: forward.x + right.x * sx * tanH + up.x * sy * tanV,
      y: forward.y + right.y * sx * tanH + up.y * sy * tanV,
      z: forward.z + right.z * sx * tanH + up.z * sy * tanV
    };
    let x;
    let z;
    if (ray.y < -1e-6) {
      const reach = -position.y / ray.y;
      x = position.x + ray.x * reach;
      z = position.z + ray.z * reach;
    } else {
      x = position.x + ray.x * range * 10;
      z = position.z + ray.z * range * 10;
    }
    // Never further than the fog lets it be seen.
    const away = Math.hypot(x, z);
    if (away > range) {
      x = (x / away) * range;
      z = (z / away) * range;
    }
    return { x, z };
  });
}

function insideConvex(polygon, x, z, margin) {
  let sign = 0;
  for (let i = 0; i < polygon.length; i += 1) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    const length = Math.hypot(b.x - a.x, b.z - a.z);
    if (length < 1e-9) {
      continue;
    }
    const side = ((b.x - a.x) * (z - a.z) - (b.z - a.z) * (x - a.x)) / length;
    // The corners come in one winding, so a point is inside when every edge
    // sees it on the same side, give or take the margin.
    if (sign === 0) {
      sign = side >= 0 ? 1 : -1;
    }
    if (side * sign < -margin) {
      return false;
    }
  }
  return true;
}

// The tiles under the view, per layer. `frameHeight` is the frame's height in
// device pixels — `height * renderScale`, so the preview asks for the coarser
// tiles its smaller picture can use.
export function visibleTiles3d(pose, options) {
  const { aspect, frameHeight, layerMaxZoom = 19, maxTiles = MAX_TILES } = options;
  const origin = frameOrigin(pose);
  const footprint = groundFootprint(pose, aspect);
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const { x, z } of footprint) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  }

  // Finest tile whose pixels are no smaller than the screen's at the target.
  const metresPerPixel = (2 * pose.distance * Math.tan(FIELD_OF_VIEW / 2)) / frameHeight;
  let zoom = Math.ceil(Math.log2(EARTH_CIRCUMFERENCE / TILE_SIZE / metresPerPixel));
  zoom = Math.max(0, Math.min(zoom, layerMaxZoom));

  for (;;) {
    const count = 2 ** zoom;
    const side = EARTH_CIRCUMFERENCE / count;
    const firstX = Math.floor(origin.x * count + minX / side);
    const lastX = Math.floor(origin.x * count + maxX / side);
    const firstY = Math.floor(origin.y * count + minZ / side);
    const lastY = Math.floor(origin.y * count + maxZ / side);
    const tiles = [];
    for (let y = firstY; y <= lastY; y += 1) {
      // Above 85° N and below 85° S there is no map.
      if (y < 0 || y >= count) {
        continue;
      }
      for (let x = firstX; x <= lastX; x += 1) {
        const centreX = ((x + 0.5) / count - origin.x) * EARTH_CIRCUMFERENCE;
        const centreZ = ((y + 0.5) / count - origin.y) * EARTH_CIRCUMFERENCE;
        if (insideConvex(footprint, centreX, centreZ, side * 0.71)) {
          tiles.push({ z: zoom, x, y, wrappedX: ((x % count) + count) % count });
        }
      }
    }
    if (tiles.length <= maxTiles || zoom === 0) {
      return { tileZoom: zoom, tiles, footprint };
    }
    zoom -= 1;
  }
}

// One call for everything a frame needs to know about its view — the pose and
// the tiles of each layer — shared by the renderer and by whoever fetches.
// `height` is the frame's logical height; `frameHeight` is in device pixels, so
// the preview asks for the coarser tiles its smaller picture can use.
export function framing3d(state, options) {
  const { aspect, height, frameHeight = height, layers, factor } = options;
  const pose = chasePose(state, { height, factor });
  // The camera is flying, and the ground streams past: half the resolution is
  // a quarter of the downloads, and nobody reads a street name at that speed.
  const flying = state.phase === 'transition';
  const tiles = {};
  for (const layer of layers) {
    tiles[layer.id] = visibleTiles3d(pose, {
      aspect,
      frameHeight: flying ? frameHeight / 2 : frameHeight,
      layerMaxZoom: layer.maxZoom
    }).tiles;
  }
  return { pose, tiles };
}

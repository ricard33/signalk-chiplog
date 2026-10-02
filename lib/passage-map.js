const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { decodePng, encodePng } = require('./png');

// The map picture of a passage, for the summary email (SPEC §4.16): the track
// drawn over raster tiles, as a PNG. The projection comes from the webapp's own
// `animation/mercator.mjs`, so the email and the animation put a track in the
// same place; everything else is here.

const TILE_SIZE = 256;
const MAP_DEFAULTS = { width: 760, height: 440 };

const MAX_ZOOM = 16;
const MIN_ZOOM = 2;
// Room around the track so it does not run into the frame.
const PADDING = 26;
const REQUEST_TIMEOUT_MS = 15 * 1000;
// The OpenStreetMap tile usage policy asks for restraint; a frame this size is
// a dozen tiles, once per passage, which is far less than a reader panning the
// Leaflet map of the same passage.
const TILE_CONCURRENCY = 4;

// The webapp's own colours (components/TrackMap.mjs), so the email looks like
// the passage page.
const SEA = [0xdd, 0xe8, 0xf0];
const TRACK = [0xe8, 0x59, 0x0c];
const DEPARTURE = [0x2b, 0x8a, 0x3e];
const ARRIVAL = [0xc9, 0x2a, 0x2a];
const MARK_EDGE = [0xff, 0xff, 0xff];
const TRACK_WIDTH = 3;
const MARK_RADIUS = 4.5;
const MARK_EDGE_WIDTH = 1.75;

let mercator = null;

function loadMercator() {
  mercator ??= import(
    pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'animation', 'mercator.mjs')).href
  );
  return mercator;
}

// A canvas of 8-bit RGB, filled with the sea colour: what shows through where
// no tile arrived.
function createCanvas(width, height, fill) {
  const data = Buffer.allocUnsafe(width * height * 3);
  for (let i = 0; i < data.length; i += 3) {
    data[i] = fill[0];
    data[i + 1] = fill[1];
    data[i + 2] = fill[2];
  }
  return { width, height, data };
}

function blend(canvas, x, y, r, g, b, alpha) {
  if (alpha <= 0 || x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) {
    return;
  }
  const at = (y * canvas.width + x) * 3;
  if (alpha >= 1) {
    canvas.data[at] = r;
    canvas.data[at + 1] = g;
    canvas.data[at + 2] = b;
    return;
  }
  canvas.data[at] += Math.round((r - canvas.data[at]) * alpha);
  canvas.data[at + 1] += Math.round((g - canvas.data[at + 1]) * alpha);
  canvas.data[at + 2] += Math.round((b - canvas.data[at + 2]) * alpha);
}

// Copies a decoded tile onto the canvas at an integer offset, over whatever is
// already there -- a seamark overlay is mostly transparent.
function drawTile(canvas, tile, left, top) {
  for (let y = 0; y < tile.height; y += 1) {
    for (let x = 0; x < tile.width; x += 1) {
      const from = (y * tile.width + x) * 4;
      blend(
        canvas,
        left + x,
        top + y,
        tile.data[from],
        tile.data[from + 1],
        tile.data[from + 2],
        tile.data[from + 3] / 255
      );
    }
  }
}

// A shape is drawn in two passes: coverage is accumulated here, pixel by pixel,
// then painted in one go. Stamping straight onto the canvas instead would blend
// the same pixel twice wherever two segments of the track meet, leaving a seam
// at every join.
function createMask(width, height) {
  return new Float32Array(width * height);
}

// How much of the pixel a shape `distance` away from its edge covers: the
// one-pixel ramp that passes for antialiasing at this size.
const coverage = (distance) => Math.max(0, Math.min(1, 0.5 - distance));

function stamp(mask, width, height, box, distanceTo) {
  const firstX = Math.max(0, Math.floor(box.minX));
  const lastX = Math.min(width - 1, Math.ceil(box.maxX));
  const firstY = Math.max(0, Math.floor(box.minY));
  const lastY = Math.min(height - 1, Math.ceil(box.maxY));
  for (let y = firstY; y <= lastY; y += 1) {
    for (let x = firstX; x <= lastX; x += 1) {
      const value = coverage(distanceTo(x + 0.5, y + 0.5));
      const at = y * width + x;
      if (value > mask[at]) {
        mask[at] = value;
      }
    }
  }
}

function stampDisc(mask, width, height, cx, cy, radius) {
  stamp(
    mask,
    width,
    height,
    { minX: cx - radius - 1, maxX: cx + radius + 1, minY: cy - radius - 1, maxY: cy + radius + 1 },
    (x, y) => Math.hypot(x - cx, y - cy) - radius
  );
}

// Distance to the segment, so the stroke gets round caps and joins for free.
function stampSegment(mask, width, height, from, to, radius) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) {
    stampDisc(mask, width, height, from.x, from.y, radius);
    return;
  }
  stamp(
    mask,
    width,
    height,
    {
      minX: Math.min(from.x, to.x) - radius - 1,
      maxX: Math.max(from.x, to.x) + radius + 1,
      minY: Math.min(from.y, to.y) - radius - 1,
      maxY: Math.max(from.y, to.y) + radius + 1
    },
    (x, y) => {
      const ratio = Math.max(
        0,
        Math.min(1, ((x - from.x) * dx + (y - from.y) * dy) / lengthSquared)
      );
      return Math.hypot(x - (from.x + ratio * dx), y - (from.y + ratio * dy)) - radius;
    }
  );
}

function paint(canvas, mask, [r, g, b]) {
  for (let y = 0; y < canvas.height; y += 1) {
    for (let x = 0; x < canvas.width; x += 1) {
      blend(canvas, x, y, r, g, b, mask[y * canvas.width + x]);
    }
  }
}

function drawPolyline(canvas, points, width, colour) {
  const mask = createMask(canvas.width, canvas.height);
  const radius = width / 2;
  if (points.length === 1) {
    stampDisc(mask, canvas.width, canvas.height, points[0].x, points[0].y, radius);
  }
  for (let i = 1; i < points.length; i += 1) {
    stampSegment(mask, canvas.width, canvas.height, points[i - 1], points[i], radius);
  }
  paint(canvas, mask, colour);
}

function drawMark(canvas, point, colour) {
  for (const [radius, fill] of [
    [MARK_RADIUS + MARK_EDGE_WIDTH, MARK_EDGE],
    [MARK_RADIUS, colour]
  ]) {
    const mask = createMask(canvas.width, canvas.height);
    stampDisc(mask, canvas.width, canvas.height, point.x, point.y, radius);
    paint(canvas, mask, fill);
  }
}

// The whole-world Mercator fractions of the track, longitudes unwrapped so a
// passage across the antimeridian stays in one piece.
function projectTrack(points, { worldX, worldY, unwrapLongitude }) {
  let lon = points[0].lon;
  return points.map((point) => {
    lon = unwrapLongitude(lon, point.lon);
    return { wx: worldX(lon), wy: worldY(point.lat) };
  });
}

// The highest zoom at which the track, plus its padding, fits the frame.
function chooseView(world, { width, height }) {
  const xs = world.map((point) => point.wx);
  const ys = world.map((point) => point.wy);
  const span = {
    x: Math.max(...xs) - Math.min(...xs),
    y: Math.max(...ys) - Math.min(...ys)
  };
  const centre = {
    wx: (Math.max(...xs) + Math.min(...xs)) / 2,
    wy: (Math.max(...ys) + Math.min(...ys)) / 2
  };
  const usableWidth = Math.max(1, width - 2 * PADDING);
  const usableHeight = Math.max(1, height - 2 * PADDING);

  let zoom = MIN_ZOOM;
  for (let candidate = MAX_ZOOM; candidate > MIN_ZOOM; candidate -= 1) {
    const scale = TILE_SIZE * 2 ** candidate;
    if (span.x * scale <= usableWidth && span.y * scale <= usableHeight) {
      zoom = candidate;
      break;
    }
  }
  return { zoom, centre };
}

function tileUrl(template, { z, x, y }) {
  const count = 2 ** z;
  const wrapped = ((x % count) + count) % count;
  return template
    .replace('{z}', String(z))
    .replace('{x}', String(wrapped))
    .replace('{y}', String(y));
}

// Fetches the tiles covering the frame, a few at a time, and draws each as it
// arrives. A tile that does not come back is simply missing: the sea colour
// shows through and the track is still readable, which is what keeps the map
// usable on a boat with a thin connection.
async function drawTiles(canvas, { template, zoom, originX, originY, fetchImpl, userAgent, log }) {
  const count = 2 ** zoom;
  const wanted = [];
  for (
    let y = Math.max(0, Math.floor(originY / TILE_SIZE));
    y <= Math.min(count - 1, Math.floor((originY + canvas.height - 1) / TILE_SIZE));
    y += 1
  ) {
    for (
      let x = Math.floor(originX / TILE_SIZE);
      x <= Math.floor((originX + canvas.width - 1) / TILE_SIZE);
      x += 1
    ) {
      wanted.push({ x, y });
    }
  }

  let next = 0;
  let failures = 0;
  const worker = async () => {
    while (next < wanted.length) {
      const { x, y } = wanted[next];
      next += 1;
      const url = tileUrl(template, { z: zoom, x, y });
      try {
        const response = await fetchImpl(url, {
          headers: { 'User-Agent': userAgent, Accept: 'image/png' },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const tile = decodePng(Buffer.from(await response.arrayBuffer()));
        drawTile(canvas, tile, x * TILE_SIZE - originX, y * TILE_SIZE - originY);
      } catch (err) {
        failures += 1;
        log('debug', `Map tile ${zoom}/${x}/${y} unavailable: ${err.message}`);
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(TILE_CONCURRENCY, wanted.length) }, () => worker())
  );
  return { tiles: wanted.length, missing: failures };
}

// `trackPoints` are the passage's, in order; an empty `tileUrlTemplate` draws
// the track on a plain background, which is also what an unreachable tile
// server amounts to. Returns `{ png, width, height, zoom, tiles, missing }`, or
// null when there is no position to draw.
async function renderPassageMap(
  trackPoints,
  {
    width = MAP_DEFAULTS.width,
    height = MAP_DEFAULTS.height,
    tileUrlTemplate = null,
    fetchImpl = globalThis.fetch,
    userAgent = 'signalk-chiplog',
    log = () => {}
  } = {}
) {
  const points = (trackPoints ?? []).filter(
    (point) => Number.isFinite(point.lat) && Number.isFinite(point.lon)
  );
  if (points.length === 0) {
    return null;
  }

  const projection = await loadMercator();
  const world = projectTrack(points, projection);
  const { zoom, centre } = chooseView(world, { width, height });
  const scale = TILE_SIZE * 2 ** zoom;
  // Where the frame's top-left corner sits in the zoom level's pixel plane.
  // Whole pixels: a tile is copied, not resampled, so it has to land on the
  // grid, and half a pixel of framing makes no difference to the track.
  const originX = Math.round(centre.wx * scale - width / 2);
  const originY = Math.round(centre.wy * scale - height / 2);

  const canvas = createCanvas(width, height, SEA);
  let coverageReport = { tiles: 0, missing: 0 };
  if (tileUrlTemplate) {
    coverageReport = await drawTiles(canvas, {
      template: tileUrlTemplate,
      zoom,
      originX,
      originY,
      fetchImpl,
      userAgent,
      log
    });
  }

  const pixels = world.map((point) => ({
    x: point.wx * scale - originX,
    y: point.wy * scale - originY
  }));
  drawPolyline(canvas, pixels, TRACK_WIDTH, TRACK);
  drawMark(canvas, pixels[0], DEPARTURE);
  if (pixels.length > 1) {
    drawMark(canvas, pixels[pixels.length - 1], ARRIVAL);
  }

  return { png: encodePng(canvas), width, height, zoom, ...coverageReport };
}

module.exports = { renderPassageMap, MAP_DEFAULTS };

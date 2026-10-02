const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { encodePng, decodePng } = require('../lib/png');
const { renderPassageMap, MAP_DEFAULTS } = require('../lib/passage-map');

const SEA = [0xdd, 0xe8, 0xf0];
const TRACK = [0xe8, 0x59, 0x0c];
const LAND = [0x40, 0x80, 0x40];

function solidTile(colour) {
  const data = Buffer.alloc(256 * 256 * 3);
  for (let i = 0; i < 256 * 256; i += 1) {
    data[i * 3] = colour[0];
    data[i * 3 + 1] = colour[1];
    data[i * 3 + 2] = colour[2];
  }
  return encodePng({ width: 256, height: 256, data });
}

// A tile server answering every request with the same tile, unless told to
// refuse some of them.
function tileServer({ refuse = () => false, body = solidTile(LAND) } = {}) {
  const asked = [];
  const fetchImpl = async (url) => {
    asked.push(url);
    if (refuse(url)) {
      return { ok: false, status: 503 };
    }
    return {
      ok: true,
      arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.length)
    };
  };
  return { fetchImpl, asked };
}

function leg(count, { lat = 46.14, lon = -1.17, dLat = 0.0004, dLon = 0 } = {}) {
  return Array.from({ length: count }, (_, i) => ({
    lat: lat + i * dLat,
    lon: lon + i * dLon
  }));
}

function pixel(image, x, y) {
  const at = (y * image.width + x) * 4;
  return [...image.data.subarray(at, at + 3)];
}

function countColour(image, colour, tolerance = 24) {
  let count = 0;
  for (let i = 0; i < image.width * image.height; i += 1) {
    const at = i * 4;
    if (
      Math.abs(image.data[at] - colour[0]) <= tolerance &&
      Math.abs(image.data[at + 1] - colour[1]) <= tolerance &&
      Math.abs(image.data[at + 2] - colour[2]) <= tolerance
    ) {
      count += 1;
    }
  }
  return count;
}

describe('the map of a passage', () => {
  it('has nothing to draw without a position', async () => {
    assert.equal(await renderPassageMap([]), null);
    assert.equal(await renderPassageMap([{ lat: null, lon: null }]), null);
    assert.equal(await renderPassageMap(null), null);
  });

  it('draws the track over the tiles, at the asked size', async () => {
    const { fetchImpl, asked } = tileServer();

    const map = await renderPassageMap(leg(200), {
      tileUrlTemplate: 'https://tiles.test/{z}/{x}/{y}.png',
      fetchImpl
    });

    assert.equal(map.width, MAP_DEFAULTS.width);
    assert.equal(map.height, MAP_DEFAULTS.height);
    assert.equal(map.missing, 0);
    assert.ok(asked.length > 0 && asked.length === map.tiles);
    assert.ok(
      asked.every((url) => new RegExp(`^https://tiles.test/${map.zoom}/\\d+/\\d+.png$`).test(url)),
      asked[0]
    );

    const image = decodePng(map.png);
    assert.ok(countColour(image, TRACK) > 100, 'the track is drawn');
    assert.ok(countColour(image, LAND) > image.width * image.height * 0.8, 'the tiles are drawn');
  });

  it('frames the track with room around it', async () => {
    const map = await renderPassageMap(leg(200, { dLat: 0.0004, dLon: 0.0006 }));
    const image = decodePng(map.png);

    const edges = [
      ...Array.from({ length: image.width }, (_, x) => [x, 0]),
      ...Array.from({ length: image.width }, (_, x) => [x, image.height - 1]),
      ...Array.from({ length: image.height }, (_, y) => [0, y]),
      ...Array.from({ length: image.height }, (_, y) => [image.width - 1, y])
    ];
    for (const [x, y] of edges) {
      assert.deepEqual(pixel(image, x, y), SEA, `the track reaches the frame at ${x},${y}`);
    }
  });

  it('marks the departure in green and the arrival in red', async () => {
    const map = await renderPassageMap(leg(200));
    const image = decodePng(map.png);

    assert.ok(countColour(image, [0x2b, 0x8a, 0x3e]) > 20, 'departure mark');
    assert.ok(countColour(image, [0xc9, 0x2a, 0x2a]) > 20, 'arrival mark');
  });

  it('zooms in on a short passage and out on a long one', async () => {
    const near = await renderPassageMap(leg(50, { dLat: 0.0002 }));
    const far = await renderPassageMap(leg(50, { dLat: 0.05 }));

    assert.ok(near.zoom > far.zoom, `${near.zoom} is no closer than ${far.zoom}`);
  });

  it('still sends a readable map when tiles do not come back', async () => {
    const { fetchImpl } = tileServer({ refuse: () => true });

    const map = await renderPassageMap(leg(200), {
      tileUrlTemplate: 'https://tiles.test/{z}/{x}/{y}.png',
      fetchImpl
    });

    assert.equal(map.missing, map.tiles);
    const image = decodePng(map.png);
    assert.ok(countColour(image, TRACK) > 100, 'the track is still there');
    assert.deepEqual(pixel(image, 0, 0), SEA, 'on the plain background');
  });

  it('draws the track alone when no tile server is configured', async () => {
    const { fetchImpl, asked } = tileServer();

    const map = await renderPassageMap(leg(100), { tileUrlTemplate: '', fetchImpl });

    assert.deepEqual(asked, []);
    assert.equal(map.tiles, 0);
    assert.ok(countColour(decodePng(map.png), TRACK) > 50);
  });

  it('keeps a passage across the antimeridian in one piece', async () => {
    const points = [
      { lat: -16.5, lon: 179.7 },
      { lat: -16.6, lon: 179.9 },
      { lat: -16.7, lon: -179.9 },
      { lat: -16.8, lon: -179.7 }
    ];

    const map = await renderPassageMap(points);
    const image = decodePng(map.png);

    // Unwrapped, the track is a short line in the middle; wrapped, it would
    // run the whole width of the world and the frame would be all track.
    const drawn = countColour(image, TRACK);
    assert.ok(drawn > 50, 'the track is drawn');
    assert.ok(drawn < image.width * image.height * 0.1, 'and not smeared across the world');
  });

  it('wraps tile columns back into the world', async () => {
    const { fetchImpl, asked } = tileServer();

    const map = await renderPassageMap([{ lat: -16.5, lon: 179.98 }], {
      tileUrlTemplate: 'https://tiles.test/{z}/{x}/{y}.png',
      fetchImpl
    });

    const limit = 2 ** map.zoom;
    for (const url of asked) {
      const [, x, y] = url.match(/\/\d+\/(\d+)\/(\d+)\.png$/).map(Number);
      assert.ok(x >= 0 && x < limit, `column ${x} of ${limit}`);
      assert.ok(y >= 0 && y < limit, `row ${y} of ${limit}`);
    }
  });

  it('ignores a tile it cannot decode', async () => {
    const { fetchImpl } = tileServer({ body: Buffer.from('<html>Too many requests</html>') });

    const map = await renderPassageMap(leg(100), {
      tileUrlTemplate: 'https://tiles.test/{z}/{x}/{y}.png',
      fetchImpl
    });

    assert.equal(map.missing, map.tiles);
    assert.deepEqual(pixel(decodePng(map.png), 0, 0), SEA);
  });
});

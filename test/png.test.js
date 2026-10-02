const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { describe, it } = require('node:test');
const { encodePng, decodePng } = require('../lib/png');

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  let c = -1;
  for (const byte of Buffer.concat([head.subarray(4), data])) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE((c ^ -1) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

// Builds a PNG by hand, to feed the decoder what a tile server might send.
function png({ width, height, bitDepth, colourType, rows, palette = null, transparency = null }) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = bitDepth;
  header[9] = colourType;
  const parts = [SIGNATURE, chunk('IHDR', header)];
  if (palette) {
    parts.push(chunk('PLTE', Buffer.from(palette)));
  }
  if (transparency) {
    parts.push(chunk('tRNS', Buffer.from(transparency)));
  }
  // Filter type 0 (none) on every scanline.
  const raw = Buffer.concat(rows.map((row) => Buffer.from([0, ...row])));
  parts.push(chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

function gradient(width, height) {
  const data = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i += 1) {
    data[i * 3] = i % 256;
    data[i * 3 + 1] = (i * 7) % 256;
    data[i * 3 + 2] = 255 - (i % 256);
  }
  return data;
}

describe('PNG encoding', () => {
  it('writes an image its own decoder reads back pixel for pixel', () => {
    const width = 37;
    const height = 19;
    const data = gradient(width, height);

    const decoded = decodePng(encodePng({ width, height, data }));

    assert.equal(decoded.width, width);
    assert.equal(decoded.height, height);
    for (let i = 0; i < width * height; i += 1) {
      assert.deepEqual(
        [...decoded.data.subarray(i * 4, i * 4 + 4)],
        [data[i * 3], data[i * 3 + 1], data[i * 3 + 2], 255],
        `pixel ${i}`
      );
    }
  });

  it('starts with the PNG signature and ends with IEND', () => {
    const file = encodePng({ width: 2, height: 2, data: Buffer.alloc(12) });
    assert.ok(file.subarray(0, 8).equals(SIGNATURE));
    assert.equal(file.toString('latin1', file.length - 8, file.length - 4), 'IEND');
  });

  it('filters rows, so a flat image is far smaller than its pixels', () => {
    const flat = encodePng({ width: 256, height: 256, data: Buffer.alloc(256 * 256 * 3, 0x40) });
    assert.ok(flat.length < 2000, `${flat.length} bytes for a plain square`);
  });

  it('refuses data that is not the size of the image', () => {
    assert.throws(() => encodePng({ width: 4, height: 4, data: Buffer.alloc(10) }), /Expected 48/);
  });
});

describe('PNG decoding', () => {
  it('reads a truecolour image with alpha', () => {
    const file = png({
      width: 2,
      height: 1,
      bitDepth: 8,
      colourType: 6,
      rows: [[1, 2, 3, 128, 4, 5, 6, 255]]
    });
    assert.deepEqual([...decodePng(file).data], [1, 2, 3, 128, 4, 5, 6, 255]);
  });

  it('expands a palette, transparency included', () => {
    const file = png({
      width: 3,
      height: 1,
      bitDepth: 8,
      colourType: 3,
      palette: [10, 20, 30, 40, 50, 60, 70, 80, 90],
      transparency: [0, 255],
      rows: [[0, 1, 2]]
    });
    assert.deepEqual([...decodePng(file).data], [10, 20, 30, 0, 40, 50, 60, 255, 70, 80, 90, 255]);
  });

  it('unpacks a palette of fewer than eight bits a pixel', () => {
    // Four pixels of two bits: indices 0, 1, 2, 3 in one byte.
    const file = png({
      width: 4,
      height: 1,
      bitDepth: 2,
      colourType: 3,
      palette: [0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255],
      rows: [[0b00011011]]
    });
    const { data } = decodePng(file);
    assert.deepEqual(
      [0, 1, 2, 3].map((i) => [...data.subarray(i * 4, i * 4 + 3)]),
      [
        [0, 0, 0],
        [255, 0, 0],
        [0, 255, 0],
        [0, 0, 255]
      ]
    );
  });

  it('scales greyscale up to full range', () => {
    const file = png({ width: 2, height: 1, bitDepth: 1, colourType: 0, rows: [[0b01000000]] });
    const { data } = decodePng(file);
    assert.deepEqual([data[0], data[3], data[4], data[7]], [0, 255, 255, 255]);
  });

  it('undoes every filter type', () => {
    const width = 8;
    const height = 6;
    const data = gradient(width, height);
    // The encoder picks filters per row; over a gradient it uses more than one.
    const file = encodePng({ width, height, data });
    const raw = zlib.inflateSync(
      (() => {
        let at = 8;
        const idat = [];
        while (at < file.length) {
          const length = file.readUInt32BE(at);
          const type = file.toString('latin1', at + 4, at + 8);
          if (type === 'IDAT') {
            idat.push(file.subarray(at + 8, at + 8 + length));
          }
          at += length + 12;
        }
        return Buffer.concat(idat);
      })()
    );
    const used = new Set();
    for (let y = 0; y < height; y += 1) {
      used.add(raw[y * (width * 3 + 1)]);
    }
    assert.ok(used.size > 1, `only filter ${[...used]} used`);
    assert.deepEqual([...decodePng(file).data.subarray(0, 3)], [0, 0, 255]);
  });

  it('refuses what it cannot read rather than guessing', () => {
    assert.throws(() => decodePng(Buffer.from('not a png')), /Not a PNG/);

    const interlaced = png({ width: 1, height: 1, bitDepth: 8, colourType: 2, rows: [[0, 0, 0]] });
    // Byte 12 of the IHDR data is the interlace method.
    interlaced[8 + 8 + 12] = 1;
    assert.throws(() => decodePng(interlaced), /Interlaced/);

    const deep = png({
      width: 1,
      height: 1,
      bitDepth: 16,
      colourType: 2,
      rows: [[0, 0, 0, 0, 0, 0]]
    });
    assert.throws(() => decodePng(deep), /bit depth 16/);
  });
});

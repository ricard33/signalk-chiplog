const zlib = require('node:zlib');

// Just enough PNG to put a map in an email: decode the raster tiles fetched
// from a tile server, and encode the image drawn from them. Both directions are
// a few hundred lines over node:zlib, which is the whole reason they are here
// rather than behind a dependency -- a native image library is exactly what the
// node:sqlite choice avoided (SPEC §2).

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Channels per pixel for each PNG colour type; 3 (palette) carries one index.
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

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

function crc32(buffer) {
  let c = -1;
  for (let i = 0; i < buffer.length; i += 1) {
    c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

// The Paeth predictor of the PNG specification, shared by filtering and
// unfiltering.
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) {
    return a;
  }
  return pb <= pc ? b : c;
}

// Filters one scanline each of the five ways and keeps the one whose bytes sum
// smallest -- the heuristic the specification suggests, and the difference
// between a 1 MB map and a 300 kB one.
function filterRow(row, previous, bpp, out) {
  const width = row.length;
  let best = null;
  const candidate = Buffer.allocUnsafe(width);
  for (let type = 0; type <= 4; type += 1) {
    let sum = 0;
    for (let i = 0; i < width; i += 1) {
      const left = i >= bpp ? row[i - bpp] : 0;
      const up = previous[i];
      const upLeft = i >= bpp ? previous[i - bpp] : 0;
      let value;
      switch (type) {
        case 1:
          value = row[i] - left;
          break;
        case 2:
          value = row[i] - up;
          break;
        case 3:
          value = row[i] - ((left + up) >> 1);
          break;
        case 4:
          value = row[i] - paeth(left, up, upLeft);
          break;
        default:
          value = row[i];
      }
      candidate[i] = value & 0xff;
      // Signed bytes: a small negative difference is as cheap as a small
      // positive one.
      sum += candidate[i] < 128 ? candidate[i] : 256 - candidate[i];
    }
    if (best === null || sum < best.sum) {
      best = { sum, type, bytes: Buffer.from(candidate) };
    }
  }
  out.push(Buffer.from([best.type]), best.bytes);
}

// `data` is 8-bit RGB, three bytes per pixel, row by row.
function encodePng({ width, height, data }) {
  if (data.length !== width * height * 3) {
    throw new Error(`Expected ${width * height * 3} bytes of RGB, got ${data.length}`);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: truecolour
  header[10] = 0; // deflate
  header[11] = 0; // adaptive filtering
  header[12] = 0; // no interlacing

  const stride = width * 3;
  const rows = [];
  let previous = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const row = data.subarray(y * stride, (y + 1) * stride);
    filterRow(row, previous, 3, rows);
    previous = row;
  }

  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows), { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

function readChunks(buffer) {
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(SIGNATURE)) {
    throw new Error('Not a PNG');
  }
  const chunks = [];
  let offset = 8;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    const start = offset + 8;
    if (start + length > buffer.length) {
      throw new Error(`Truncated ${type} chunk`);
    }
    chunks.push({ type, data: buffer.subarray(start, start + length) });
    offset = start + length + 4;
    if (type === 'IEND') {
      break;
    }
  }
  return chunks;
}

// Reads `bitDepth` bits at `index` out of a packed scanline, scaled to 0-255 --
// how a 4-bit palette index or a 1-bit greyscale pixel is unpacked.
function sample(row, index, bitDepth) {
  if (bitDepth === 8) {
    return row[index];
  }
  const perByte = 8 / bitDepth;
  const byte = row[Math.floor(index / perByte)];
  const shift = 8 - bitDepth * ((index % perByte) + 1);
  return (byte >> shift) & ((1 << bitDepth) - 1);
}

function unfilter(raw, { width, height, bitDepth, channels }) {
  const bpp = Math.max(1, Math.ceil((bitDepth * channels) / 8));
  const stride = Math.ceil((width * bitDepth * channels) / 8);
  if (raw.length < height * (stride + 1)) {
    throw new Error('Truncated image data');
  }
  const out = Buffer.allocUnsafe(height * stride);
  let previous = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const type = raw[y * (stride + 1)];
    const row = out.subarray(y * stride, (y + 1) * stride);
    raw.copy(row, 0, y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i += 1) {
      const left = i >= bpp ? row[i - bpp] : 0;
      const up = previous[i];
      const upLeft = i >= bpp ? previous[i - bpp] : 0;
      switch (type) {
        case 0:
          break;
        case 1:
          row[i] = (row[i] + left) & 0xff;
          break;
        case 2:
          row[i] = (row[i] + up) & 0xff;
          break;
        case 3:
          row[i] = (row[i] + ((left + up) >> 1)) & 0xff;
          break;
        case 4:
          row[i] = (row[i] + paeth(left, up, upLeft)) & 0xff;
          break;
        default:
          throw new Error(`Unknown filter type ${type}`);
      }
    }
    previous = row;
  }
  return { pixels: out, stride };
}

// Returns 8-bit RGBA, four bytes per pixel. Whatever a tile server answers with
// that this does not cover -- an interlaced tile, 16 bits a channel -- throws,
// and the caller treats the tile as one it did not get.
function decodePng(buffer) {
  const chunks = readChunks(buffer);
  const ihdr = chunks.find((c) => c.type === 'IHDR');
  if (!ihdr || ihdr.data.length < 13) {
    throw new Error('Missing IHDR');
  }
  const width = ihdr.data.readUInt32BE(0);
  const height = ihdr.data.readUInt32BE(4);
  const bitDepth = ihdr.data[8];
  const colourType = ihdr.data[9];
  if (ihdr.data[12] !== 0) {
    throw new Error('Interlaced PNG is not supported');
  }
  const channels = CHANNELS[colourType];
  if (!channels) {
    throw new Error(`Unknown colour type ${colourType}`);
  }
  // 8 bits a channel covers every raster tile seen in the wild; a packed
  // palette or greyscale tile is cheap to unpack as well, and 16-bit is not
  // worth the trouble for a map.
  const packed = bitDepth === 1 || bitDepth === 2 || bitDepth === 4;
  if (!(bitDepth === 8 || (packed && (colourType === 0 || colourType === 3)))) {
    throw new Error(`Unsupported bit depth ${bitDepth} for colour type ${colourType}`);
  }
  if (width === 0 || height === 0) {
    throw new Error('Empty PNG');
  }

  const palette = chunks.find((c) => c.type === 'PLTE')?.data ?? null;
  const transparency = chunks.find((c) => c.type === 'tRNS')?.data ?? null;
  const idat = chunks.filter((c) => c.type === 'IDAT').map((c) => c.data);
  if (idat.length === 0) {
    throw new Error('Missing IDAT');
  }
  if (colourType === 3 && !palette) {
    throw new Error('Palette image without PLTE');
  }

  const { pixels, stride } = unfilter(zlib.inflateSync(Buffer.concat(idat)), {
    width,
    height,
    bitDepth,
    channels
  });

  const max = (1 << bitDepth) - 1;
  const rgba = Buffer.allocUnsafe(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const row = pixels.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < width; x += 1) {
      const out = (y * width + x) * 4;
      let r;
      let g;
      let b;
      let a = 255;
      if (colourType === 3) {
        const index = sample(row, x, bitDepth);
        r = palette[index * 3];
        g = palette[index * 3 + 1];
        b = palette[index * 3 + 2];
        if (transparency && index < transparency.length) {
          a = transparency[index];
        }
      } else if (colourType === 0 || colourType === 4) {
        const grey = sample(row, x * channels, bitDepth);
        r = Math.round((grey * 255) / max);
        g = r;
        b = r;
        if (colourType === 4) {
          a = row[x * 2 + 1];
        }
      } else {
        const base = x * channels;
        r = row[base];
        g = row[base + 1];
        b = row[base + 2];
        if (colourType === 6) {
          a = row[base + 3];
        }
      }
      rgba[out] = r;
      rgba[out + 1] = g;
      rgba[out + 2] = b;
      rgba[out + 3] = a;
    }
  }
  return { width, height, data: rgba };
}

module.exports = { encodePng, decodePng };

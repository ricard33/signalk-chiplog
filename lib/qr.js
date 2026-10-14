// A QR code for a short text -- the address of the service's claim page, shown beside the
// pairing code so a phone can open it (SPEC §4.17). Byte mode, error correction level M,
// versions 1 to 6: up to 106 bytes, which is all an address needs, and small enough that the
// symbol has no version blocks and a single alignment pattern. Written here rather than
// depended on: the plugin runs on boats, and each dependency is one more thing to keep alive.

// Per version: [data bytes per block, error correction bytes per block, blocks], level M.
const VERSIONS = [
  null,
  [16, 10, 1],
  [28, 16, 1],
  [44, 26, 1],
  [32, 18, 2],
  [43, 24, 2],
  [27, 16, 4]
];
// Level M, in the two bits the format information gives it.
const LEVEL_M = 0b00;

// GF(256) with the polynomial x^8 + x^4 + x^3 + x^2 + 1, as Reed-Solomon codes in QR use it.
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i += 1) {
  EXP[i] = x;
  LOG[x] = i;
  x <<= 1;
  if (x & 0x100) {
    x ^= 0x11d;
  }
}
for (let i = 255; i < 512; i += 1) {
  EXP[i] = EXP[i - 255];
}
const multiply = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

// The remainder of the data, as a polynomial, divided by the generator of that many roots.
function errorCorrection(data, count) {
  let generator = [1];
  for (let i = 0; i < count; i += 1) {
    const next = new Array(generator.length + 1).fill(0);
    generator.forEach((coefficient, j) => {
      next[j] ^= coefficient;
      next[j + 1] ^= multiply(coefficient, EXP[i]);
    });
    generator = next;
  }
  const remainder = new Array(count).fill(0);
  for (const byte of data) {
    const factor = byte ^ remainder.shift();
    remainder.push(0);
    for (let i = 0; i < count; i += 1) {
      remainder[i] ^= multiply(generator[i + 1], factor);
    }
  }
  return remainder;
}

// The codewords of the symbol: the text framed and padded, cut in blocks, each followed by its
// error correction, blocks interleaved.
function codewords(bytes, version) {
  const [dataPerBlock, ecPerBlock, blocks] = VERSIONS[version];
  const capacity = dataPerBlock * blocks;
  const bits = [];
  const push = (value, length) => {
    for (let i = length - 1; i >= 0; i -= 1) {
      bits.push((value >> i) & 1);
    }
  };
  push(0b0100, 4);
  push(bytes.length, 8);
  bytes.forEach((byte) => push(byte, 8));
  push(0, Math.min(4, capacity * 8 - bits.length));
  while (bits.length % 8 !== 0) {
    bits.push(0);
  }
  const data = [];
  for (let i = 0; i < bits.length; i += 8) {
    data.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  }
  for (let pad = 0xec; data.length < capacity; pad ^= 0xec ^ 0x11) {
    data.push(pad);
  }

  const dataBlocks = [];
  const ecBlocks = [];
  for (let block = 0; block < blocks; block += 1) {
    const slice = data.slice(block * dataPerBlock, (block + 1) * dataPerBlock);
    dataBlocks.push(slice);
    ecBlocks.push(errorCorrection(slice, ecPerBlock));
  }
  const interleaved = [];
  for (let i = 0; i < dataPerBlock; i += 1) {
    dataBlocks.forEach((block) => interleaved.push(block[i]));
  }
  for (let i = 0; i < ecPerBlock; i += 1) {
    ecBlocks.forEach((block) => interleaved.push(block[i]));
  }
  return interleaved;
}

const MASKS = [
  (row, column) => (row + column) % 2 === 0,
  (row) => row % 2 === 0,
  (row, column) => column % 3 === 0,
  (row, column) => (row + column) % 3 === 0,
  (row, column) => (Math.floor(row / 2) + Math.floor(column / 3)) % 2 === 0,
  (row, column) => ((row * column) % 2) + ((row * column) % 3) === 0,
  (row, column) => (((row * column) % 2) + ((row * column) % 3)) % 2 === 0,
  (row, column) => (((row + column) % 2) + ((row * column) % 3)) % 2 === 0
];

// The fifteen bits that say the level and the mask: five of data, ten of BCH code, masked.
function formatBits(mask) {
  const data = (LEVEL_M << 3) | mask;
  let remainder = data << 10;
  for (let bit = 14; bit >= 10; bit -= 1) {
    if ((remainder >> bit) & 1) {
      remainder ^= 0b10100110111 << (bit - 10);
    }
  }
  return ((data << 10) | remainder) ^ 0b101010000010010;
}

// How hard a symbol is to read, by the standard's four rules: runs of one colour, blocks of
// one colour, shapes that look like a finder, and an uneven share of dark.
function penalty(modules) {
  const size = modules.length;
  let score = 0;
  const lines = [...modules, ...modules.map((_, column) => modules.map((row) => row[column]))];
  for (const line of lines) {
    let run = 1;
    for (let i = 1; i <= size; i += 1) {
      if (i < size && line[i] === line[i - 1]) {
        run += 1;
      } else {
        score += run >= 5 ? run - 2 : 0;
        run = 1;
      }
    }
    const text = line.map((dark) => (dark ? '1' : '0')).join('');
    for (const pattern of ['10111010000', '00001011101']) {
      for (let at = text.indexOf(pattern); at !== -1; at = text.indexOf(pattern, at + 1)) {
        score += 40;
      }
    }
  }
  let dark = 0;
  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column < size; column += 1) {
      dark += modules[row][column] ? 1 : 0;
      if (
        row + 1 < size &&
        column + 1 < size &&
        modules[row][column] === modules[row][column + 1] &&
        modules[row][column] === modules[row + 1][column] &&
        modules[row][column] === modules[row + 1][column + 1]
      ) {
        score += 3;
      }
    }
  }
  return score + Math.floor(Math.abs((dark * 100) / (size * size) - 50) / 5) * 10;
}

// The symbol for `text` as rows of '1' (dark) and '0' (light), without the quiet zone around
// it; null when the text is too long for the versions made here.
function qrCode(text) {
  const bytes = [...Buffer.from(text, 'utf8')];
  const version = VERSIONS.findIndex((spec) => spec && bytes.length + 2 <= spec[0] * spec[2]);
  if (version === -1) {
    return null;
  }
  const size = 17 + 4 * version;
  const modules = Array.from({ length: size }, () => new Array(size).fill(false));
  // What is pattern rather than data: never masked, never written over.
  const fixed = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (row, column, dark) => {
    modules[row][column] = dark;
    fixed[row][column] = true;
  };

  // The three finders with their light separators, and the alignment pattern.
  for (const [top, left] of [
    [0, 0],
    [0, size - 7],
    [size - 7, 0]
  ]) {
    for (let row = -1; row <= 7; row += 1) {
      for (let column = -1; column <= 7; column += 1) {
        const r = top + row;
        const c = left + column;
        if (r >= 0 && r < size && c >= 0 && c < size) {
          const ring = Math.max(Math.abs(row - 3), Math.abs(column - 3));
          set(r, c, ring !== 2 && ring <= 3);
        }
      }
    }
  }
  if (version >= 2) {
    for (let row = -2; row <= 2; row += 1) {
      for (let column = -2; column <= 2; column += 1) {
        set(size - 7 + row, size - 7 + column, Math.max(Math.abs(row), Math.abs(column)) !== 1);
      }
    }
  }
  for (let i = 8; i < size - 8; i += 1) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  set(size - 8, 8, true);

  // Where the format information goes, twice: around the first finder, and split between the
  // other two. Reserved now, written once the mask is chosen.
  const formatPlaces = [];
  for (let i = 0; i < 15; i += 1) {
    // [row, column], from the least significant bit.
    const first =
      i < 6 ? [i, 8] : i === 6 ? [7, 8] : i === 7 ? [8, 8] : i === 8 ? [8, 7] : [8, 14 - i];
    const second = i < 8 ? [8, size - 1 - i] : [size - 15 + i, 8];
    formatPlaces.push([first, second]);
    fixed[first[0]][first[1]] = true;
    fixed[second[0]][second[1]] = true;
  }

  // The codewords, bit by bit, up and down two columns at a time from the bottom right.
  const stream = codewords(bytes, version).flatMap((byte) =>
    Array.from({ length: 8 }, (_, bit) => ((byte >> (7 - bit)) & 1) === 1)
  );
  let next = 0;
  let upward = true;
  for (let right = size - 1; right > 0; right -= 2) {
    if (right === 6) {
      right -= 1;
    }
    for (let step = 0; step < size; step += 1) {
      const row = upward ? size - 1 - step : step;
      for (const column of [right, right - 1]) {
        if (!fixed[row][column]) {
          modules[row][column] = next < stream.length ? stream[next] : false;
          next += 1;
        }
      }
    }
    upward = !upward;
  }

  let best = null;
  for (let mask = 0; mask < MASKS.length; mask += 1) {
    const masked = modules.map((line, row) =>
      line.map((dark, column) => (fixed[row][column] ? dark : dark !== MASKS[mask](row, column)))
    );
    const format = formatBits(mask);
    formatPlaces.forEach(([first, second], i) => {
      const bit = ((format >> i) & 1) === 1;
      masked[first[0]][first[1]] = bit;
      masked[second[0]][second[1]] = bit;
    });
    const score = penalty(masked);
    if (!best || score < best.score) {
      best = { score, masked };
    }
  }
  return best.masked.map((line) => line.map((dark) => (dark ? '1' : '0')).join(''));
}

module.exports = { qrCode };

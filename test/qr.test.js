const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const jsQR = require('jsqr');
const { qrCode } = require('../lib/qr');

// Reads a symbol back the way a phone would: drawn dark on white with its margin, then decoded
// by a reader that shares nothing with the encoder.
function read(rows, { margin = 4, scale = 6 } = {}) {
  const side = (rows.length + 2 * margin) * scale;
  const pixels = new Uint8ClampedArray(side * side * 4).fill(255);
  rows.forEach((row, y) =>
    [...row].forEach((module, x) => {
      if (module !== '1') {
        return;
      }
      for (let dy = 0; dy < scale; dy += 1) {
        for (let dx = 0; dx < scale; dx += 1) {
          const at = (((y + margin) * scale + dy) * side + (x + margin) * scale + dx) * 4;
          pixels[at] = 0;
          pixels[at + 1] = 0;
          pixels[at + 2] = 0;
        }
      }
    })
  );
  return jsQR(pixels, side, side)?.data ?? null;
}

describe('QR code', () => {
  it('encodes a claim link a reader gets back', () => {
    const link = 'https://milesastern.example/pair?code=K7QF-3MXB';

    const rows = qrCode(link);

    assert.equal(rows.length, 33, 'version 4');
    assert.ok(rows.every((row) => /^[01]{33}$/.test(row)));
    assert.equal(read(rows), link);
  });

  it('is read back at every length it takes, across all six versions', () => {
    const sizes = new Set();
    for (let length = 1; length <= 106; length += 1) {
      const text = Array.from({ length }, (_, i) =>
        String.fromCharCode(33 + ((i * 7 + length) % 90))
      ).join('');
      const rows = qrCode(text);
      sizes.add(rows.length);
      assert.equal(read(rows), text, `${length} characters`);
    }
    assert.deepEqual([...sizes], [21, 25, 29, 33, 37, 41]);
  });

  it('counts bytes, not characters', () => {
    const text = 'Île d’Yeu → Les Sables';

    assert.equal(read(qrCode(text)), text);
    assert.equal(qrCode('é'.repeat(53)).length, 41);
    assert.equal(qrCode('é'.repeat(54)), null);
  });

  it('gives up on a text too long rather than make a symbol nobody reads', () => {
    assert.equal(qrCode('x'.repeat(107)), null);
  });

  it('makes the same symbol for the same text', () => {
    assert.deepEqual(qrCode('https://service.test/pair'), qrCode('https://service.test/pair'));
  });
});

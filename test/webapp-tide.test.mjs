import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { hourTicks, smoothPath, tideExtremes } from '../public/js/tide.mjs';

const at = (hour) => `2026-09-13T${String(hour).padStart(2, '0')}:00:00.000Z`;

describe('tide extremes', () => {
  it('finds each high and low in a semi-diurnal curve', () => {
    const heights = [1, 2, 3, 4, 3, 2, 1, 0, -1, -2, -1, 0, 1];
    const points = heights.map((height, hour) => ({ time: at(hour), height }));

    const extremes = tideExtremes(points);

    assert.deepEqual(
      extremes.map((e) => [e.type, e.time, e.height]),
      [
        ['high', at(3), 4],
        ['low', at(9), -2]
      ]
    );
  });

  it('finds nothing in a monotonic run', () => {
    const points = [0, 1, 2, 3].map((height, hour) => ({ time: at(hour), height }));
    assert.deepEqual(tideExtremes(points), []);
  });

  it('needs at least three points to have an interior one', () => {
    assert.deepEqual(tideExtremes([]), []);
    assert.deepEqual(tideExtremes([{ time: at(0), height: 1 }]), []);
    assert.deepEqual(
      tideExtremes([
        { time: at(0), height: 1 },
        { time: at(1), height: 2 }
      ]),
      []
    );
  });

  it('misses an extreme exactly at either end of the window', () => {
    // Peaks right at the start and end, with nothing to compare against there.
    const heights = [4, 3, 2, 1, 2, 3, 4];
    const points = heights.map((height, hour) => ({ time: at(hour), height }));
    assert.deepEqual(
      tideExtremes(points).map((e) => e.time),
      [at(3)]
    );
  });
});

describe('smooth path', () => {
  it('draws a plain move for a single point', () => {
    assert.equal(smoothPath([{ x: 1, y: 2 }]), 'M 1 2');
  });

  it('draws a line for two points', () => {
    assert.equal(
      smoothPath([
        { x: 0, y: 0 },
        { x: 10, y: 5 }
      ]),
      'M 0 0 L 10 5'
    );
  });

  it('draws a quadratic segment per interior point, ending exactly at the last point', () => {
    const coords = [
      { x: 0, y: 0 },
      { x: 10, y: 10 },
      { x: 20, y: 0 },
      { x: 30, y: 10 }
    ];

    const d = smoothPath(coords);

    assert.match(d, /^M 0 0/);
    assert.equal((d.match(/Q/g) ?? []).length, 2);
    assert.match(d, /30 10$/, 'ends exactly at the last point');
  });

  it('is empty with no points', () => {
    assert.equal(smoothPath([]), '');
  });
});

describe('hour ticks', () => {
  const points = Array.from({ length: 25 }, (_, hour) => ({
    time: new Date(Date.UTC(2026, 8, 13, hour)).toISOString(),
    height: 0
  }));
  const label = (time) => time.slice(11, 16);

  it('keeps the samples on a multiple of three hours, labelled by the formatter', () => {
    const ticks = hourTicks(points, label);
    assert.deepEqual(
      ticks.map((tick) => tick.label),
      ['00:00', '03:00', '06:00', '09:00', '12:00', '15:00', '18:00', '21:00', '00:00']
    );
    assert.equal(ticks[1].time, points[3].time);
  });

  it('follows the local clock rather than UTC', () => {
    const local = (time) => label(new Date(Date.parse(time) + 2 * 3600e3).toISOString());
    assert.deepEqual(
      hourTicks(points, local, 6).map((tick) => tick.label),
      ['06:00', '12:00', '18:00', '00:00']
    );
  });

  it('has none for an empty curve', () => {
    assert.deepEqual(hourTicks([], label), []);
  });
});

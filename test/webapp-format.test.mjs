import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createFormatter } from '../public/js/format.mjs';

const KNOT = 1852 / 3600;
const english = createFormatter({ locale: 'en', units: { knots: 'kn', nauticalMiles: 'nm' } });
const french = createFormatter({ locale: 'fr', units: { knots: 'nd', nauticalMiles: 'M' } });

describe('display formatting', () => {
  it('converts speed and distance to nautical units in the locale', () => {
    assert.equal(english.speed(6.2 * KNOT), '6.2 kn');
    assert.equal(french.speed(6.2 * KNOT), '6,2 nd');
    assert.equal(english.distance(68500), '37.0 nm');
    assert.equal(french.distance(1852 * 12.25), '12,3 M');
  });

  it('writes a date with its year, in the locale', () => {
    const utc = createFormatter({ locale: 'en', units: {}, timeZone: 'UTC' });
    const paris = createFormatter({ locale: 'fr', units: {}, timeZone: 'UTC' });
    assert.equal(utc.date('2026-09-13T08:00:00.000Z'), 'Sep 13, 2026');
    assert.equal(paris.date('2026-09-13T08:00:00.000Z'), '13 sept. 2026');
  });

  it('shows bearings on three digits and apparent angles signed', () => {
    assert.equal(english.bearing(Math.PI / 2), '090°');
    assert.equal(english.bearing(2 * Math.PI - 0.001), '000°');
    assert.equal(english.angle(-Math.PI / 4), '-45°');
    assert.equal(english.angle(Math.PI / 3), '+60°');
  });

  it('converts pressure, temperature and depth', () => {
    assert.equal(english.pressure(101325), '1,013 hPa');
    assert.equal(french.temperature(291.15), '18,0 °C');
    assert.equal(english.depth(12.34), '12.3 m');
  });

  it('reads engine hour counters in hours with a decimal', () => {
    assert.equal(english.hours(812.46 * 3600), '812.5 h');
    // French groups thousands with a narrow no-break space.
    assert.equal(french.hours(1234.5 * 3600), '1\u202f234,5 h');
    assert.equal(english.hours(null), '');
  });

  it('writes levels, volumes and electrical readings', () => {
    assert.equal(english.percent(0.856), '86%');
    assert.equal(french.percent(0.5), '50\u00a0%');
    assert.equal(french.volume(0.0965), '97 L');
    assert.equal(english.voltage(12.84), '12.8 V');
    assert.equal(french.current(-3.25), '-3,3 A');
    assert.equal(english.percent(null), '');
  });

  it('writes rain in millimetres and wave periods in seconds', () => {
    assert.equal(english.precipitation(0.0024), '2.4 mm');
    assert.equal(french.precipitation(0.0005), '0,5 mm');
    assert.equal(english.period(7.4), '7 s');
    assert.equal(english.precipitation(null), '');
    assert.equal(english.period(undefined), '');
  });

  it('groups the thousands of a count', () => {
    assert.equal(english.count(43230), '43,230');
    assert.equal(french.count(43230), '43\u202f230');
    assert.equal(english.count(null), '');
  });

  it('writes durations in hours and minutes', () => {
    assert.equal(english.duration(45 * 60), '45 min');
    assert.equal(english.duration(3 * 3600 + 5 * 60), '3 h 05');
  });

  it('writes positions in degrees and decimal minutes', () => {
    assert.equal(english.position({ lat: 46.1466, lon: -1.1686 }), '46°08.80′N 001°10.12′W');
    assert.equal(english.position({ lat: -16.99999, lon: 179.5 }), '17°00.00′S 179°30.00′E');
  });

  it('leaves missing readings blank', () => {
    for (const format of [
      'speed',
      'distance',
      'bearing',
      'angle',
      'depth',
      'pressure',
      'duration'
    ]) {
      assert.equal(english[format](null), '', format);
    }
    assert.equal(english.position(null), '');
  });
});

describe('display formatting in a time zone', () => {
  const paris = createFormatter({
    locale: 'fr',
    units: { knots: 'nd', nauticalMiles: 'M' },
    timeZone: 'Europe/Paris'
  });
  const utc = createFormatter({
    locale: 'en',
    units: { knots: 'kn', nauticalMiles: 'nm' },
    timeZone: 'UTC'
  });

  it('shows times and calendar days in that zone', () => {
    const lateEvening = '2026-09-13T22:30:00.000Z';
    assert.equal(paris.time(lateEvening), '00:30');
    assert.equal(paris.dayKey(lateEvening), '2026-09-14');
    assert.equal(utc.time(lateEvening), '22:30');
    assert.equal(utc.dayKey(lateEvening), '2026-09-13');
  });

  it('names the UTC offset in force, daylight saving included', () => {
    assert.equal(paris.utcOffset('2026-07-01T12:00:00Z'), 'UTC+02:00');
    assert.equal(paris.utcOffset('2026-12-01T12:00:00Z'), 'UTC+01:00');
    assert.equal(utc.utcOffset('2026-07-01T12:00:00Z'), 'UTC');
  });

  it('writes an instant as a datetime-local field reads it, in that zone', () => {
    assert.equal(paris.dateTimeInput('2026-09-13T22:30:00.000Z'), '2026-09-14T00:30');
    assert.equal(utc.dateTimeInput('2026-09-13T22:30:00.000Z'), '2026-09-13T22:30');
    assert.equal(paris.dateTimeInput('2026-12-01T09:05:00.000Z'), '2026-12-01T10:05');
  });

  it('reads a datetime-local field back to the instant it stands for', () => {
    assert.equal(paris.fromDateTimeInput('2026-09-14T00:30'), '2026-09-13T22:30:00.000Z');
    assert.equal(utc.fromDateTimeInput('2026-09-13T22:30'), '2026-09-13T22:30:00.000Z');
    // Winter, so the zone is an hour ahead of UTC rather than two.
    assert.equal(paris.fromDateTimeInput('2026-12-01T10:05'), '2026-12-01T09:05:00.000Z');
    // A field stepped finer than a minute supplies seconds, which are dropped.
    assert.equal(paris.fromDateTimeInput('2026-12-01T10:05:42'), '2026-12-01T09:05:00.000Z');
  });

  it('settles on the offset of the reading itself across a daylight-saving change', () => {
    // Paris springs forward at 02:00 local on 2026-03-29: 03:30 is already summer
    // time, an hour less from UTC than the offset in force half an hour earlier.
    assert.equal(paris.fromDateTimeInput('2026-03-29T01:30'), '2026-03-29T00:30:00.000Z');
    assert.equal(paris.fromDateTimeInput('2026-03-29T03:30'), '2026-03-29T01:30:00.000Z');
    assert.equal(paris.dateTimeInput('2026-03-29T01:30:00.000Z'), '2026-03-29T03:30');
  });

  it('has nothing to read from an empty or malformed field', () => {
    for (const value of ['', '2026-09-13', 'tomorrow', null, undefined]) {
      assert.equal(paris.fromDateTimeInput(value), null, `${value}`);
    }
  });
});

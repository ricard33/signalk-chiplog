import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createFormatter } from '../public/js/format.mjs';
import { createTranslator } from '../public/js/i18n.mjs';
import {
  batteryName,
  buildRows,
  describeEvent,
  engineHours,
  engineName,
  tankName
} from '../public/js/log-lines.mjs';

const t = createTranslator('en');
const format = createFormatter({ locale: 'en', units: { knots: 'kn', nauticalMiles: 'nm' } });
const KNOT = 1852 / 3600;
const describe_ = (event, labels) => describeEvent(event, { t, format, manoeuvreLabels: labels });

describe('logbook lines', () => {
  it('describes manoeuvres, with the sail and the custom label', () => {
    assert.deepEqual(
      describe_({
        type: 'manoeuvre',
        subtype: 'sail_change',
        payload: { sail: 'genoa' },
        comment: 'Wind easing'
      }),
      {
        label: 'Sail change',
        detail: '(sail: Genoa)',
        comment: 'Wind easing',
        strokes: null,
        alarm: false
      }
    );
    assert.equal(
      describe_({ type: 'manoeuvre', subtype: 'spi_up' }, { spi_up: 'Hoist spi' }).label,
      'Hoist spi'
    );
    assert.equal(describe_({ type: 'manoeuvre', subtype: 'unknown_key' }).label, 'unknown_key');
  });

  it('describes notes, handwriting and alarms', () => {
    assert.deepEqual(describe_({ type: 'text_annotation', comment: 'Dolphins' }), {
      label: null,
      detail: 'Dolphins',
      comment: null,
      strokes: null,
      alarm: false
    });
    const strokes = [{ points: [{ x: 0, y: 0, t: 0 }] }];
    assert.equal(
      describe_({ type: 'handwritten_annotation', payload: { strokes } }).strokes,
      strokes
    );
    const raised = describe_({
      type: 'sk_alarm',
      subtype: 'notifications.mob',
      comment: 'MOB',
      payload: { state: 'emergency', message: 'MOB' }
    });
    assert.deepEqual([raised.label, raised.alarm, raised.comment], ['Alarm: MOB', true, null]);
    const annotated = describe_({
      type: 'sk_alarm',
      comment: 'Pierre recovered',
      payload: { state: 'normal', message: 'MOB' }
    });
    assert.equal(annotated.comment, 'Pierre recovered');
    const cleared = describe_({
      type: 'sk_alarm',
      subtype: 'notifications.mob',
      payload: { state: 'normal' }
    });
    assert.deepEqual([cleared.detail, cleared.alarm], ['Alarm cleared: notifications.mob', false]);
  });

  it('translates the autopilot modes it knows and keeps the others as they are', () => {
    const fr = createTranslator('fr');
    const describeFr = (event) => describeEvent(event, { t: fr, format, manoeuvreLabels: {} });
    const engaged = (mode) => ({
      type: 'autopilot',
      subtype: 'engaged',
      payload: { mode, target: Math.PI / 2 }
    });
    assert.equal(describeFr(engaged('heading')).detail, 'Pilote automatique embrayé (cap 090°)');
    assert.equal(describeFr(engaged('wind')).detail, 'Pilote automatique embrayé (vent 090°)');
    assert.equal(describe_(engaged('route')).detail, 'Autopilot engaged (route 090°)');
    assert.equal(describe_(engaged('custom')).detail, 'Autopilot engaged (custom 090°)');
  });

  it('describes autopilot, weather and corrections', () => {
    assert.equal(
      describe_({
        type: 'autopilot',
        subtype: 'engaged',
        payload: { mode: 'compass', target: Math.PI / 2 }
      }).detail,
      'Autopilot engaged (compass 090°)'
    );
    assert.equal(
      describe_({ type: 'autopilot', subtype: 'disengaged' }).detail,
      'Autopilot disengaged'
    );
    assert.equal(
      describe_({
        type: 'weather_threshold',
        subtype: 'wind_above',
        payload: { threshold: 20 * KNOT, windSpeed: 22 * KNOT }
      }).detail,
      'Wind above 20.0 kn (average 22.0 kn)'
    );
    assert.equal(
      describe_({
        type: 'manual_correction',
        subtype: 'propulsion',
        payload: { before: { type: 'engine' }, after: { type: 'sail' } }
      }).detail,
      'Corrected: engine → sail'
    );
    assert.equal(
      describe_({
        type: 'propulsion_change',
        payload: { before: { type: 'sail' }, after: { type: 'engine' } }
      }).detail,
      'Under way under engine'
    );
    assert.equal(
      describe_({
        type: 'propulsion_change',
        payload: { before: { type: 'engine' }, after: { type: 'sail' } }
      }).detail,
      'Under way under sail'
    );
  });

  it('describes a heading change', () => {
    assert.equal(
      describe_({
        type: 'heading_change',
        payload: { heading: Math.PI / 2, previousHeading: 0 }
      }).detail,
      'Heading changed to 090°'
    );
  });

  it('describes a stop uncovered by merging two entries', () => {
    const stopover = describe_({
      type: 'stopover',
      comment: 'Ile de Ré',
      payload: { placeName: 'Ile de Ré', placePending: true }
    });
    assert.deepEqual([stopover.detail, stopover.comment], ['Stopped at Ile de Ré', null]);

    const annotated = describe_({
      type: 'stopover',
      comment: 'Anchored to wait out the tide',
      payload: { placeName: 'Ile de Ré', placePending: false }
    });
    assert.equal(annotated.comment, 'Anchored to wait out the tide');
  });

  it('gives each engine its counter at departure and arrival and the hours run', () => {
    const hours = (value) => value * 3600;
    assert.deepEqual(
      engineHours([
        { engineRuntimes: null },
        { engineRuntimes: { port: hours(812), starboard: hours(798) } },
        { engineRuntimes: { port: hours(813.5) } },
        { engineRuntimes: { port: hours(814), starboard: hours(799.5) } }
      ]),
      [
        { engine: 'port', start: hours(812), end: hours(814), run: hours(2) },
        { engine: 'starboard', start: hours(798), end: hours(799.5), run: hours(1.5) }
      ]
    );
    assert.deepEqual(engineHours([{ engineRuntimes: null }, {}]), []);
    assert.equal(engineName('starboard', createTranslator('fr')), 'tribord');
    assert.equal(engineName('2', t), '2');
  });

  it('names tanks and batteries as the crew does', () => {
    const fr = createTranslator('fr');
    const fuel0 = { type: 'fuel', id: '0' };
    const fuel1 = { type: 'fuel', id: '1' };
    const water = { type: 'freshWater', id: '0' };
    assert.equal(tankName(water, fr, [fuel0, fuel1, water]), 'Eau douce');
    assert.equal(tankName(fuel1, t, [fuel0, fuel1, water]), 'Fuel 1');
    assert.equal(tankName({ type: 'fuel', id: '0', name: 'Day tank' }, t), 'Day tank');
    assert.equal(tankName({ type: 'hydrogen', id: '0' }, t), 'hydrogen');

    assert.equal(batteryName({ id: 'house' }, fr), 'Servitude');
    assert.equal(batteryName({ id: '2' }, t), 'Battery 2');
    assert.equal(batteryName({ id: 'bow', name: 'Bow thruster' }, t), 'Bow thruster');
    assert.equal(batteryName({ id: 'bow' }, t), 'bow');
  });

  it('puts a snapshot taken for an event on the event line', () => {
    const rows = buildRows(
      [{ id: 1, time: '2026-09-13T10:00:00.000Z', type: 'manoeuvre', subtype: 'tack' }],
      [
        { id: 7, time: '2026-09-13T10:00:00.000Z', reason: 'event', sog: 3 },
        { id: 8, time: '2026-09-13T09:00:00.000Z', reason: 'periodic', sog: 2 }
      ]
    );
    assert.deepEqual(
      rows.map((row) => [row.key, row.readings?.id ?? null]),
      [
        ['reading-8', 8],
        ['event-1', 7]
      ]
    );
  });
});

describe('sail sets', () => {
  const t = createTranslator('en');
  const change = (payload, time = 1) => ({
    type: 'manoeuvre',
    subtype: 'sail_change',
    time,
    payload
  });

  it('reads the set a sail change left, down to none', async () => {
    const { currentSails, sailsOf } = await import('../public/js/log-lines.mjs');
    assert.deepEqual(sailsOf({ sails: ['main', 'genoa'], sail: 'Mainsail + Genoa' }), [
      'main',
      'genoa'
    ]);
    assert.deepEqual(sailsOf({ sail: 'jib' }), ['jib']);
    assert.deepEqual(sailsOf(null), []);
    const events = [
      change({ sails: ['main'] }),
      { type: 'text_annotation' },
      change({ sails: [] })
    ];
    assert.deepEqual(currentSails(events.slice(0, 2)), ['main']);
    assert.deepEqual(currentSails(events), []);
    assert.deepEqual(currentSails([]), []);
  });

  it('reads who a watch change leaves on watch, and words it', async () => {
    const { currentWatch, describeEvent, watchOf } = await import('../public/js/log-lines.mjs');
    const watch = (crew) => ({
      type: 'manoeuvre',
      subtype: 'watch_change',
      time: '2025-07-01T10:00:00.000Z',
      payload: crew && { crew }
    });
    assert.deepEqual(watchOf({ crew: ['Alex', 'Sam'] }), ['Alex', 'Sam']);
    assert.deepEqual(watchOf(null), []);
    assert.deepEqual(currentWatch([watch(['Alex']), { type: 'text_annotation' }]), ['Alex']);
    assert.deepEqual(currentWatch([watch(['Alex']), watch([])]), []);
    const t = Object.assign((key, values) => `${key}${values ? JSON.stringify(values) : ''}`, {
      has: () => false
    });
    const line = (event) => describeEvent(event, { t, format: {} });
    assert.equal(line(watch(['Alex', 'Sam'])).detail, '(event.onWatch{"crew":"Alex, Sam"})');
    assert.equal(line(watch([])).detail, '(event.watchEnded)');
    assert.equal(line(watch(null)).detail, null);
  });

  it('words a set, and the sails brought down', async () => {
    const { describeEvent } = await import('../public/js/log-lines.mjs');
    const up = describeEvent(change({ sails: ['main', 'genoa'], sail: 'Mainsail + Genoa' }), {
      t,
      format: {}
    });
    assert.equal(up.detail, '(sail: Mainsail + Genoa)');
    const down = describeEvent(change({ sails: [] }), { t, format: {} });
    assert.equal(down.detail, '(sails down)');
  });
});

describe('engines started by hand', () => {
  it('say which engine runs on the propulsion change', async () => {
    const { describeEvent } = await import('../public/js/log-lines.mjs');
    const t = createTranslator('en');
    const line = describeEvent(
      {
        type: 'propulsion_change',
        payload: { after: { type: 'engine' }, engines: { Port: true, Starboard: false } }
      },
      { t, format: {} }
    );
    assert.match(line.detail, /Port running, Starboard stopped/);
    const plain = describeEvent(
      { type: 'propulsion_change', payload: { after: { type: 'sail' } } },
      { t, format: {} }
    );
    assert.doesNotMatch(plain.detail, /\(/);
  });
});

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, it, beforeEach, afterEach } = require('node:test');
const { at, startServer, insert, insertEntry } = require('./helpers');

function seedPassage(db) {
  const entryId = insertEntry(db, {
    start_time: at(0),
    end_time: at(4),
    start_lat: 46.1591,
    start_lon: -1.1522,
    end_lat: 46.5,
    end_lon: -1.79,
    start_place_name: 'La Rochelle',
    end_place_name: 'Les Sables',
    start_tanks: JSON.stringify([{ type: 'fuel', id: '0', level: 0.8 }]),
    distance: 68500
  });
  insert(db, 'track_points', { entry_id: entryId, time: at(0), lat: 46.1591, lon: -1.1522 });
  insert(db, 'track_points', {
    entry_id: entryId,
    time: at(1),
    lat: 46.25,
    lon: -1.3,
    sog: 3.086667,
    cog: Math.PI / 2,
    stw: 2.9,
    tws: 7.716667,
    twd: 2 * Math.PI - 0.001,
    heading: Math.PI / 2 - 0.05
  });
  insert(db, 'observations', {
    entry_id: entryId,
    time: at(1),
    reason: 'periodic',
    lat: 46.25,
    lon: -1.3,
    sog: 3.086667,
    cog: Math.PI / 2,
    tws: 7.716667,
    twd: 2 * Math.PI - 0.001,
    awa: -Math.PI / 4,
    pressure: 101325,
    water_temp: 291.15,
    engine_runtime: 812.5 * 3600,
    engine_runtimes: JSON.stringify({ port: 812.5 * 3600, starboard: 798.25 * 3600 })
  });
  insert(db, 'events', {
    entry_id: entryId,
    time: at(2),
    type: 'text_annotation',
    comment: '=HYPERLINK("evil"), with "quotes"',
    created_at: at(2)
  });
  return entryId;
}

describe('export', () => {
  let ctx;
  let exportDir;

  beforeEach(async () => {
    exportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chiplog-usb-'));
    ctx = await startServer({ config: { usbExportPath: exportDir } });
  });

  afterEach(async () => {
    await ctx.close();
    fs.rmSync(exportDir, { recursive: true, force: true });
  });

  describe('GET /entries/:id/track', () => {
    it('returns GeoJSON by default', async () => {
      const id = seedPassage(ctx.db);
      const { status, body } = await ctx.request('GET', `/entries/${id}/track`);

      assert.equal(status, 200);
      assert.equal(body.type, 'Feature');
      assert.equal(body.geometry.type, 'LineString');
      assert.deepEqual(body.geometry.coordinates[0], [-1.1522, 46.1591]);
      assert.deepEqual(body.properties.coordTimes, [at(0), at(1)]);
      assert.deepEqual(body.properties.readings[0], {
        sog: null,
        cog: null,
        stw: null,
        tws: null,
        twd: null,
        awa: null,
        heading: null
      });
      assert.deepEqual(body.properties.readings[1], {
        sog: 3.086667,
        cog: Math.PI / 2,
        stw: 2.9,
        tws: 7.716667,
        twd: 2 * Math.PI - 0.001,
        awa: null,
        heading: Math.PI / 2 - 0.05
      });
    });

    it('returns GPX on request', async () => {
      const id = seedPassage(ctx.db);
      const { status, headers, text } = await ctx.request('GET', `/entries/${id}/track?format=gpx`);

      assert.equal(status, 200);
      assert.match(headers.get('content-type'), /application\/gpx\+xml/);
      assert.match(text, /<name>La Rochelle - Les Sables<\/name>/);
      assert.equal(text.match(/<trkpt /g).length, 2);
    });
  });

  describe('GET /export', () => {
    it('exports the complete logbook as JSON in SI units', async () => {
      seedPassage(ctx.db);
      const { status, headers, body } = await ctx.request('GET', '/export');

      assert.equal(status, 200);
      assert.match(headers.get('content-disposition'), /chiplog\.json/);
      assert.equal(body.schemaVersion, 19);
      assert.equal(body.entries.length, 1);
      const [bundle] = body.entries;
      assert.equal(bundle.entry.distance, 68500);
      assert.equal(bundle.trackPoints.length, 2);
      assert.equal(bundle.observations[0].sog, 3.086667);
      assert.deepEqual(bundle.observations[0].engineRuntimes, {
        port: 812.5 * 3600,
        starboard: 798.25 * 3600
      });
      assert.deepEqual(bundle.entry.startTanks, [{ type: 'fuel', id: '0', level: 0.8 }]);
      assert.equal(bundle.entry.startBatteries, null);
      assert.equal(bundle.events.length, 1);
      assert.equal(bundle.weather, null);
    });

    it('exports CSV logbook lines converted to nautical units', async () => {
      seedPassage(ctx.db);
      const { status, headers, text } = await ctx.request('GET', '/export?format=csv');

      assert.equal(status, 200);
      assert.match(headers.get('content-type'), /text\/csv/);

      const [header, ...rows] = text.trim().split('\r\n');
      const columns = header.split(',');
      assert.deepEqual(
        rows.map((row) => row.split(',')[columns.indexOf('kind')]),
        ['departure', 'observation', 'event', 'arrival']
      );

      const observation = Object.fromEntries(
        rows[1].split(',').map((value, index) => [columns[index], value])
      );
      assert.equal(observation.sog_kn, '6');
      assert.equal(observation.cog_deg, '90');
      assert.equal(observation.tws_kn, '15');
      assert.equal(observation.twd_deg, '0');
      assert.equal(observation.awa_deg, '-45');
      assert.equal(observation.pressure_hpa, '1013.3');
      assert.equal(observation.water_temp_c, '18');
      assert.equal(observation.engine_runtime_h, '812.5');
      assert.equal(observation.engine_runtime_port_h, '812.5');
      assert.equal(observation.engine_runtime_starboard_h, '798.3');
      assert.deepEqual(columns.slice(-2), ['engine_runtime_port_h', 'engine_runtime_starboard_h']);
    });

    it('neutralises spreadsheet formulas and escapes quotes in free text', async () => {
      seedPassage(ctx.db);
      const { text } = await ctx.request('GET', '/export?format=csv');
      assert.ok(text.includes(`"'=HYPERLINK(""evil""), with ""quotes"""`));
    });

    it('limits the export to a date range', async () => {
      seedPassage(ctx.db);
      insertEntry(ctx.db, { start_time: at(48), end_time: at(50) });

      const { body } = await ctx.request('GET', `/export?from=${encodeURIComponent(at(24))}`);
      assert.equal(body.entries.length, 1);
      assert.equal(body.entries[0].entry.startTime, at(48));
    });

    it('serves the facsimile PDF in the requested language and time zone', async () => {
      seedPassage(ctx.db);

      const { status, headers, text } = await ctx.request(
        'GET',
        '/export?format=pdf&lang=fr&tz=Europe/Paris'
      );

      assert.equal(status, 200);
      assert.match(headers.get('content-type'), /^application\/pdf/);
      assert.match(headers.get('content-disposition'), /chiplog\.pdf/);
      assert.ok(text.startsWith('%PDF-1.4'));
    });

    it('refuses an unknown language or time zone', async () => {
      for (const query of ['lang=de', 'tz=Mars/Olympus']) {
        const { status, body } = await ctx.request('GET', `/export?format=pdf&${query}`);
        assert.equal(status, 400, query);
        assert.equal(body.error.code, 'invalid_request');
      }
    });
  });

  describe('POST /export/usb', () => {
    const usbDir = () => path.join(exportDir, 'chiplog');
    const passageFiles = () =>
      fs
        .readdirSync(usbDir())
        .filter((name) => !name.startsWith('.'))
        .sort();
    const mtimes = () =>
      Object.fromEntries(
        passageFiles().map((name) => [name, fs.statSync(path.join(usbDir(), name)).mtimeMs])
      );
    const exportUsb = async () => (await ctx.request('POST', '/export/usb')).body;
    // Lets mtimes tell a rewrite apart on file systems with coarse timestamps.
    const pause = () => new Promise((resolve) => setTimeout(resolve, 20));

    function seedSecondPassage(db, fields = {}) {
      return insertEntry(db, {
        start_time: at(26),
        end_time: at(30),
        start_place_name: 'Les Sables',
        end_place_name: 'Île d’Yeu (Port-Joinville)',
        ...fields
      });
    }

    it('writes JSON, CSV, GPX and PDF for each passage, named to sort by departure', async () => {
      seedSecondPassage(ctx.db);
      seedPassage(ctx.db);

      const { status, body } = await ctx.request('POST', '/export/usb');

      assert.equal(status, 200);
      assert.equal(body.directory, usbDir());
      assert.deepEqual([body.entries, body.written, body.unchanged], [2, 2, 0]);
      assert.deepEqual(passageFiles(), [
        '2026-09-13_0800Z_La-Rochelle_Les-Sables.csv',
        '2026-09-13_0800Z_La-Rochelle_Les-Sables.gpx',
        '2026-09-13_0800Z_La-Rochelle_Les-Sables.json',
        '2026-09-13_0800Z_La-Rochelle_Les-Sables.pdf',
        '2026-09-14_1000Z_Les-Sables_Ile-d-Yeu-Port-Joinville.csv',
        '2026-09-14_1000Z_Les-Sables_Ile-d-Yeu-Port-Joinville.gpx',
        '2026-09-14_1000Z_Les-Sables_Ile-d-Yeu-Port-Joinville.json',
        '2026-09-14_1000Z_Les-Sables_Ile-d-Yeu-Port-Joinville.pdf'
      ]);
      const json = JSON.parse(
        fs.readFileSync(path.join(usbDir(), '2026-09-13_0800Z_La-Rochelle_Les-Sables.json'), 'utf8')
      );
      assert.equal(json.entries.length, 1);
      assert.equal(json.entries[0].trackPoints.length, 2);
      const csv = fs.readFileSync(
        path.join(usbDir(), '2026-09-14_1000Z_Les-Sables_Ile-d-Yeu-Port-Joinville.csv'),
        'utf8'
      );
      assert.doesNotMatch(csv, /La Rochelle/, 'only its own passage');
    });

    it('leaves passages already on the drive alone', async () => {
      seedPassage(ctx.db);
      seedSecondPassage(ctx.db);
      await exportUsb();
      const before = mtimes();
      await pause();

      const body = await exportUsb();

      assert.deepEqual([body.written, body.unchanged, body.files.length], [0, 2, 0]);
      assert.deepEqual(mtimes(), before);
    });

    it('rewrites only a passage that changed since', async () => {
      const first = seedPassage(ctx.db);
      seedSecondPassage(ctx.db);
      await exportUsb();
      const before = mtimes();
      await pause();

      const [event] = (await ctx.request('GET', `/entries/${first}/events`)).body.items;
      await ctx.request('PATCH', `/events/${event.id}`, { comment: 'Corrected note' });
      const body = await exportUsb();

      assert.deepEqual([body.written, body.unchanged], [1, 1]);
      const after = mtimes();
      for (const name of passageFiles()) {
        assert.equal(after[name] !== before[name], name.startsWith('2026-09-13'), name);
      }
    });

    it('rewrites a passage once its weather forecast arrives, and exports it', async () => {
      const first = seedPassage(ctx.db);
      await exportUsb();
      await pause();

      ctx.db
        .prepare(
          `INSERT INTO weather_forecasts (entry_id, lat, lon, fetched_at, points)
           VALUES (?, 46.15, -1.17, ?, ?)`
        )
        .run(first, at(0), JSON.stringify([{ time: at(0), windSpeed: 6 }]));
      const body = await exportUsb();

      assert.deepEqual([body.written, body.unchanged], [1, 0]);
      const json = JSON.parse(
        fs.readFileSync(path.join(usbDir(), '2026-09-13_0800Z_La-Rochelle_Les-Sables.json'), 'utf8')
      );
      assert.deepEqual(json.entries[0].weather.points, [{ time: at(0), windSpeed: 6 }]);
    });

    it('rewrites a passage once its tide forecast arrives, and exports it', async () => {
      const first = seedPassage(ctx.db);
      await exportUsb();
      await pause();

      ctx.db
        .prepare(
          `INSERT INTO tide_forecasts (entry_id, lat, lon, fetched_at, points)
           VALUES (?, 46.15, -1.17, ?, ?)`
        )
        .run(first, at(0), JSON.stringify([{ time: at(0), height: 2.1 }]));
      const body = await exportUsb();

      assert.deepEqual([body.written, body.unchanged], [1, 0]);
      const json = JSON.parse(
        fs.readFileSync(path.join(usbDir(), '2026-09-13_0800Z_La-Rochelle_Les-Sables.json'), 'utf8')
      );
      assert.deepEqual(json.entries[0].tide.points, [{ time: at(0), height: 2.1 }]);
    });

    it('removes the files of passages renamed, merged or deleted, and nothing else', async () => {
      const first = seedPassage(ctx.db);
      const second = seedSecondPassage(ctx.db);
      await exportUsb();
      fs.writeFileSync(path.join(usbDir(), 'notes.txt'), 'mine');

      await ctx.request('PATCH', `/entries/${first}`, { endPlaceName: 'Les Sables-d’Olonne' });
      await ctx.request('DELETE', `/entries/${second}`);
      const body = await exportUsb();

      assert.equal(body.removed.length, 8);
      assert.deepEqual(passageFiles(), [
        '2026-09-13_0800Z_La-Rochelle_Les-Sables-d-Olonne.csv',
        '2026-09-13_0800Z_La-Rochelle_Les-Sables-d-Olonne.gpx',
        '2026-09-13_0800Z_La-Rochelle_Les-Sables-d-Olonne.json',
        '2026-09-13_0800Z_La-Rochelle_Les-Sables-d-Olonne.pdf',
        'notes.txt'
      ]);
    });

    it('names a passage in progress as under way until it arrives', async () => {
      const entryId = insertEntry(ctx.db, {
        state: 'active',
        start_time: at(0),
        start_place_name: null
      });
      await exportUsb();
      assert.deepEqual(passageFiles(), [
        '2026-09-13_0800Z_unnamed_underway.csv',
        '2026-09-13_0800Z_unnamed_underway.gpx',
        '2026-09-13_0800Z_unnamed_underway.json',
        '2026-09-13_0800Z_unnamed_underway.pdf'
      ]);

      ctx.db
        .prepare(
          "UPDATE log_entries SET state = 'closed', end_time = ?, end_place_name = ? WHERE id = ?"
        )
        .run(at(3), 'Saint-Martin-de-Ré', entryId);
      await exportUsb();
      assert.deepEqual(passageFiles(), [
        '2026-09-13_0800Z_unnamed_Saint-Martin-de-Re.csv',
        '2026-09-13_0800Z_unnamed_Saint-Martin-de-Re.gpx',
        '2026-09-13_0800Z_unnamed_Saint-Martin-de-Re.json',
        '2026-09-13_0800Z_unnamed_Saint-Martin-de-Re.pdf'
      ]);
    });

    it('keeps files found on the drive without a record, and rewrites missing ones', async () => {
      seedPassage(ctx.db);
      await exportUsb();
      fs.rmSync(path.join(usbDir(), '.chiplog-export.json'));
      const before = mtimes();
      await pause();

      assert.equal((await exportUsb()).written, 0);
      assert.deepEqual(mtimes(), before);

      fs.rmSync(path.join(usbDir(), '2026-09-13_0800Z_La-Rochelle_Les-Sables.gpx'));
      assert.equal((await exportUsb()).written, 1);
      assert.equal(passageFiles().length, 4);
    });

    it('tells passages starting in the same minute apart', async () => {
      seedPassage(ctx.db);
      insertEntry(ctx.db, {
        start_time: '2026-09-13T08:00:30.000Z',
        end_time: at(5),
        start_place_name: 'La Rochelle',
        end_place_name: 'Les Sables'
      });
      await exportUsb();
      assert.equal(passageFiles().length, 8);
      assert.ok(passageFiles().includes('2026-09-13_0800Z_La-Rochelle_Les-Sables_2.json'));
    });

    it('answers 409 when the directory is not available', async () => {
      fs.rmSync(exportDir, { recursive: true, force: true });
      const { status, body } = await ctx.request('POST', '/export/usb');
      assert.equal(status, 409);
      assert.equal(body.error.code, 'usb_export_unavailable');
    });
  });
});

describe('export without a USB directory configured', () => {
  it('answers 409', async () => {
    const ctx = await startServer();
    try {
      const { status, body } = await ctx.request('POST', '/export/usb');
      assert.equal(status, 409);
      assert.equal(body.error.code, 'usb_export_not_configured');
    } finally {
      await ctx.close();
    }
  });
});

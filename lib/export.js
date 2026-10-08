const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { getSchemaVersion } = require('./database');
const { listEntryCrew } = require('./crew');
const { conflict } = require('./errors');
const { toEntry } = require('./entries');
const { allEvents } = require('./events');
const { toCsv, toGpx } = require('./formats');
const { listEntryLandmarks } = require('./landmarks');
const { renderLogbookPdf } = require('./logbook-pdf');
const { allSegments } = require('./propulsion');
const { allTrackPoints, allObservations } = require('./track');
const { getTideForecast } = require('./tide-forecaster');
const { getWeatherForecast } = require('./weather-forecaster');

const EXPORT_FORMATS = {
  json: {
    contentType: 'application/json',
    render: (bundles, meta) => `${JSON.stringify({ ...meta, entries: bundles }, null, 2)}\n`
  },
  csv: { contentType: 'text/csv; charset=utf-8', render: toCsv },
  gpx: { contentType: 'application/gpx+xml', render: toGpx },
  // `pdf` holds the logbook's language, time zone and vessel name.
  pdf: {
    contentType: 'application/pdf',
    render: (bundles, meta, pdf = {}) => renderLogbookPdf(bundles, { ...pdf, now: meta.exportedAt })
  }
};

function bundleOf(db, row) {
  return {
    entry: toEntry(row),
    trackPoints: allTrackPoints(db, row.id),
    observations: allObservations(db, row.id),
    propulsion: allSegments(db, row.id),
    events: allEvents(db, row.id),
    landmarks: listEntryLandmarks(db, row.id),
    tide: getTideForecast(db, row.id),
    weather: getWeatherForecast(db, row.id),
    crew: listEntryCrew(db, row.id)
  };
}

function collectBundles(db, { from, to }) {
  const conditions = [];
  const params = [];
  if (from !== undefined) {
    conditions.push('start_time >= ?');
    params.push(from);
  }
  if (to !== undefined) {
    conditions.push('start_time < ?');
    params.push(to);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  return db
    .prepare(`SELECT * FROM log_entries ${where} ORDER BY start_time, id`)
    .all(...params)
    .map((row) => bundleOf(db, row));
}

function exportMeta(db, now) {
  return { exportedAt: now, schemaVersion: getSchemaVersion(db), units: 'Signal K SI' };
}

async function renderExport(db, format, range, now, pdf) {
  const { contentType, render } = EXPORT_FORMATS[format];
  return {
    contentType,
    filename: `chiplog.${format}`,
    body: await render(collectBundles(db, range), exportMeta(db, now), pdf)
  };
}

// The drive may be pulled the moment a write returns when abandoning ship, so
// flush to the device before the rename makes the new file visible.
async function writeFileDurably(target, contents) {
  const temporary = `${target}.tmp`;
  const handle = await fs.open(temporary, 'w');
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temporary, target);
}

// The USB copy keeps one set of files per passage in this subdirectory, named
// so that sorting by name sorts by departure time.
const USB_SUBDIRECTORY = 'chiplog';
const MANIFEST = '.chiplog-export.json';
// Built from the formats, so a format added later is cleaned up too.
const PASSAGE_FILE = new RegExp(
  `^\\d{4}-\\d{2}-\\d{2}_\\d{4}Z_.+\\.(${Object.keys(EXPORT_FORMATS).join('|')})(\\.tmp)?$`
);
const NAME_PART_LENGTH = 40;

// FAT and exFAT drives refuse some characters, and accented names come back
// differently normalised from one system to another: plain ASCII is safest.
function namePart(text) {
  const slug = (text ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, NAME_PART_LENGTH)
    .replace(/-+$/, '');
  return slug || 'unnamed';
}

// 2026-09-13_0612Z_La-Rochelle_Les-Sables-d-Olonne, in UTC like every time in
// the logbook; a passage in progress ends in "underway" until it arrives.
function passageBaseName(row) {
  const start = row.start_time;
  const stamp = `${start.slice(0, 10)}_${start.slice(11, 13)}${start.slice(14, 16)}Z`;
  const arrival = row.state === 'active' ? 'underway' : namePart(row.end_place_name);
  return `${stamp}_${namePart(row.start_place_name)}_${arrival}`;
}

// Changes whenever anything exported for the passage does. Track points and
// observations are only ever added or moved by a merge, so their count and
// last id are enough; events and segments can be edited in place.
function passageFingerprint(db, row, pdf) {
  const summary = (table) =>
    db
      .prepare(`SELECT COUNT(*) AS n, IFNULL(MAX(id), 0) AS last FROM ${table} WHERE entry_id = ?`)
      .get(row.id);
  const hash = crypto.createHash('sha256');
  hash.update(JSON.stringify(row));
  // A different language, time zone or vessel name changes the PDF. The plugin
  // version does not count: upgrading does not rewrite the whole drive.
  hash.update(JSON.stringify([pdf.language, pdf.timeZone, pdf.vesselName]));
  hash.update(JSON.stringify([summary('track_points'), summary('observations')]));
  // The tide and weather forecasts each arrive once, after departure, and are printed.
  for (const table of ['tide_forecasts', 'weather_forecasts']) {
    const forecast = db.prepare(`SELECT fetched_at FROM ${table} WHERE entry_id = ?`).get(row.id);
    hash.update(JSON.stringify(forecast?.fetched_at ?? null));
  }
  // The landmarks a passage is read against arrive area by area, well after
  // the sailing, and the PDF prints them: a copy already on the drive is worth
  // rewriting once they do.
  for (const landmark of listEntryLandmarks(db, row.id)) {
    hash.update(JSON.stringify([landmark.id, landmark.updatedAt]));
  }
  for (const table of ['propulsion_segments', 'events']) {
    for (const item of db
      .prepare(`SELECT * FROM ${table} WHERE entry_id = ? ORDER BY id`)
      .iterate(row.id)) {
      hash.update(JSON.stringify(item));
    }
  }
  return hash.digest('hex');
}

async function readManifest(directory) {
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(directory, MANIFEST), 'utf8'));
    return manifest && typeof manifest.passages === 'object' ? manifest.passages : {};
  } catch {
    return {};
  }
}

async function exists(file) {
  return fs.stat(file).then(
    () => true,
    () => false
  );
}

// Writes the files of passages that are new or changed since the last export,
// leaves the others alone — a USB drive is slow and wears — and removes the
// files of passages that were deleted, merged or renamed.
async function writeUsbExport(db, directory, now, pdf = {}) {
  const stats = await fs.stat(directory).catch(() => null);
  if (!stats || !stats.isDirectory()) {
    throw conflict(
      'usb_export_unavailable',
      `Export directory ${directory} is not available; is the USB drive mounted?`
    );
  }
  const target = path.join(directory, USB_SUBDIRECTORY);
  await fs.mkdir(target, { recursive: true });

  const previous = await readManifest(target);
  const passages = {};
  const expected = new Set();
  const written = [];
  let unchanged = 0;
  const meta = exportMeta(db, now);
  const taken = new Set();

  for (const row of db.prepare('SELECT * FROM log_entries ORDER BY start_time, id').all()) {
    let base = passageBaseName(row);
    for (let n = 2; taken.has(base); n += 1) {
      base = `${passageBaseName(row)}_${n}`;
    }
    taken.add(base);
    const files = Object.keys(EXPORT_FORMATS).map((format) => `${base}.${format}`);
    files.forEach((file) => expected.add(file));

    const fingerprint = passageFingerprint(db, row, pdf);
    const known = previous[row.id];
    const present = (await Promise.all(files.map((file) => exists(path.join(target, file))))).every(
      Boolean
    );
    // Files already on the drive with no record — a lost manifest — are taken
    // as they are rather than rewritten.
    const upToDate =
      present &&
      (known === undefined || (known.base === base && known.fingerprint === fingerprint));
    passages[row.id] = { base, fingerprint };
    if (upToDate) {
      unchanged += 1;
      continue;
    }

    const bundles = [bundleOf(db, row)];
    for (const [format, { render }] of Object.entries(EXPORT_FORMATS)) {
      const file = path.join(target, `${base}.${format}`);
      await writeFileDurably(file, await render(bundles, meta, pdf));
      written.push(file);
    }
  }

  const removed = [];
  for (const name of await fs.readdir(target)) {
    if (PASSAGE_FILE.test(name) && !expected.has(name)) {
      await fs.rm(path.join(target, name), { force: true });
      removed.push(path.join(target, name));
    }
  }
  await writeFileDurably(
    path.join(target, MANIFEST),
    `${JSON.stringify({ exportedAt: now, passages }, null, 2)}\n`
  );

  return {
    directory: target,
    entries: Object.keys(passages).length,
    written: written.length / Object.keys(EXPORT_FORMATS).length,
    unchanged,
    files: written,
    removed
  };
}

module.exports = { EXPORT_FORMATS, renderExport, writeUsbExport, passageFingerprint };

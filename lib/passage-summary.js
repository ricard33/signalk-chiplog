const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { escapeHtml } = require('./mail');

// What the summary email says about a passage (SPEC §4.16). Like the PDF
// logbook, its wording and units come from the webapp's own pure modules, so
// the mail, the passage page and the logbook all put the same figures the same
// way.

const MAP_CID = 'passage-map';

// Inline styles throughout: a mail reader keeps no stylesheet, and several
// strip <style> altogether.
const STYLE = {
  body: 'margin:0;padding:16px;background:#f4f6f8;font-family:Helvetica,Arial,sans-serif;color:#1f2933;',
  card: 'max-width:792px;margin:0 auto;background:#ffffff;border-radius:8px;padding:20px;',
  title: 'margin:0 0 4px;font-size:20px;line-height:1.3;color:#102a43;',
  when: 'margin:0 0 16px;font-size:14px;color:#52606d;',
  map: 'display:block;width:100%;max-width:760px;height:auto;border-radius:6px;',
  table: 'width:100%;border-collapse:collapse;margin-top:16px;font-size:14px;',
  label: 'padding:6px 12px 6px 0;color:#52606d;white-space:nowrap;',
  value: 'padding:6px 0;text-align:right;font-weight:bold;color:#102a43;',
  footer: 'margin:18px 0 0;font-size:12px;color:#7b8794;'
};

let sharedModules = null;

function loadShared() {
  const load = (file) =>
    import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', file)).href);
  sharedModules ??= Promise.all([load('i18n.mjs'), load('format.mjs')]).then(([i18n, format]) => ({
    i18n,
    format
  }));
  return sharedModules;
}

function placeName(name, pending, t) {
  if (!name) {
    return t('place.unknown');
  }
  return pending ? `${name} (?)` : name;
}

// Departure and arrival, each with its date and time; the day is repeated on
// the arrival only when the passage ran past midnight, as the logbook shows it.
function endpoints(entry, { t, format }) {
  const sameDay =
    entry.endTime !== null && format.dayKey(entry.startTime) === format.dayKey(entry.endTime);
  return [
    {
      label: t('passage.departure'),
      place: placeName(entry.startPlaceName, entry.startPlacePending, t),
      when: `${format.date(entry.startTime)} ${format.time(entry.startTime)}`
    },
    {
      label: t('passage.arrival'),
      place: placeName(entry.endPlaceName, entry.endPlacePending, t),
      when:
        entry.endTime === null
          ? ''
          : sameDay
            ? format.time(entry.endTime)
            : `${format.date(entry.endTime)} ${format.time(entry.endTime)}`
    }
  ];
}

// The figures the summary is asked for, in the order the passage page shows
// them. A figure with nothing behind it is left out rather than printed empty.
function figures(entry, { t, format }) {
  const underway = (entry.engineDuration ?? 0) + (entry.sailDuration ?? 0);
  const elapsed =
    entry.endTime === null
      ? null
      : Math.max(0, (Date.parse(entry.endTime) - Date.parse(entry.startTime)) / 1000);
  const rows = [
    [t('passage.distance'), format.distance(entry.distance)],
    [t('passage.duration'), format.duration(elapsed)],
    [t('passage.underway'), format.duration(underway)],
    [t('passage.engine'), format.duration(entry.engineDuration)],
    [t('passage.sail'), format.duration(entry.sailDuration)]
  ];
  if (underway > 0 && entry.distance !== null) {
    rows.push([t('passage.averageSpeed'), format.speed(entry.distance / underway)]);
  }
  if (entry.maxSpeed !== null && entry.maxSpeed !== undefined) {
    rows.push([t('passage.maxSpeed'), format.speed(entry.maxSpeed)]);
  }
  if (entry.maxWindSpeed !== null && entry.maxWindSpeed !== undefined) {
    rows.push([
      t('passage.maxWind'),
      entry.maxWindApparent
        ? `${format.speed(entry.maxWindSpeed)} ${t('timeline.apparent')}`
        : format.speed(entry.maxWindSpeed)
    ]);
  }
  return rows.filter(([, value]) => value !== '');
}

function htmlRow(label, value) {
  return `<tr><td style="${STYLE.label}">${escapeHtml(label)}</td><td style="${STYLE.value}">${escapeHtml(value)}</td></tr>`;
}

// `mapAvailable` says whether an image part accompanies the message; without
// one the <img> would show as a broken attachment.
async function renderPassageSummary(
  { entry, trackPoints = [] },
  { language = 'en', timeZone, vesselName = null, mapAvailable = false } = {}
) {
  const { i18n, format: formatModule } = await loadShared();
  const t = i18n.createTranslator(language);
  const format = formatModule.createFormatter({
    locale: language,
    units: { knots: t('unit.knots'), nauticalMiles: t('unit.nauticalMiles') },
    timeZone
  });
  const context = { t, format };

  const from = placeName(entry.startPlaceName, entry.startPlacePending, t);
  const to = placeName(entry.endPlaceName, entry.endPlacePending, t);
  const route = `${from} → ${to}`;
  const subject = vesselName
    ? t('mail.subjectVessel', { vessel: vesselName, route })
    : t('mail.subject', { route });
  const when = t('mail.when', {
    date: format.date(entry.startTime),
    zone: format.utcOffset(entry.startTime)
  });

  const lines = endpoints(entry, context);
  const facts = figures(entry, context);

  const text = [
    route,
    when,
    '',
    ...lines.map(({ label, place, when: at }) => `${label}: ${place}${at ? ` — ${at}` : ''}`),
    '',
    ...facts.map(([label, value]) => `${label}: ${value}`),
    ...(trackPoints.length === 0 ? ['', t('passage.noTrack')] : []),
    '',
    t('mail.footer')
  ].join('\n');

  const html = `<!doctype html>
<html lang="${language}"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width" /><title>${escapeHtml(subject)}</title></head>
<body style="${STYLE.body}">
<div style="${STYLE.card}">
<h1 style="${STYLE.title}">${escapeHtml(route)}</h1>
<p style="${STYLE.when}">${escapeHtml(when)}</p>
${
  mapAvailable
    ? `<img src="cid:${MAP_CID}" alt="${escapeHtml(t('mail.mapAlt'))}" style="${STYLE.map}" />`
    : `<p style="${STYLE.when}">${escapeHtml(t('passage.noTrack'))}</p>`
}
<table style="${STYLE.table}" role="presentation">
${lines.map(({ label, place, when: at }) => htmlRow(label, at ? `${place} — ${at}` : place)).join('\n')}
${facts.map(([label, value]) => htmlRow(label, value)).join('\n')}
</table>
<p style="${STYLE.footer}">${escapeHtml(t('mail.footer'))}</p>
</div>
</body></html>
`;

  return { subject, text, html };
}

module.exports = { renderPassageSummary, MAP_CID };

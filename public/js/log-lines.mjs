// The lines of a logbook, shared by the passage page and the PDF logbook: which
// reading goes on which line, and what each event says. Pure — the server
// imports it too — so strings only, no markup.

// What a client may edit beyond the comment, mirroring `CLIENT_EVENT_TYPES` in
// lib/events.js: an event the crew logged themselves. Narrower than
// `source: "manual"`, which also covers a `manual_correction`.
export const EDITABLE_EVENT_TYPES = ['manoeuvre', 'text_annotation', 'handwritten_annotation'];

function autopilotTarget(target, format) {
  if (typeof target === 'number') {
    return format.bearing(target);
  }
  const heading = target?.headingTrue ?? target?.headingMagnetic;
  if (heading !== undefined) {
    return format.bearing(heading);
  }
  const windAngle = target?.windAngleApparent ?? target?.windAngleTrue;
  return windAngle === undefined ? '' : format.angle(windAngle);
}

// A Signal K engine id as the crew says it: "port" becomes bâbord in French;
// an id without a translation is shown as it is.
export function engineName(id, t) {
  return t.has(`engine.${id}`) ? t(`engine.${id}`) : id;
}

// Each engine's hour counter at the first and last reading of a passage that
// has one, and the hours run in between.
export function engineHours(observations) {
  const engines = new Map();
  for (const observation of observations) {
    for (const [id, runtime] of Object.entries(observation.engineRuntimes ?? {})) {
      const engine = engines.get(id) ?? { engine: id, start: runtime, end: runtime };
      engine.end = runtime;
      engines.set(id, engine);
    }
  }
  return [...engines.values()].map((engine) => ({
    ...engine,
    run: Math.max(0, engine.end - engine.start)
  }));
}

// A tank as the crew calls it: the name the boat gives it, else its kind --
// "fuel 1" when there is more than one of that kind.
export function tankName(tank, t, tanks = []) {
  if (tank.name) {
    return tank.name;
  }
  const type = t.has(`tank.${tank.type}`) ? t(`tank.${tank.type}`) : tank.type;
  const sameType = tanks.filter((other) => other.type === tank.type);
  return sameType.length > 1 ? `${type} ${tank.id}` : type;
}

export function batteryName(battery, t) {
  if (battery.name) {
    return battery.name;
  }
  if (t.has(`battery.${battery.id}`)) {
    return t(`battery.${battery.id}`);
  }
  return /^\d+$/.test(battery.id) ? t('battery.numbered', { id: battery.id }) : battery.id;
}

export function manoeuvreName(key, t, manoeuvreLabels = {}) {
  const translation = `manoeuvre.${key}`;
  return t.has(translation) ? t(translation) : (manoeuvreLabels[key] ?? key);
}

export function sailName(sail, t) {
  return t.has(`sail.${sail}`) ? t(`sail.${sail}`) : sail;
}

// What an event says: `label` is the emphasised part, `detail` follows it,
// `comment` is the crew's own words, `strokes` a handwritten note, `alarm`
// marks a raised alarm.
export function describeEvent(event, { t, format, manoeuvreLabels = {} }) {
  const payload = event.payload ?? {};
  const line = {
    label: null,
    detail: null,
    comment: event.comment ?? null,
    strokes: null,
    alarm: false
  };

  switch (event.type) {
    case 'manoeuvre':
      line.label = manoeuvreName(event.subtype, t, manoeuvreLabels);
      if (payload.sail) {
        line.detail = `(${t('event.sail', { sail: sailName(payload.sail, t) })})`;
      }
      return line;
    case 'text_annotation':
      return { ...line, detail: event.comment, comment: null };
    case 'handwritten_annotation':
      return { ...line, strokes: payload.strokes ?? [] };
    case 'sk_alarm': {
      const message = payload.message ?? event.subtype;
      // The plugin copies the alarm message into the comment, for the CSV; a
      // comment the crew changed is still shown.
      if (line.comment === payload.message) {
        line.comment = null;
      }
      if (payload.state === 'normal') {
        return { ...line, detail: t('event.alarmCleared', { message }) };
      }
      return { ...line, label: t('event.alarm', { message }), alarm: true };
    }
    case 'autopilot': {
      if (event.subtype === 'disengaged') {
        return { ...line, detail: t('event.autopilotDisengaged') };
      }
      const mode = payload.mode ?? payload.state ?? '';
      const target = autopilotTarget(payload.target, format);
      const detail = [mode, target].filter(Boolean).join(' ');
      return {
        ...line,
        detail:
          event.subtype === 'mode_changed'
            ? t('event.autopilotMode', { mode: detail })
            : `${t('event.autopilotEngaged')}${detail ? ` (${detail})` : ''}`
      };
    }
    case 'weather_threshold':
      if (event.subtype === 'pressure_drop') {
        return {
          ...line,
          detail: t('event.pressureDrop', { drop: format.pressure(payload.drop) })
        };
      }
      return {
        ...line,
        detail:
          event.subtype === 'wind_above'
            ? t('event.windAbove', {
                threshold: format.speed(payload.threshold),
                speed: format.speed(payload.windSpeed)
              })
            : t('event.windBelow', { threshold: format.speed(payload.threshold) })
      };
    case 'heading_change':
      return {
        ...line,
        detail: t('event.headingChange', { heading: format.bearing(payload.heading) })
      };
    case 'manual_correction':
      return {
        ...line,
        detail: t('event.correction', {
          before: t(`type.${payload.before?.type}`),
          after: t(`type.${payload.after?.type}`)
        })
      };
    case 'propulsion_change':
      return {
        ...line,
        detail: t(
          payload.after?.type === 'engine' ? 'status.underwayEngine' : 'status.underwaySail'
        )
      };
    case 'stopover': {
      // The plugin copies the place name into the comment, for the CSV; a
      // comment the crew changed is still shown.
      if (line.comment === payload.placeName) {
        line.comment = null;
      }
      return { ...line, detail: t('event.stopover', { place: payload.placeName }) };
    }
    default:
      return { ...line, detail: event.comment ?? event.type, comment: null };
  }
}

// Events and instrument snapshots in time order. A snapshot taken for an event
// is shown on the event's own line rather than on a line of its own.
export function buildRows(events, observations) {
  const eventSnapshots = new Map(
    observations
      .filter((observation) => observation.reason === 'event')
      .map((observation) => [observation.time, observation])
  );
  const shown = new Set();
  const rows = events.map((event) => {
    const readings = eventSnapshots.get(event.time) ?? null;
    if (readings) {
      shown.add(readings.id);
    }
    return { key: `event-${event.id}`, time: event.time, event, readings };
  });
  for (const observation of observations) {
    if (!shown.has(observation.id)) {
      rows.push({
        key: `reading-${observation.id}`,
        time: observation.time,
        readings: observation
      });
    }
  }
  return rows.sort(
    (a, b) => a.time.localeCompare(b.time) || Number(Boolean(a.event)) - Number(Boolean(b.event))
  );
}

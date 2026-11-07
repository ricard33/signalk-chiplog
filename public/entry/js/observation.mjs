// A weather observation taken by hand, as a paper log notes it: wind force and direction, sea
// state, visibility, pressure and cloud cover. Logged as a `companion.observation`, with every
// value in Chiplog's units (radians, pascals) and any of them left out. Pure, so tests run it
// under Node.

export const VISIBILITIES = ['good', 'moderate', 'poor', 'fog'];
export const SUBTYPE = 'companion.observation';

const MIN_HECTOPASCALS = 850;
const MAX_HECTOPASCALS = 1100;

// The pressure typed, in hectopascals, when it is one a barometer reads.
export function parsePressure(text) {
  const hectopascals = Number(
    String(text ?? '')
      .trim()
      .replace(',', '.')
  );
  return Number.isFinite(hectopascals) &&
    hectopascals >= MIN_HECTOPASCALS &&
    hectopascals <= MAX_HECTOPASCALS
    ? hectopascals
    : null;
}

// `values`: { force, from (0 north .. 7 north-west), sea, visibility (an index), pressure (the
// text typed), cloud }, each null when left out.
export function observationPayload(values) {
  const hectopascals = parsePressure(values.pressure);
  const payload = {};
  if (values.force !== null) {
    payload.windForce = values.force;
  }
  if (values.from !== null) {
    payload.windDirection = (values.from * 2 * Math.PI) / 8;
  }
  if (values.sea !== null) {
    payload.seaState = values.sea;
  }
  if (values.visibility !== null) {
    payload.visibility = VISIBILITIES[values.visibility];
  }
  if (hectopascals !== null) {
    payload.pressure = hectopascals * 100;
  }
  if (values.cloud !== null) {
    payload.cloudCover = values.cloud;
  }
  return payload;
}

export const isEmptyObservation = (payload) => Object.keys(payload).length === 0;

// What the observation says, in one line, in the language of `t`.
export function observationText(payload, t) {
  const points = t('observation.compassPoints').split(',');
  const seas = t('observation.seaStates').split(',');
  const sights = t('observation.visibilities').split(',');
  const from =
    typeof payload.windDirection === 'number'
      ? points[Math.round((payload.windDirection * 8) / (2 * Math.PI)) % 8]
      : null;
  return [
    typeof payload.windForce === 'number'
      ? from
        ? t('observation.lineWind', { force: payload.windForce, from })
        : t('observation.lineWindForce', { force: payload.windForce })
      : null,
    typeof payload.seaState === 'number'
      ? t('observation.lineSea', { name: seas[payload.seaState] })
      : null,
    VISIBILITIES.includes(payload.visibility)
      ? t('observation.lineVisibility', { name: sights[VISIBILITIES.indexOf(payload.visibility)] })
      : null,
    typeof payload.pressure === 'number' ? `${Math.round(payload.pressure / 100)} hPa` : null,
    typeof payload.cloudCover === 'number'
      ? t('observation.lineCloud', { oktas: payload.cloudCover })
      : null
  ]
    .filter(Boolean)
    .join(', ');
}

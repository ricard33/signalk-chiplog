// Display formatting. The API speaks Signal K SI units; conversion to what a
// sailor reads happens here, and only here, on the webapp side.

const KNOTS_PER_MPS = 3600 / 1852;
const METRES_PER_NM = 1852;

function wrap360(degrees) {
  return ((degrees % 360) + 360) % 360;
}

function toDegrees(radians) {
  return (radians * 180) / Math.PI;
}

// `Date.parse` falls back to guessing at anything it is handed, so a
// `datetime-local` value is matched before being read. Seconds are optional:
// a field stepped finer than a minute supplies them.
const DATE_TIME_INPUT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;

// `timeZone` is an IANA zone for dates and times; without it, the device's own.
export function createFormatter({ locale, units, timeZone }) {
  const number = (digits) =>
    new Intl.NumberFormat(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits });
  const oneDecimal = number(1);
  const noDecimal = number(0);
  const percentFormat = new Intl.NumberFormat(locale, { style: 'percent' });
  const missing = (value) => value === null || value === undefined || Number.isNaN(value);

  const dayFormat = new Intl.DateTimeFormat(locale, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone
  });
  const shortDateFormat = new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    timeZone
  });
  const dateFormat = new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone
  });
  // Logbooks keep time on the 24-hour clock, whatever the language.
  const timeFormat = new Intl.DateTimeFormat(locale, {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone
  });
  // en-CA writes dates as YYYY-MM-DD, which sorts.
  const dayKeyFormat = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone
  });
  // What `<input type="datetime-local">` reads and writes: `YYYY-MM-DDTHH:mm`.
  const inputFormat = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone
  });
  const offsetFormat = new Intl.DateTimeFormat('en-US', {
    timeZone,
    timeZoneName: 'longOffset'
  });

  const localParts = (instant) => inputFormat.format(new Date(instant)).replace(', ', 'T');
  // How far the formatter's zone runs ahead of UTC around `instant`.
  const zoneOffsetMs = (instant) => Date.parse(`${localParts(instant)}:00Z`) - instant;

  function sexagesimal(value, positive, negative, width) {
    const absolute = Math.abs(value);
    let degrees = Math.floor(absolute);
    let minutes = Number(((absolute - degrees) * 60).toFixed(2));
    if (minutes >= 60) {
      degrees += 1;
      minutes = 0;
    }
    const hemisphere = value >= 0 ? positive : negative;
    return `${String(degrees).padStart(width, '0')}°${minutes.toFixed(2).padStart(5, '0')}′${hemisphere}`;
  }

  return {
    speed: (mps) =>
      missing(mps) ? '' : `${oneDecimal.format(mps * KNOTS_PER_MPS)} ${units.knots}`,
    distance: (metres) =>
      missing(metres) ? '' : `${oneDecimal.format(metres / METRES_PER_NM)} ${units.nauticalMiles}`,
    // A short range, as a sailor gives one: metres close in -- "0.1 nm" says
    // nothing about a landmark 60 m off the quay -- miles beyond a cable.
    shortDistance: (metres) => {
      if (missing(metres)) {
        return '';
      }
      if (metres < 0.2 * METRES_PER_NM) {
        return `${noDecimal.format(Math.round(metres / 10) * 10)} m`;
      }
      return `${oneDecimal.format(metres / METRES_PER_NM)} ${units.nauticalMiles}`;
    },
    bearing: (radians) => {
      if (missing(radians)) {
        return '';
      }
      const degrees = Math.round(wrap360(toDegrees(radians))) % 360;
      return `${String(degrees).padStart(3, '0')}°`;
    },
    // Apparent wind angle: negative to port, positive to starboard.
    angle: (radians) => {
      if (missing(radians)) {
        return '';
      }
      const degrees = Math.round(wrap360(toDegrees(radians) + 180) - 180);
      return `${degrees > 0 ? '+' : ''}${degrees}°`;
    },
    // An engine hour counter: hours with one decimal, as the gauge shows them.
    hours: (seconds) => (missing(seconds) ? '' : `${oneDecimal.format(seconds / 3600)} h`),
    // Signal K ratios (0–1): tank levels, state of charge.
    percent: (ratio) => (missing(ratio) ? '' : percentFormat.format(ratio)),
    // Cubic metres, read in litres aboard.
    volume: (cubicMetres) =>
      missing(cubicMetres) ? '' : `${noDecimal.format(cubicMetres * 1000)} L`,
    voltage: (volts) => (missing(volts) ? '' : `${oneDecimal.format(volts)} V`),
    current: (amperes) => (missing(amperes) ? '' : `${oneDecimal.format(amperes)} A`),
    count: (value) => (missing(value) ? '' : noDecimal.format(value)),
    depth: (metres) => (missing(metres) ? '' : `${oneDecimal.format(metres)} m`),
    pressure: (pascals) => (missing(pascals) ? '' : `${noDecimal.format(pascals / 100)} hPa`),
    // Rain is metres (kg/m² of water) in SI, read in millimetres.
    precipitation: (metres) => (missing(metres) ? '' : `${oneDecimal.format(metres * 1000)} mm`),
    // A wave or swell period.
    period: (seconds) => (missing(seconds) ? '' : `${noDecimal.format(seconds)} s`),
    temperature: (kelvin) => (missing(kelvin) ? '' : `${oneDecimal.format(kelvin - 273.15)} °C`),
    duration: (seconds) => {
      if (missing(seconds)) {
        return '';
      }
      const minutes = Math.round(seconds / 60);
      if (minutes < 60) {
        return `${minutes} min`;
      }
      return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')}`;
    },
    position: (position) =>
      position
        ? `${sexagesimal(position.lat, 'N', 'S', 2)} ${sexagesimal(position.lon, 'E', 'W', 3)}`
        : '',
    day: (date) => dayFormat.format(date),
    shortDate: (value) => shortDateFormat.format(new Date(value)),
    // With the year, for figures that span seasons.
    date: (value) => dateFormat.format(new Date(value)),
    time: (value) => timeFormat.format(new Date(value)),
    // The calendar day of an instant in the formatter's time zone.
    dayKey: (value) => dayKeyFormat.format(new Date(value)),
    // An instant as a `datetime-local` field reads it, in the formatter's zone.
    dateTimeInput: (value) => localParts(Date.parse(new Date(value).toISOString())),
    // And back: the instant that wall-clock reading stands for, or null when the
    // field holds nothing usable. Two passes, so a reading on the far side of a
    // daylight-saving change settles on its own offset rather than the one in
    // force at the first guess; the hour a zone repeats when it falls back is
    // genuinely ambiguous in such a field, and reads as the later of the two.
    fromDateTimeInput: (local) => {
      if (!DATE_TIME_INPUT.test(local ?? '')) {
        return null;
      }
      const asUtc = Date.parse(`${local.slice(0, 16)}:00Z`);
      const guess = asUtc - zoneOffsetMs(asUtc);
      return new Date(asUtc - zoneOffsetMs(guess)).toISOString();
    },
    // "UTC+02:00" at that instant; daylight saving time changes it.
    utcOffset: (value) => {
      const zone = offsetFormat
        .formatToParts(new Date(value))
        .find((part) => part.type === 'timeZoneName').value;
      return /^GMT(\+00:00)?$/.test(zone) ? 'UTC' : zone.replace('GMT', 'UTC');
    }
  };
}

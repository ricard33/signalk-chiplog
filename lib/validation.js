const { badRequest } = require('./errors');

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireBody(body, allowedFields) {
  if (!isPlainObject(body)) {
    throw badRequest('Request body must be a JSON object');
  }
  const unknown = Object.keys(body).filter((field) => !allowedFields.includes(field));
  if (unknown.length > 0) {
    throw badRequest(`Unknown field(s): ${unknown.join(', ')}`);
  }
  return body;
}

function parseId(value, name = 'id') {
  if (!/^[1-9]\d*$/.test(String(value))) {
    throw badRequest(`${name} must be a positive integer`);
  }
  return Number(value);
}

function parseTimestamp(value, name) {
  const date = typeof value === 'string' ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) {
    throw badRequest(`${name} must be an ISO 8601 timestamp`);
  }
  return date.toISOString();
}

function parseOptionalTimestamp(value, name) {
  return value === undefined ? undefined : parseTimestamp(value, name);
}

function parseNonNegativeNumber(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw badRequest(`${name} must be a non-negative number`);
  }
  return value;
}

function parseNumber(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw badRequest(`${name} must be a number`);
  }
  return value;
}

function parsePosition(value, name) {
  if (value === null) {
    return null;
  }
  const valid =
    isPlainObject(value) &&
    typeof value.lat === 'number' &&
    typeof value.lon === 'number' &&
    value.lat >= -90 &&
    value.lat <= 90 &&
    value.lon >= -180 &&
    value.lon <= 180;
  if (!valid) {
    throw badRequest(`${name} must be { lat, lon } in decimal degrees, or null`);
  }
  return { lat: value.lat, lon: value.lon };
}

function parseString(value, name, { maxLength = 1000, allowNull = false } = {}) {
  if (value === null && allowNull) {
    return null;
  }
  if (typeof value !== 'string' || value.trim() === '' || value.length > maxLength) {
    throw badRequest(`${name} must be a non-empty string of at most ${maxLength} characters`);
  }
  return value.trim();
}

function parsePagination(query) {
  const limit = query.limit === undefined ? DEFAULT_LIMIT : Number(query.limit);
  const offset = query.offset === undefined ? 0 : Number(query.offset);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw badRequest(`limit must be an integer between 1 and ${MAX_LIMIT}`);
  }
  if (!Number.isInteger(offset) || offset < 0) {
    throw badRequest('offset must be a non-negative integer');
  }
  return { limit, offset };
}

// Which engine runs, by name: `{ "Port": true, "Starboard": false }`; absent when not said.
function parseEngines(value) {
  if (value === undefined || value === null) {
    return null;
  }
  if (!isPlainObject(value) || Object.keys(value).length === 0 || Object.keys(value).length > 20) {
    throw badRequest('engines must be an object of one to 20 engine names');
  }
  for (const [name, running] of Object.entries(value)) {
    if (name.trim() === '' || name.length > 60 || typeof running !== 'boolean') {
      throw badRequest('engines maps a name of at most 60 characters to true or false');
    }
  }
  return value;
}

function parseEnum(value, name, allowed) {
  if (!allowed.includes(value)) {
    throw badRequest(`${name} must be one of: ${allowed.join(', ')}`);
  }
  return value;
}

module.exports = {
  isPlainObject,
  requireBody,
  parseId,
  parseTimestamp,
  parseOptionalTimestamp,
  parseNonNegativeNumber,
  parseNumber,
  parsePosition,
  parseString,
  parsePagination,
  parseEnum,
  parseEngines
};

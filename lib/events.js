const { withTransaction } = require('./database');
const { ApiError, badRequest, conflict, notFound } = require('./errors');
const {
  DEPARTURE_MANOEUVRES,
  activeEntryId,
  entryNearArrival,
  openEntryByHand,
  reopenableEntry,
  requireEntryRow
} = require('./entries');
const { toPosition, paginate } = require('./rows');
const { isPlainObject } = require('./validation');

const EVENT_TYPES = [
  'manoeuvre',
  'text_annotation',
  'handwritten_annotation',
  'sk_alarm',
  'autopilot',
  'weather_threshold',
  'manual_correction',
  'propulsion_change',
  'stopover',
  'heading_change'
];

// The other event types are produced by the plugin itself from Signal K data
// or from corrections, never posted by a client.
const CLIENT_EVENT_TYPES = ['manoeuvre', 'text_annotation', 'handwritten_annotation'];

// A `sk_alarm` event reaching one of these states is the alarm itself; any
// other state (usually `normal`) is what cleared it. Shared with
// event-watcher.js, which decides what is worth logging in the first place.
const CRITICAL_STATES = new Set(['alarm', 'emergency']);

// An entry logged after the fact — typically replayed from the tablet's offline
// queue — takes the position the track recorded at its time.
const TRACK_POSITION_WINDOW_MS = 2 * 60 * 1000;
const CURRENT_POSITION_WINDOW_MS = 5 * 60 * 1000;

function toEvent(row) {
  return {
    id: row.id,
    entryId: row.entry_id,
    time: row.time,
    type: row.type,
    subtype: row.subtype,
    position: toPosition(row.lat, row.lon),
    comment: row.comment,
    payload: row.payload === null ? null : JSON.parse(row.payload),
    source: row.source,
    clientRef: row.client_ref,
    createdAt: row.created_at
  };
}

function requireEventRow(db, id) {
  const row = db.prepare('SELECT * FROM events WHERE id = ?').get(id);
  if (!row) {
    throw notFound('event', id);
  }
  return row;
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const STROKE_TOOLS = ['pen', 'highlighter'];

function isValidStrokes(payload) {
  const strokes = isPlainObject(payload) ? payload.strokes : undefined;
  return (
    Array.isArray(strokes) &&
    strokes.length > 0 &&
    strokes.every(
      (stroke) =>
        isPlainObject(stroke) &&
        Array.isArray(stroke.points) &&
        stroke.points.length > 0 &&
        stroke.points.every(
          (point) =>
            isPlainObject(point) &&
            isFiniteNumber(point.x) &&
            isFiniteNumber(point.y) &&
            isFiniteNumber(point.t) &&
            (point.pressure === undefined || isFiniteNumber(point.pressure))
        ) &&
        (stroke.color === undefined || HEX_COLOR.test(stroke.color)) &&
        (stroke.tool === undefined || STROKE_TOOLS.includes(stroke.tool)) &&
        (stroke.width === undefined || (isFiniteNumber(stroke.width) && stroke.width > 0))
    )
  );
}

function validateContent(db, { type, subtype, comment, payload }) {
  if (type === 'manoeuvre') {
    if (!subtype) {
      throw badRequest('A manoeuvre event requires subtype, the manoeuvre key');
    }
    if (!db.prepare('SELECT 1 FROM manoeuvre_types WHERE key = ?').get(subtype)) {
      throw new ApiError(400, 'unknown_manoeuvre_type', `Unknown manoeuvre type: ${subtype}`);
    }
  }
  if (type === 'text_annotation' && !comment) {
    throw badRequest('A text annotation requires a comment');
  }
  if (type === 'handwritten_annotation' && !isValidStrokes(payload)) {
    throw badRequest(
      'A handwritten annotation requires payload.strokes: ' +
        '[{ points: [{ x, y, t, pressure? }], color?, tool?: "pen"|"highlighter", width? }]'
    );
  }
}

function serializePayload(payload) {
  return payload === undefined || payload === null ? null : JSON.stringify(payload);
}

function listEvents(db, entryId, { type, limit, offset }) {
  requireEntryRow(db, entryId);
  return paginate(db, {
    table: 'events',
    where: type === undefined ? 'WHERE entry_id = ?' : 'WHERE entry_id = ? AND type = ?',
    params: type === undefined ? [entryId] : [entryId, type],
    orderBy: 'time, id',
    limit,
    offset,
    map: toEvent
  });
}

function allEvents(db, entryId) {
  return db
    .prepare('SELECT * FROM events WHERE entry_id = ? ORDER BY time, id')
    .all(entryId)
    .map(toEvent);
}

// Where the track says the vessel was at `time`, or null when it recorded
// nothing close enough. `entryId` narrows the search to one passage, which only
// an edit can do: a new entry does not know its passage yet.
function trackPositionAt(db, time, entryId = null) {
  const target = Date.parse(time);
  const scope = entryId === null ? '' : ' AND entry_id = ?';
  const bounds = entryId === null ? [time] : [time, entryId];
  const nearest = [
    db.prepare(
      `SELECT time, lat, lon FROM track_points WHERE time <= ?${scope} ORDER BY time DESC LIMIT 1`
    ),
    db.prepare(
      `SELECT time, lat, lon FROM track_points WHERE time >= ?${scope} ORDER BY time LIMIT 1`
    )
  ]
    .map((statement) => statement.get(...bounds))
    .filter(
      (point) => point && Math.abs(Date.parse(point.time) - target) <= TRACK_POSITION_WINDOW_MS
    )
    .sort(
      (a, b) => Math.abs(Date.parse(a.time) - target) - Math.abs(Date.parse(b.time) - target)
    )[0];
  return nearest ? { lat: nearest.lat, lon: nearest.lon } : null;
}

function positionAt(db, time, { now, vesselPosition }) {
  if (time === undefined) {
    return vesselPosition;
  }
  const recorded = trackPositionAt(db, time);
  if (recorded) {
    return recorded;
  }
  // Still the vessel's own position when the entry was made moments ago — a
  // replay from the tablet's queue, where the track may hold nothing yet.
  return Math.abs(Date.parse(now) - Date.parse(time)) <= CURRENT_POSITION_WINDOW_MS
    ? vesselPosition
    : null;
}

function findByClientRef(db, clientRef) {
  if (clientRef === undefined) {
    return null;
  }
  const row = db.prepare('SELECT * FROM events WHERE client_ref = ?').get(clientRef);
  return row ? toEvent(row) : null;
}

function insertEvent(db, entryId, input, position, now) {
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO events (
         entry_id, time, type, subtype, lat, lon, comment, payload, source, client_ref, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?)`
    )
    .run(
      entryId,
      input.time ?? now,
      input.type,
      input.subtype ?? null,
      position ? position.lat : null,
      position ? position.lon : null,
      input.comment ?? null,
      serializePayload(input.payload),
      input.clientRef ?? null,
      now
    );
  return toEvent(requireEventRow(db, Number(lastInsertRowid)));
}

// Returns { event, created }: a clientRef already logged answers with that
// event instead of a duplicate.
function createEvent(db, entryId, input, context) {
  requireEntryRow(db, entryId);
  validateContent(db, input);
  const existing = findByClientRef(db, input.clientRef);
  if (existing) {
    return { event: existing, created: false };
  }
  const position =
    input.position === undefined ? positionAt(db, input.time, context) : input.position;
  return { event: insertEvent(db, entryId, input, position, context.now), created: true };
}

// An entry from the crew, attached to the passage it belongs to: the open one;
// failing that, a departure manoeuvre goes to the passage that just ended if
// a departure now would carry it on, and opens one otherwise; failing that,
// the last passage while the vessel is still at its arrival.
function logCrewEvent(db, input, context) {
  validateContent(db, input);
  return withTransaction(db, () => {
    const existing = findByClientRef(db, input.clientRef);
    if (existing) {
      return { event: existing, created: false, openedEntry: false };
    }
    const position =
      input.position === undefined ? positionAt(db, input.time, context) : input.position;
    const time = input.time ?? context.now;

    let entryId = activeEntryId(db);
    let openedEntry = false;
    if (
      entryId === null &&
      input.type === 'manoeuvre' &&
      DEPARTURE_MANOEUVRES.includes(input.subtype)
    ) {
      // Detection reopens that passage once the vessel moves.
      entryId = reopenableEntry(db, time, context.stopClosureMinutes * 60 * 1000)?.id ?? null;
      if (entryId === null) {
        entryId = openEntryByHand(db, {
          time,
          position,
          placeMatchRadius: context.placeMatchRadius,
          now: context.now
        });
        openedEntry = true;
      }
    }
    entryId ??= entryNearArrival(db, position);
    if (entryId === null) {
      throw conflict(
        'no_passage',
        'No passage is open and the vessel is not at the last arrival; cast off or weigh anchor first'
      );
    }

    const event = insertEvent(db, entryId, input, position, context.now);
    if (openedEntry) {
      db.prepare('UPDATE log_entries SET opened_by_event_id = ? WHERE id = ?').run(
        event.id,
        entryId
      );
    }
    return { event, created: true, openedEntry };
  });
}

// A hand-written time has to stay a time the passage could have been logged at,
// and must not contradict the departure it opened.
function checkRetiming(db, event, time, now) {
  if (Date.parse(time) > Date.parse(now)) {
    throw badRequest('time cannot be in the future');
  }
  const entry = requireEntryRow(db, event.entryId);
  const until = entry.end_time ?? now;
  if (Date.parse(time) < Date.parse(entry.start_time) || Date.parse(time) > Date.parse(until)) {
    throw badRequest('time must fall within the passage');
  }
  const opens = db.prepare('SELECT 1 FROM log_entries WHERE opened_by_event_id = ?').get(event.id);
  if (opens) {
    throw badRequest('This event opened the passage; change the passage departure time instead');
  }
}

// The instrument snapshot taken when the event was logged (SPEC §4.1) belongs to
// the moment the button was pressed, not to the moment the event is redated to:
// it goes, unless another event of the passage still stands at that time.
function dropEventSnapshot(db, event) {
  const others = db
    .prepare('SELECT 1 FROM events WHERE entry_id = ? AND time = ? AND id <> ?')
    .get(event.entryId, event.time, event.id);
  if (!others) {
    db.prepare("DELETE FROM observations WHERE entry_id = ? AND time = ? AND reason = 'event'").run(
      event.entryId,
      event.time
    );
  }
}

function updateEvent(db, id, patch, context = {}) {
  const current = toEvent(requireEventRow(db, id));

  if (!CLIENT_EVENT_TYPES.includes(current.type)) {
    const disallowed = Object.keys(patch).filter((field) => field !== 'comment');
    if (disallowed.length > 0) {
      throw badRequest(`Only comment can be edited on a ${current.type} event`);
    }
  }

  const next = { ...current, ...patch };
  validateContent(db, next);
  const retimed = next.time !== current.time;
  if (retimed) {
    checkRetiming(db, current, next.time, context.now);
  }

  return withTransaction(db, () => {
    // Redating an event unmoors it from where the crew was when they logged it:
    // its position is the track's at the new time, or none at all.
    const position = retimed ? trackPositionAt(db, next.time, current.entryId) : current.position;
    db.prepare(
      `UPDATE events SET time = ?, subtype = ?, comment = ?, payload = ?, lat = ?, lon = ?
       WHERE id = ?`
    ).run(
      next.time,
      next.subtype,
      next.comment,
      serializePayload(next.payload),
      position ? position.lat : null,
      position ? position.lon : null,
      id
    );
    if (retimed) {
      dropEventSnapshot(db, current);
    }
    return toEvent(requireEventRow(db, id));
  });
}

// An alarm is logged as two lines — the notification reaching `alarm` or
// `emergency`, and the one that later cleared it (SPEC §4.6) — so deleting
// either alone would leave the other referring to nothing. Its pair is the
// adjacent `sk_alarm` line for the same notification whose criticality
// differs: an escalation (`alarm` to `emergency`) is not a pair, both being
// critical, and is left alone.
function pairedAlarmEvent(db, row) {
  if (row.type !== 'sk_alarm') {
    return null;
  }
  const siblings = db
    .prepare(
      `SELECT * FROM events WHERE entry_id = ? AND type = 'sk_alarm' AND subtype = ?
       ORDER BY time, id`
    )
    .all(row.entry_id, row.subtype);
  const index = siblings.findIndex((sibling) => sibling.id === row.id);
  const critical = CRITICAL_STATES.has(JSON.parse(row.payload).state);
  const neighbour = critical ? siblings[index + 1] : siblings[index - 1];
  if (!neighbour || CRITICAL_STATES.has(JSON.parse(neighbour.payload).state) === critical) {
    return null;
  }
  return neighbour;
}

// Undoing the departure that opened a passage, before the vessel moved and
// before anything else was logged in it, takes the passage away too.
function deleteEvent(db, id) {
  const row = requireEventRow(db, id);
  withTransaction(db, () => {
    const opened = db
      .prepare(
        `SELECT id FROM log_entries
         WHERE opened_by_event_id = ? AND state = 'active' AND last_moving_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM events WHERE entry_id = log_entries.id AND id <> ?)`
      )
      .get(id, id);
    if (opened) {
      db.prepare('DELETE FROM log_entries WHERE id = ?').run(opened.id);
      return;
    }
    const paired = pairedAlarmEvent(db, row);
    if (paired) {
      db.prepare('DELETE FROM events WHERE id = ?').run(paired.id);
    }
    db.prepare('DELETE FROM events WHERE id = ?').run(id);
  });
}

module.exports = {
  EVENT_TYPES,
  CLIENT_EVENT_TYPES,
  CRITICAL_STATES,
  listEvents,
  allEvents,
  createEvent,
  logCrewEvent,
  updateEvent,
  deleteEvent
};

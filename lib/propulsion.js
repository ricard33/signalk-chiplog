const { withTransaction } = require('./database');
const { notFound, conflict } = require('./errors');
const { requireEntryRow, recomputeDurations } = require('./entries');
const { paginate } = require('./rows');

function toSegment(row) {
  return {
    id: row.id,
    entryId: row.entry_id,
    type: row.type,
    startTime: row.start_time,
    endTime: row.end_time,
    source: row.source,
    averageRpm: row.average_rpm
  };
}

function requireSegmentRow(db, id) {
  const row = db.prepare('SELECT * FROM propulsion_segments WHERE id = ?').get(id);
  if (!row) {
    throw notFound('propulsion_segment', id);
  }
  return row;
}

function listSegments(db, entryId, { limit, offset }) {
  requireEntryRow(db, entryId);
  return paginate(db, {
    table: 'propulsion_segments',
    where: 'WHERE entry_id = ?',
    params: [entryId],
    orderBy: 'start_time, id',
    limit,
    offset,
    map: toSegment
  });
}

function allSegments(db, entryId) {
  return db
    .prepare('SELECT * FROM propulsion_segments WHERE entry_id = ? ORDER BY start_time, id')
    .all(entryId)
    .map(toSegment);
}

function correctSegment(db, id, { type }, { now }) {
  return withTransaction(db, () => {
    const row = requireSegmentRow(db, id);
    if (row.type === type) {
      return toSegment(row);
    }

    db.prepare("UPDATE propulsion_segments SET type = ?, source = 'manual' WHERE id = ?").run(
      type,
      id
    );
    recomputeDurations(db, row.entry_id, now);

    // Placed at the segment's start so the timeline shows the correction where
    // it applies; created_at still records when it was made.
    db.prepare(
      `INSERT INTO events (entry_id, time, type, subtype, payload, source, created_at)
       VALUES (?, ?, 'manual_correction', 'propulsion', ?, 'auto', ?)`
    ).run(
      row.entry_id,
      row.start_time,
      JSON.stringify({ segmentId: id, before: { type: row.type }, after: { type } }),
      now
    );

    return toSegment(requireSegmentRow(db, id));
  });
}

// The crew says the boat is under `type` from now on (an engine started or stopped by hand):
// the segment under way ends now and one of that type starts, held as a manual one until the
// engine data itself changes. `engines`, when sent, says which engine runs (name -> boolean)
// and is kept on the logged change. Returns the segment under way afterwards.
function switchNow(db, entryId, { type, engines, clientRef }, { now }) {
  return withTransaction(db, () => {
    const entry = requireEntryRow(db, entryId);
    // A client's retry of what was done already answers the segment under way.
    if (clientRef !== undefined && clientRef !== null) {
      const done = db.prepare('SELECT 1 FROM events WHERE client_ref = ?').get(clientRef);
      if (done) {
        const open = db
          .prepare(
            'SELECT * FROM propulsion_segments WHERE entry_id = ? ORDER BY start_time DESC, id DESC'
          )
          .get(entryId);
        if (open) {
          return toSegment(open);
        }
      }
    }
    if (entry.state !== 'active') {
      throw conflict('entry_not_active', 'Only the passage in progress can change propulsion');
    }
    if (entry.stopped_since !== null) {
      throw conflict('entry_stopped', 'The passage is stopped: there is no propulsion to change');
    }
    const current = db
      .prepare(
        'SELECT * FROM propulsion_segments WHERE entry_id = ? AND end_time IS NULL ORDER BY start_time DESC, id DESC'
      )
      .get(entryId);
    let segment = current;
    let before = current?.type ?? null;
    if (!current || current.type !== type) {
      if (current) {
        // A segment that began in the same instant is turned over rather than split.
        if (current.start_time >= now) {
          db.prepare("UPDATE propulsion_segments SET type = ?, source = 'manual' WHERE id = ?").run(
            type,
            current.id
          );
          segment = { ...current, type };
        } else {
          db.prepare('UPDATE propulsion_segments SET end_time = ? WHERE id = ?').run(
            now,
            current.id
          );
        }
      }
      if (!current || current.start_time < now) {
        const { lastInsertRowid } = db
          .prepare(
            "INSERT INTO propulsion_segments (entry_id, type, start_time, source) VALUES (?, ?, ?, 'manual')"
          )
          .run(entryId, type, now);
        segment = { id: Number(lastInsertRowid) };
      }
      recomputeDurations(db, entryId, now);
    }
    if (before !== type || engines) {
      db.prepare(
        `INSERT INTO events (entry_id, time, type, payload, source, client_ref, created_at)
         VALUES (?, ?, 'propulsion_change', ?, 'manual', ?, ?)`
      ).run(
        entryId,
        now,
        JSON.stringify({
          segmentId: segment.id,
          before: { type: before ?? type },
          after: { type },
          ...(engines ? { engines } : {})
        }),
        clientRef ?? null,
        now
      );
    }
    return toSegment(requireSegmentRow(db, segment.id));
  });
}

module.exports = { listSegments, allSegments, correctSegment, switchNow };

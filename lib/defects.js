const { withTransaction } = require('./database');
const { badRequest, notFound } = require('./errors');
const { requireEntryRow } = require('./entries');
const { requirePlanRow } = require('./plans');
const { paginate } = require('./rows');

const DEFECT_SEVERITIES = ['minor', 'major', 'critical'];
const DEFECT_STATUSES = ['open', 'fixed'];

function toDefect(row) {
  return {
    id: row.id,
    clientRef: row.client_ref,
    title: row.title,
    description: row.description,
    severity: row.severity,
    status: row.status,
    time: row.time,
    fixedAt: row.fixed_at,
    entryId: row.entry_id,
    planId: row.plan_id,
    eventId: row.event_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function requireDefectRow(db, id) {
  const row = db.prepare('SELECT * FROM defects WHERE id = ?').get(id);
  if (!row) {
    throw notFound('defect', id);
  }
  return row;
}

function findDefectRow(db, id) {
  return db.prepare('SELECT * FROM defects WHERE id = ?').get(id) ?? null;
}

function getDefect(db, id) {
  return toDefect(requireDefectRow(db, id));
}

// Newest first.
function listDefects(db, { status, entryId, planId, limit, offset }) {
  const conditions = [];
  const params = [];
  for (const [column, value] of [
    ['status', status],
    ['entry_id', entryId],
    ['plan_id', planId]
  ]) {
    if (value !== undefined) {
      conditions.push(`${column} = ?`);
      params.push(value);
    }
  }
  return paginate(db, {
    table: 'defects',
    where: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '',
    params,
    orderBy: 'time DESC, id DESC',
    limit,
    offset,
    map: toDefect
  });
}

function allDefects(db) {
  return db.prepare('SELECT * FROM defects ORDER BY id').all().map(toDefect);
}

// The links name rows that exist. A defect reported from a journal line belongs to that line's
// passage, unless it says which one.
function resolveLinks(db, next) {
  if (next.entry_id !== null) {
    requireEntryRow(db, next.entry_id);
  }
  if (next.plan_id !== null) {
    requirePlanRow(db, next.plan_id);
  }
  if (next.event_id !== null) {
    const event = db.prepare('SELECT entry_id FROM events WHERE id = ?').get(next.event_id);
    if (!event) {
      throw notFound('event', next.event_id);
    }
    if (next.entry_id === null) {
      next.entry_id = event.entry_id;
    } else if (next.entry_id !== event.entry_id) {
      throw badRequest(`Event ${next.event_id} belongs to entry ${event.entry_id}`);
    }
  }
}

// Fixing a defect dates the repair, now unless said otherwise; reopening it forgets it.
function resolveStatus(next, current, patch, now) {
  if (next.status === 'open') {
    if (patch.fixedAt != null) {
      throw badRequest('fixedAt can only be set on a fixed defect');
    }
    next.fixed_at = null;
  } else if (patch.fixedAt !== undefined) {
    next.fixed_at = patch.fixedAt ?? now;
  } else if (current?.status !== 'fixed') {
    next.fixed_at = now;
  }
}

const FIELDS = [
  ['title', 'title'],
  ['description', 'description'],
  ['severity', 'severity'],
  ['status', 'status'],
  ['time', 'time'],
  ['entryId', 'entry_id'],
  ['planId', 'plan_id'],
  ['eventId', 'event_id']
];

function apply(row, patch) {
  const next = { ...row };
  for (const [field, column] of FIELDS) {
    if (patch[field] !== undefined) {
      next[column] = patch[field];
    }
  }
  return next;
}

// Returns { defect, created }: a clientRef already used answers with that defect, unchanged.
function createDefect(db, input, now) {
  return withTransaction(db, () => {
    if (input.clientRef !== undefined) {
      const existing = db
        .prepare('SELECT * FROM defects WHERE client_ref = ?')
        .get(input.clientRef);
      if (existing) {
        return { defect: toDefect(existing), created: false };
      }
    }
    const next = apply(
      {
        client_ref: input.clientRef ?? null,
        title: null,
        description: null,
        severity: DEFECT_SEVERITIES[0],
        status: DEFECT_STATUSES[0],
        time: now,
        fixed_at: null,
        entry_id: null,
        plan_id: null,
        event_id: null,
        created_at: now,
        updated_at: now
      },
      input
    );
    resolveLinks(db, next);
    resolveStatus(next, null, input, now);
    const columns = Object.keys(next);
    const { lastInsertRowid } = db
      .prepare(
        `INSERT INTO defects (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`
      )
      .run(...columns.map((column) => next[column]));
    return { defect: getDefect(db, Number(lastInsertRowid)), created: true };
  });
}

function updateDefect(db, id, patch, now) {
  return withTransaction(db, () => {
    const current = requireDefectRow(db, id);
    const next = apply(current, patch);
    // A new journal line, with no passage said, takes its passage along.
    if (patch.eventId != null && patch.entryId === undefined) {
      next.entry_id = null;
    }
    resolveLinks(db, next);
    if (patch.status !== undefined || patch.fixedAt !== undefined) {
      resolveStatus(next, current, patch, now);
    }
    db.prepare(
      `UPDATE defects SET title = ?, description = ?, severity = ?, status = ?, time = ?,
         fixed_at = ?, entry_id = ?, plan_id = ?, event_id = ?, updated_at = ?
       WHERE id = ?`
    ).run(
      next.title,
      next.description,
      next.severity,
      next.status,
      next.time,
      next.fixed_at,
      next.entry_id,
      next.plan_id,
      next.event_id,
      now,
      id
    );
    return getDefect(db, id);
  });
}

module.exports = {
  DEFECT_SEVERITIES,
  DEFECT_STATUSES,
  toDefect,
  findDefectRow,
  getDefect,
  listDefects,
  allDefects,
  createDefect,
  updateDefect
};

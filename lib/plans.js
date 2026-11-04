const crew = require('./crew');
const { withTransaction } = require('./database');
const { badRequest, conflict, notFound } = require('./errors');
const { requireEntryRow } = require('./entries');
const { toPosition, paginate } = require('./rows');

const PLAN_STATUSES = ['draft', 'ready', 'active', 'done', 'cancelled'];

// Linking a plan to its passage means it is being sailed, unless it was already further on.
const NOT_STARTED = ['draft', 'ready'];

const parseJson = (text) => (text === null ? null : JSON.parse(text));

function toPlan(row) {
  return {
    id: row.id,
    clientRef: row.client_ref,
    title: row.title,
    status: row.status,
    departureTime: row.departure_time,
    departurePlaceName: row.departure_place_name,
    departurePosition: toPosition(row.departure_lat, row.departure_lon),
    arrivalTime: row.arrival_time,
    arrivalPlaceName: row.arrival_place_name,
    arrivalPosition: toPosition(row.arrival_lat, row.arrival_lon),
    routeRef: row.route_ref,
    fallbackRefs: JSON.parse(row.fallback_refs),
    criteria: parseJson(row.criteria),
    companion: parseJson(row.companion),
    crew: JSON.parse(row.crew),
    watches: JSON.parse(row.watches),
    entryId: row.entry_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function requirePlanRow(db, id) {
  const row = db.prepare('SELECT * FROM plans WHERE id = ?').get(id);
  if (!row) {
    throw notFound('plan', id);
  }
  return row;
}

function getPlan(db, id) {
  return toPlan(requirePlanRow(db, id));
}

function findPlanRow(db, id) {
  return db.prepare('SELECT * FROM plans WHERE id = ?').get(id) ?? null;
}

// Plans still to sail first, by planned departure; then the rest, newest first.
function listPlans(db, { status, entryId, limit, offset }) {
  const conditions = [];
  const params = [];
  if (status !== undefined) {
    conditions.push('status = ?');
    params.push(status);
  }
  if (entryId !== undefined) {
    conditions.push('entry_id = ?');
    params.push(entryId);
  }
  return paginate(db, {
    table: 'plans',
    where: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '',
    params,
    orderBy: 'COALESCE(departure_time, created_at) DESC, id DESC',
    limit,
    offset,
    map: toPlan
  });
}

function allPlans(db) {
  return db.prepare('SELECT * FROM plans ORDER BY id').all().map(toPlan);
}

// A planned crew member, or a watch's: either a roster member, whose name and role are copied
// in as they stand, or a name typed for this plan alone.
function resolveMember(db, member) {
  if (member.crewMemberId !== undefined) {
    const row = crew.requireCrewMemberRow(db, member.crewMemberId);
    return { crewMemberId: row.id, name: row.name, role: member.role ?? row.role };
  }
  return { crewMemberId: null, name: member.name, role: member.role ?? null };
}

const resolveWatch = (db, watch) => ({
  start: watch.start,
  end: watch.end,
  ...resolveMember(db, watch)
});

// The planned crew goes aboard the passage as it opens, in place of the crew carried over
// from the previous passage (SPEC §4.11). A roster member deleted since the plan was made is
// added again by name.
function boardPlannedCrew(db, entryId, plannedCrew, now) {
  if (plannedCrew.length === 0) {
    return;
  }
  const members = plannedCrew.map((member) =>
    member.crewMemberId !== null &&
    db.prepare('SELECT 1 FROM crew_members WHERE id = ?').get(member.crewMemberId)
      ? { crewMemberId: member.crewMemberId }
      : { name: member.name, role: member.role }
  );
  crew.setEntryCrew(db, entryId, members, now);
}

function checkEntryFree(db, entryId, planId) {
  requireEntryRow(db, entryId);
  const other = db
    .prepare('SELECT id FROM plans WHERE entry_id = ? AND id IS NOT ?')
    .get(entryId, planId);
  if (other) {
    throw conflict('entry_has_plan', `Entry ${entryId} is already linked to plan ${other.id}`);
  }
}

const COLUMNS = {
  title: (value) => [['title', value]],
  status: (value) => [['status', value]],
  departureTime: (value) => [['departure_time', value]],
  departurePlaceName: (value) => [['departure_place_name', value]],
  departurePosition: (value) => [
    ['departure_lat', value ? value.lat : null],
    ['departure_lon', value ? value.lon : null]
  ],
  arrivalTime: (value) => [['arrival_time', value]],
  arrivalPlaceName: (value) => [['arrival_place_name', value]],
  arrivalPosition: (value) => [
    ['arrival_lat', value ? value.lat : null],
    ['arrival_lon', value ? value.lon : null]
  ],
  routeRef: (value) => [['route_ref', value]],
  fallbackRefs: (value) => [['fallback_refs', JSON.stringify(value)]],
  criteria: (value) => [['criteria', value === null ? null : JSON.stringify(value)]],
  companion: (value) => [['companion', value === null ? null : JSON.stringify(value)]],
  crew: (value) => [['crew', JSON.stringify(value)]],
  watches: (value) => [['watches', JSON.stringify(value)]],
  entryId: (value) => [['entry_id', value]]
};

function columnsOf(db, input) {
  const resolved = { ...input };
  if (input.crew !== undefined) {
    resolved.crew = input.crew.map((member) => resolveMember(db, member));
  }
  if (input.watches !== undefined) {
    resolved.watches = input.watches.map((watch) => resolveWatch(db, watch));
  }
  return Object.entries(resolved)
    .filter(([field, value]) => field in COLUMNS && value !== undefined)
    .flatMap(([field, value]) => COLUMNS[field](value));
}

function arrivalNotBeforeDeparture(row) {
  if (row.departure_time && row.arrival_time && row.arrival_time < row.departure_time) {
    throw badRequest('arrivalTime must not be earlier than departureTime');
  }
}

// Returns { plan, created }: a clientRef already used answers with that plan, unchanged.
function createPlan(db, input, now) {
  return withTransaction(db, () => {
    if (input.clientRef !== undefined) {
      const existing = db.prepare('SELECT * FROM plans WHERE client_ref = ?').get(input.clientRef);
      if (existing) {
        return { plan: toPlan(existing), created: false };
      }
    }
    if (input.entryId != null) {
      checkEntryFree(db, input.entryId, null);
    }
    const status = input.status ?? (input.entryId != null ? 'active' : PLAN_STATUSES[0]);
    const columns = [
      ...columnsOf(db, { ...input, status }),
      ['client_ref', input.clientRef ?? null],
      ['created_at', now],
      ['updated_at', now]
    ];
    const { lastInsertRowid } = db
      .prepare(
        `INSERT INTO plans (${columns.map(([column]) => column).join(', ')})
         VALUES (${columns.map(() => '?').join(', ')})`
      )
      .run(...columns.map(([, value]) => value));
    const row = requirePlanRow(db, Number(lastInsertRowid));
    arrivalNotBeforeDeparture(row);
    if (row.entry_id !== null) {
      boardPlannedCrew(db, row.entry_id, JSON.parse(row.crew), now);
    }
    return { plan: toPlan(row), created: true };
  });
}

// Linking the plan to a passage (entryId) boards its crew there and, unless the patch says
// otherwise, marks a plan not yet started as active.
function updatePlan(db, id, patch, now) {
  return withTransaction(db, () => {
    const current = requirePlanRow(db, id);
    const linking = patch.entryId != null && patch.entryId !== current.entry_id;
    if (linking) {
      checkEntryFree(db, patch.entryId, id);
    }
    const next = { ...patch };
    if (linking && next.status === undefined && NOT_STARTED.includes(current.status)) {
      next.status = 'active';
    }
    const columns = [...columnsOf(db, next), ['updated_at', now]];
    db.prepare(
      `UPDATE plans SET ${columns.map(([column]) => `${column} = ?`).join(', ')} WHERE id = ?`
    ).run(...columns.map(([, value]) => value), id);
    const row = requirePlanRow(db, id);
    arrivalNotBeforeDeparture(row);
    if (linking) {
      boardPlannedCrew(db, row.entry_id, JSON.parse(row.crew), now);
    }
    return toPlan(row);
  });
}

function deletePlan(db, id) {
  requirePlanRow(db, id);
  db.prepare('DELETE FROM plans WHERE id = ?').run(id);
}

module.exports = {
  PLAN_STATUSES,
  toPlan,
  requirePlanRow,
  findPlanRow,
  getPlan,
  listPlans,
  allPlans,
  createPlan,
  updatePlan,
  deletePlan
};

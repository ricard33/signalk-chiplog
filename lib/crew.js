const { notFound } = require('./errors');

const nameCollator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

function toCrewMember(row) {
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function requireCrewMemberRow(db, id) {
  const row = db.prepare('SELECT * FROM crew_members WHERE id = ?').get(id);
  if (!row) {
    throw notFound('crew_member', id);
  }
  return row;
}

// Sorted in JavaScript, same reasoning as listPlaces: SQLite's NOCASE only
// folds ASCII, and a boat's crew roster stays small enough.
function listCrewMembers(db, { limit, offset }) {
  const rows = db.prepare('SELECT * FROM crew_members').all();
  rows.sort((a, b) => nameCollator.compare(a.name, b.name) || a.id - b.id);
  return {
    total: rows.length,
    limit,
    offset,
    items: rows.slice(offset, offset + limit).map(toCrewMember)
  };
}

function createCrewMember(db, { name, role }, now) {
  const { lastInsertRowid } = db
    .prepare('INSERT INTO crew_members (name, role, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(name, role ?? null, now, now);
  return toCrewMember(requireCrewMemberRow(db, Number(lastInsertRowid)));
}

function updateCrewMember(db, id, patch, now) {
  const row = requireCrewMemberRow(db, id);
  db.prepare('UPDATE crew_members SET name = ?, role = ?, updated_at = ? WHERE id = ?').run(
    patch.name ?? row.name,
    patch.role !== undefined ? patch.role : row.role,
    now,
    id
  );
  return toCrewMember(requireCrewMemberRow(db, id));
}

function deleteCrewMember(db, id) {
  requireCrewMemberRow(db, id);
  db.prepare('DELETE FROM crew_members WHERE id = ?').run(id);
}

// Reuses an existing roster member by name (case- and accent-insensitive,
// like listCrewMembers' sort), the way an unrecognised place name becomes a
// new place: a role given now fills one the existing member did not have,
// but never overwrites one already set -- that goes through updateCrewMember.
function findOrCreateCrewMember(db, name, role, now) {
  const existing = db
    .prepare('SELECT * FROM crew_members')
    .all()
    .find((row) => nameCollator.compare(row.name, name) === 0);
  if (!existing) {
    return createCrewMember(db, { name, role }, now);
  }
  if (role !== null && existing.role === null) {
    db.prepare('UPDATE crew_members SET role = ?, updated_at = ? WHERE id = ?').run(
      role,
      now,
      existing.id
    );
    return toCrewMember(requireCrewMemberRow(db, existing.id));
  }
  return toCrewMember(existing);
}

// Who was aboard a passage, in the order they were added.
function listEntryCrew(db, entryId) {
  return db
    .prepare('SELECT * FROM log_entry_crew WHERE entry_id = ? ORDER BY id')
    .all(entryId)
    .map((row) => ({
      id: row.id,
      crewMemberId: row.crew_member_id,
      name: row.name,
      role: row.role
    }));
}

// Replaces entryId's crew with exactly `members`: each item is either
// { crewMemberId } (an existing roster member, 404 if it doesn't exist) or
// { name, role } (extends the roster via findOrCreateCrewMember).
// name/role are denormalised onto the junction row at assignment time.
function setEntryCrew(db, entryId, members, now) {
  db.prepare('DELETE FROM log_entry_crew WHERE entry_id = ?').run(entryId);
  const insert = db.prepare(
    `INSERT INTO log_entry_crew (entry_id, crew_member_id, name, role, created_at)
     VALUES (?, ?, ?, ?, ?)`
  );
  const seen = new Set();
  for (const member of members) {
    const row =
      member.crewMemberId !== undefined
        ? requireCrewMemberRow(db, member.crewMemberId)
        : findOrCreateCrewMemberRow(db, member.name, member.role ?? null, now);
    if (seen.has(row.id)) {
      continue; // the same roster member picked twice in one request
    }
    seen.add(row.id);
    insert.run(entryId, row.id, row.name, row.role, now);
  }
  return listEntryCrew(db, entryId);
}

function findOrCreateCrewMemberRow(db, name, role, now) {
  const member = findOrCreateCrewMember(db, name, role, now);
  return requireCrewMemberRow(db, member.id);
}

// A new passage starts with the same crew as the one immediately before it
// (SPEC §4.11), still adjustable from there. Called right after INSERT in
// openPassage/openEntryByHand, inside the same transaction.
function copyCrewFromPreviousEntry(db, newEntryId, now) {
  const previous = db
    .prepare('SELECT id FROM log_entries WHERE id <> ? ORDER BY start_time DESC, id DESC LIMIT 1')
    .get(newEntryId);
  if (!previous) {
    return;
  }
  const insert = db.prepare(
    `INSERT INTO log_entry_crew (entry_id, crew_member_id, name, role, created_at)
     VALUES (?, ?, ?, ?, ?)`
  );
  for (const member of listEntryCrew(db, previous.id)) {
    insert.run(newEntryId, member.crewMemberId, member.name, member.role, now);
  }
}

// Called from mergeEntries before the later entry's row is deleted: unions
// laterId's crew onto earlierId's, skipping anyone already aboard -- carry-
// over means the two lists usually overlap heavily, and the partial unique
// index forbids assigning the same roster member to one entry twice.
function absorbCrewOnMerge(db, earlierId, laterId, now) {
  const earlierCrew = listEntryCrew(db, earlierId);
  const knownIds = new Set(earlierCrew.map((m) => m.crewMemberId).filter((id) => id !== null));
  const knownNames = new Set(
    earlierCrew.filter((m) => m.crewMemberId === null).map((m) => m.name.toLocaleLowerCase())
  );
  const insert = db.prepare(
    `INSERT INTO log_entry_crew (entry_id, crew_member_id, name, role, created_at)
     VALUES (?, ?, ?, ?, ?)`
  );
  for (const member of listEntryCrew(db, laterId)) {
    if (member.crewMemberId !== null) {
      if (knownIds.has(member.crewMemberId)) {
        continue;
      }
      knownIds.add(member.crewMemberId);
    } else {
      const key = member.name.toLocaleLowerCase();
      if (knownNames.has(key)) {
        continue;
      }
      knownNames.add(key);
    }
    insert.run(earlierId, member.crewMemberId, member.name, member.role, now);
  }
}

module.exports = {
  toCrewMember,
  listCrewMembers,
  createCrewMember,
  updateCrewMember,
  deleteCrewMember,
  requireCrewMemberRow,
  listEntryCrew,
  setEntryCrew,
  copyCrewFromPreviousEntry,
  absorbCrewOnMerge
};

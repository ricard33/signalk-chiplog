const { getLogbookId } = require('./cloud-sync');
const crew = require('./crew');
const { findDefectRow, toDefect } = require('./defects');
const { toEntry } = require('./entries');
const { ApiError } = require('./errors');
const { findEventRow, toEvent } = require('./events');
const { findPlanRow, toPlan } = require('./plans');

const DEFAULT_CHANGES_LIMIT = 200;
const MAX_CHANGES_LIMIT = 500;

// Each resource the feed reports (lib/database.js, CHANGE_FEED_TABLES), read as GET would
// give it, or null once it is gone.
const READERS = {
  entry: (db, id) => {
    const row = db.prepare('SELECT * FROM log_entries WHERE id = ?').get(id);
    return row ? toEntry(row) : null;
  },
  event: (db, id) => {
    const row = findEventRow(db, id);
    return row ? toEvent(row) : null;
  },
  crewMember: (db, id) => {
    const row = db.prepare('SELECT * FROM crew_members WHERE id = ?').get(id);
    return row ? crew.toCrewMember(row) : null;
  },
  // Who was aboard a passage; gone with the passage.
  entryCrew: (db, entryId) =>
    db.prepare('SELECT 1 FROM log_entries WHERE id = ?').get(entryId)
      ? { entryId, crew: crew.listEntryCrew(db, entryId) }
      : null,
  plan: (db, id) => {
    const row = findPlanRow(db, id);
    return row ? toPlan(row) : null;
  },
  defect: (db, id) => {
    const row = findDefectRow(db, id);
    return row ? toDefect(row) : null;
  }
};

function lastSeq(db) {
  return db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'changes'").get()?.seq ?? 0;
}

// What changed after `since`, oldest change first: each object once, as it stands now, or
// `deleted` with no item. `cursor` is what to ask from next; `more` says the page was full.
function listChanges(db, { since, limit }) {
  const head = lastSeq(db);
  // A cursor this logbook never gave: another logbook's, or this one's before a restore
  // from an older copy of the database.
  if (since > head) {
    throw new ApiError(
      410,
      'cursor_expired',
      `Cursor ${since} is ahead of this logbook's changes (${head}); start again from 0`
    );
  }
  const rows = db
    .prepare(
      'SELECT seq, resource, resource_id, changed_at FROM changes WHERE seq > ? ORDER BY seq LIMIT ?'
    )
    .all(since, limit + 1);
  const page = rows.slice(0, limit);
  return {
    logbookId: getLogbookId(db),
    cursor: page.at(-1)?.seq ?? since,
    more: rows.length > limit,
    items: page.map((row) => {
      const item = READERS[row.resource](db, row.resource_id);
      return {
        seq: row.seq,
        resource: row.resource,
        id: row.resource_id,
        changedAt: row.changed_at,
        deleted: item === null,
        item
      };
    })
  };
}

module.exports = { listChanges, DEFAULT_CHANGES_LIMIT, MAX_CHANGES_LIMIT };

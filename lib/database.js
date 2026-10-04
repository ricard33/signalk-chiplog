const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DATABASE_FILENAME = 'chiplog.sqlite';

// Manoeuvre shortcuts shipped with the plugin (SPEC §4.3). Users may disable or
// reorder them and add their own; a later migration adds new built-in ones.
const BUILTIN_MANOEUVRE_TYPES = [
  ['tack', 'Tack', 10],
  ['gybe', 'Gybe', 20],
  ['reef_in', 'Reef in', 30],
  ['reef_out', 'Shake out reef', 40],
  ['sail_change', 'Sail change', 50],
  ['anchor_down', 'Anchor down', 60],
  ['anchor_up', 'Anchor up', 70],
  ['moor', 'Moor', 80],
  ['cast_off', 'Cast off', 90],
  ['watch_change', 'Watch change', 100]
];

// Append-only: each entry is applied once, in order, and its index becomes the
// database's user_version. Never edit or reorder an already-released migration.
const MIGRATIONS = [
  `
  -- Units follow Signal K: angles in radians, speeds in m/s, distances in
  -- metres, durations in seconds, pressure in Pa, temperatures in K.
  -- Timestamps are ISO 8601 UTC text with millisecond precision.

  CREATE TABLE places (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    lat REAL NOT NULL,
    lon REAL NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('geocoding', 'manual')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  -- Supports the bounding-box prefilter of the radius match; the exact
  -- distance test then runs in application code.
  CREATE INDEX idx_places_position ON places (lat, lon);

  CREATE TABLE log_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'closed')),
    start_time TEXT NOT NULL,
    end_time TEXT,
    -- Set when the vessel stops, cleared if it moves again before the
    -- configured tolerance elapses (SPEC §3.1). Since migration 13, only a
    -- passage the crew opened by casting off waits like this; detection
    -- closes the others at once.
    stopped_since TEXT,
    start_lat REAL,
    start_lon REAL,
    end_lat REAL,
    end_lon REAL,
    start_place_id INTEGER REFERENCES places (id) ON DELETE SET NULL,
    end_place_id INTEGER REFERENCES places (id) ON DELETE SET NULL,
    -- Denormalised on purpose: the logbook records the name as it stood at the
    -- time, so renaming a place later must not rewrite past entries.
    start_place_name TEXT,
    end_place_name TEXT,
    distance REAL NOT NULL DEFAULT 0,
    engine_duration INTEGER NOT NULL DEFAULT 0,
    sail_duration INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (end_time IS NULL OR end_time >= start_time),
    CHECK (state = 'active' OR end_time IS NOT NULL)
  );

  CREATE INDEX idx_log_entries_start_time ON log_entries (start_time);

  -- One vessel per instance, passages are sequential: at most one open entry.
  CREATE UNIQUE INDEX idx_log_entries_single_active
    ON log_entries (state) WHERE state = 'active';

  -- Dense geometry for the map and the GPX export (SPEC §4.1). Deliberately
  -- narrow: instrument readings live in observations instead.
  CREATE TABLE track_points (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_id INTEGER NOT NULL REFERENCES log_entries (id) ON DELETE CASCADE,
    time TEXT NOT NULL,
    lat REAL NOT NULL,
    lon REAL NOT NULL,
    sog REAL,
    cog REAL
  );

  CREATE INDEX idx_track_points_entry_time ON track_points (entry_id, time);

  -- Sparse instrument snapshots: the rows the facsimile PDF renders as
  -- logbook lines (SPEC §4.5). Every reading is nullable, since a boat may
  -- lack any given sensor (SPEC §4.7).
  CREATE TABLE observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_id INTEGER NOT NULL REFERENCES log_entries (id) ON DELETE CASCADE,
    time TEXT NOT NULL,
    reason TEXT NOT NULL CHECK (reason IN ('periodic', 'entry_start', 'entry_end', 'event')),
    lat REAL,
    lon REAL,
    sog REAL,
    cog REAL,
    heading REAL,
    stw REAL,
    twd REAL,
    tws REAL,
    awa REAL,
    aws REAL,
    depth REAL,
    pressure REAL,
    air_temp REAL,
    water_temp REAL,
    trip_log REAL,
    engine_runtime REAL
  );

  CREATE INDEX idx_observations_entry_time ON observations (entry_id, time);

  CREATE TABLE propulsion_segments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_id INTEGER NOT NULL REFERENCES log_entries (id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK (type IN ('engine', 'sail')),
    start_time TEXT NOT NULL,
    end_time TEXT,
    -- 'manual' once a user correction has overridden the detection (SPEC §4.2).
    source TEXT NOT NULL DEFAULT 'auto' CHECK (source IN ('auto', 'manual')),
    average_rpm REAL,
    CHECK (end_time IS NULL OR end_time >= start_time)
  );

  CREATE INDEX idx_propulsion_segments_entry_time
    ON propulsion_segments (entry_id, start_time);

  CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_id INTEGER NOT NULL REFERENCES log_entries (id) ON DELETE CASCADE,
    time TEXT NOT NULL,
    type TEXT NOT NULL CHECK (
      type IN (
        'manoeuvre',
        'text_annotation',
        'handwritten_annotation',
        'sk_alarm',
        'autopilot',
        'weather_threshold',
        'manual_correction'
      )
    ),
    -- Qualifies the type: manoeuvre key, Signal K notification path, autopilot
    -- state. Intentionally not a foreign key, so history survives a manoeuvre
    -- type being deleted.
    subtype TEXT,
    lat REAL,
    lon REAL,
    comment TEXT,
    -- JSON, for structured detail only: handwritten strokes, sail selection,
    -- the before/after of a correction.
    payload TEXT,
    source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('auto', 'manual')),
    created_at TEXT NOT NULL
  );

  CREATE INDEX idx_events_entry_time ON events (entry_id, time);
  CREATE INDEX idx_events_type ON events (type);

  CREATE TABLE manoeuvre_types (
    key TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    icon TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    builtin INTEGER NOT NULL DEFAULT 0 CHECK (builtin IN (0, 1)),
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1))
  );
  `,
  `
  -- Last time passage detection saw the vessel moving, refreshed about once a
  -- minute while under way. After a restart it dates the end of a passage that
  -- stopped while the plugin was not running.
  ALTER TABLE log_entries ADD COLUMN last_moving_at TEXT;
  `,
  `
  -- A place name generated from coordinates while online geocoding has not
  -- yet answered for that departure or arrival. Cleared once resolved, or as
  -- soon as someone types a name.
  ALTER TABLE log_entries ADD COLUMN start_place_pending INTEGER NOT NULL DEFAULT 0
    CHECK (start_place_pending IN (0, 1));
  ALTER TABLE log_entries ADD COLUMN end_place_pending INTEGER NOT NULL DEFAULT 0
    CHECK (end_place_pending IN (0, 1));
  `,
  `
  -- The departure manoeuvre (cast off, anchor up) that opened this passage by
  -- hand before the vessel moved. Undoing that manoeuvre before any movement
  -- removes the passage with it.
  ALTER TABLE log_entries ADD COLUMN opened_by_event_id INTEGER
    REFERENCES events (id) ON DELETE SET NULL;

  -- Idempotency key chosen by the client, so an entry replayed from the
  -- tablet's offline queue after a lost response is not logged twice.
  ALTER TABLE events ADD COLUMN client_ref TEXT;
  CREATE UNIQUE INDEX idx_events_client_ref ON events (client_ref)
    WHERE client_ref IS NOT NULL;

  -- Finds the vessel's position at the time of an entry logged after the fact,
  -- before knowing which passage it belongs to.
  CREATE INDEX idx_track_points_time ON track_points (time);
  `,
  `
  -- Engine hour counters of every engine, as JSON {"port": 3600, ...} in
  -- seconds keyed by Signal K engine id. engine_runtime keeps the main (or
  -- first) engine's, as before.
  ALTER TABLE observations ADD COLUMN engine_runtimes TEXT;
  `,
  `
  -- Wind and heading at each track point, far denser than the hourly
  -- instrument snapshots (SPEC §4.5.1) -- an accurate max wind speed over a
  -- passage needs this; the sparse snapshots alone miss brief gusts.
  ALTER TABLE track_points ADD COLUMN tws REAL;
  ALTER TABLE track_points ADD COLUMN twd REAL;
  ALTER TABLE track_points ADD COLUMN aws REAL;
  ALTER TABLE track_points ADD COLUMN awa REAL;
  ALTER TABLE track_points ADD COLUMN heading REAL;
  `,
  // A function, not a SQL string: widening the `type` CHECK means rebuilding
  // `events` (SQLite cannot ALTER a CHECK constraint), and log_entries
  // references it (`opened_by_event_id`). With foreign keys enforced,
  // dropping the old table would fire its ON DELETE SET NULL for every row
  // first -- and that pragma only takes effect outside a transaction, which
  // the plain-SQL migrations above are always run inside.
  addPropulsionChangeEventType,
  `
  -- The tide forecast fetched near a passage's departure (SPEC §4.5.2): one row
  -- per entry, or none while a fetch is still pending or was never attempted.
  -- "points" is JSON [{ time, height }], height in metres, spanning the 24 h
  -- from departure; empty once fetched if the position has no tide data (a
  -- lake, an inland waterway).
  CREATE TABLE tide_forecasts (
    entry_id INTEGER PRIMARY KEY REFERENCES log_entries (id) ON DELETE CASCADE,
    lat REAL NOT NULL,
    lon REAL NOT NULL,
    fetched_at TEXT NOT NULL,
    points TEXT NOT NULL
  );
  `,
  `
  -- Speed through water at each track point, for the passage page's position
  -- scrubber (SPEC §4.1) -- true wind angle is derived from twd and heading
  -- instead of stored, since it needs no sensor of its own.
  ALTER TABLE track_points ADD COLUMN stw REAL;
  `,
  // Another CHECK-widening rebuild, same reason and same shape as
  // addPropulsionChangeEventType.
  addStopoverEventType,
  `
  -- The boat's state noted as the passage opened (SPEC §4.5.1), as JSON
  -- arrays: every tank's level, volume and capacity, every battery's voltage,
  -- current, state of charge and temperature, in SI units. NULL when the boat
  -- publishes none, or the passage was opened after the fact.
  ALTER TABLE log_entries ADD COLUMN start_tanks TEXT;
  ALTER TABLE log_entries ADD COLUMN start_batteries TEXT;
  `,
  `
  -- The marine weather forecast fetched near a passage's departure (SPEC
  -- §4.5.3), shaped like tide_forecasts: "points" is JSON [{ time, windSpeed,
  -- ..., currentDirection }], hourly over the 24 h from departure, in SI units
  -- with null for what the service did not give; empty once fetched if it had
  -- nothing for the position.
  CREATE TABLE weather_forecasts (
    entry_id INTEGER PRIMARY KEY REFERENCES log_entries (id) ON DELETE CASCADE,
    lat REAL NOT NULL,
    lon REAL NOT NULL,
    fetched_at TEXT NOT NULL,
    points TEXT NOT NULL
  );
  `,
  `
  -- Who closed a passage: detection, on arrival, or the crew. Only a passage
  -- detection closed is reopened by a departure within stopClosureMinutes
  -- (SPEC §4.2); the crew closing one confirms the arrival. NULL while active,
  -- and for passages closed before this column existed.
  ALTER TABLE log_entries ADD COLUMN closed_by TEXT CHECK (closed_by IN ('detection', 'crew'));
  `,
  `
  -- Crew list (SPEC §4.11): a small global roster of who might be aboard,
  -- ever -- unlike manoeuvre_types there is no builtin/sort_order, since the
  -- list is short enough to sort alphabetically at read time, like places.
  CREATE TABLE crew_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    role TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  -- Who was aboard a given passage -- the schema's first many-to-many
  -- relationship. name/role are denormalised on purpose, exactly like
  -- log_entries.start_place_name: a logbook is a historical record, so
  -- correcting or deleting a crew_members row (ON DELETE SET NULL) must
  -- never rewrite who a past passage says was aboard.
  CREATE TABLE log_entry_crew (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_id INTEGER NOT NULL REFERENCES log_entries (id) ON DELETE CASCADE,
    crew_member_id INTEGER REFERENCES crew_members (id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    role TEXT,
    created_at TEXT NOT NULL
  );

  CREATE INDEX idx_log_entry_crew_entry ON log_entry_crew (entry_id);

  -- A roster member is assigned to a given entry at most once. An ad hoc
  -- crew member with no roster row (crew_member_id NULL) has nothing to
  -- deduplicate against, hence the partial index.
  CREATE UNIQUE INDEX idx_log_entry_crew_unique_member
    ON log_entry_crew (entry_id, crew_member_id)
    WHERE crew_member_id IS NOT NULL;
  `,
  `
  -- Landmarks -- amers (SPEC §4.13): the named features a journal line's
  -- position is read against, "1.2 nm NE (053°) of Phare du Cap-Ferret".
  -- Fetched from OpenStreetMap area by area and kept: the bearing itself is
  -- worked out at read time, so a past passage fills in as soon as its area
  -- is known, and nothing here is part of the logbook's record.
  CREATE TABLE landmarks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    osm_type TEXT NOT NULL CHECK (osm_type IN ('node', 'way', 'relation')),
    osm_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (
      kind IN ('lighthouse', 'light', 'cape', 'landmark', 'beacon', 'harbour')
    ),
    lat REAL NOT NULL,
    lon REAL NOT NULL,
    -- The nominal range of its light in metres, when OpenStreetMap gives one:
    -- how far out this amer is still worth naming a position from.
    light_range REAL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE UNIQUE INDEX idx_landmarks_osm ON landmarks (osm_type, osm_id);

  -- Supports the bounding-box prefilter, as for places.
  CREATE INDEX idx_landmarks_position ON landmarks (lat, lon);

  -- The half-degree cells landmarks have already been fetched for. A fetch
  -- covers its cell plus a margin, so every position inside the cell has all
  -- the amers within range in the table -- one request per cell, ever.
  CREATE TABLE landmark_areas (
    cell_lat INTEGER NOT NULL,
    cell_lon INTEGER NOT NULL,
    fetched_at TEXT NOT NULL,
    PRIMARY KEY (cell_lat, cell_lon)
  );

  -- Cleared once every cell a closed passage sailed through has been fetched.
  -- An open passage stays pending: it keeps moving into new cells. Existing
  -- passages default to pending, so their areas are fetched too.
  ALTER TABLE log_entries ADD COLUMN landmarks_pending INTEGER NOT NULL DEFAULT 1
    CHECK (landmarks_pending IN (0, 1));
  `,
  `
  -- The country a place is in (SPEC §4.14), as an upper-case ISO 3166-1
  -- alpha-2 code, for the statistics page's visited countries. It lives on the
  -- place rather than on each entry: a passage reaches its country through
  -- start_place_id / end_place_id. country_checked says the lookup has been
  -- made, so a place whose position has no country (open water, or geocoding
  -- switched off after the fact) is not asked about forever. Existing places
  -- start unchecked and are filled in by the same background chain that names
  -- pending departures.
  ALTER TABLE places ADD COLUMN country_code TEXT;
  ALTER TABLE places ADD COLUMN country_checked INTEGER NOT NULL DEFAULT 0
    CHECK (country_checked IN (0, 1));
  `,
  // Another CHECK-widening rebuild, same reason and same shape as
  // addPropulsionChangeEventType.
  addHeadingChangeEventType,
  `
  -- The summary email sent once a passage is definitively closed (SPEC
  -- §4.16). One row per passage, written whatever the outcome: the row is what
  -- stops a summary going out twice, and its absence is what makes a passage
  -- due one. sent_at is null when it never went -- the server refused it for
  -- good, or the passage aged out of the window worth mailing -- with the
  -- reason in \`error\`.
  CREATE TABLE passage_summary_mails (
    entry_id INTEGER PRIMARY KEY REFERENCES log_entries (id) ON DELETE CASCADE,
    sent_at TEXT,
    recipients TEXT,
    error TEXT,
    created_at TEXT NOT NULL
  );

  -- Every passage already on record counts as dealt with: switching the option
  -- on is not a request for the whole logbook by email.
  INSERT INTO passage_summary_mails (entry_id, error, created_at)
    SELECT id, 'recorded before summary emails were available', end_time
    FROM log_entries WHERE state = 'closed';
  `,
  `
  -- The logbook's own identity, for the online backup (SPEC §4.17): the
  -- service files passages under it, so a reinstalled plugin, whose entry ids
  -- start again from 1, can never overwrite or delete the passages an earlier
  -- logbook sent. A random UUID, made once; a copy of this database file is
  -- the same logbook.
  CREATE TABLE logbook_identity (
    id TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  INSERT INTO logbook_identity (id, created_at) VALUES (
    lower(
      hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' ||
      substr(hex(randomblob(2)), 2) || '-' ||
      substr('89ab', 1 + abs(random()) % 4, 1) || substr(hex(randomblob(2)), 2) || '-' ||
      hex(randomblob(6))
    ),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  );
  `
];

function addPropulsionChangeEventType(db, version) {
  db.exec('PRAGMA foreign_keys = OFF');
  withTransaction(db, () => {
    db.exec(`
      -- Detection logs an automatic engine/sail switch the same way a manual
      -- one is corrected, so it shows in the log (SPEC §4.2).
      CREATE TABLE events_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entry_id INTEGER NOT NULL REFERENCES log_entries (id) ON DELETE CASCADE,
        time TEXT NOT NULL,
        type TEXT NOT NULL CHECK (
          type IN (
            'manoeuvre',
            'text_annotation',
            'handwritten_annotation',
            'sk_alarm',
            'autopilot',
            'weather_threshold',
            'manual_correction',
            'propulsion_change'
          )
        ),
        subtype TEXT,
        lat REAL,
        lon REAL,
        comment TEXT,
        payload TEXT,
        source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('auto', 'manual')),
        created_at TEXT NOT NULL,
        client_ref TEXT
      );
      INSERT INTO events_new (
        id, entry_id, time, type, subtype, lat, lon, comment, payload, source, created_at, client_ref
      )
      SELECT id, entry_id, time, type, subtype, lat, lon, comment, payload, source, created_at, client_ref
      FROM events;
      DROP TABLE events;
      ALTER TABLE events_new RENAME TO events;
      CREATE INDEX idx_events_entry_time ON events (entry_id, time);
      CREATE INDEX idx_events_type ON events (type);
      CREATE UNIQUE INDEX idx_events_client_ref ON events (client_ref)
        WHERE client_ref IS NOT NULL;
    `);
    db.exec(`PRAGMA user_version = ${version + 1}`);
  });
  db.exec('PRAGMA foreign_keys = ON');
}

function addStopoverEventType(db, version) {
  db.exec('PRAGMA foreign_keys = OFF');
  withTransaction(db, () => {
    db.exec(`
      -- Merging two entries (SPEC §3.1) folds the earlier one's arrival into
      -- the middle of the surviving passage, which would otherwise silently
      -- drop the only record of where that stop was.
      CREATE TABLE events_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entry_id INTEGER NOT NULL REFERENCES log_entries (id) ON DELETE CASCADE,
        time TEXT NOT NULL,
        type TEXT NOT NULL CHECK (
          type IN (
            'manoeuvre',
            'text_annotation',
            'handwritten_annotation',
            'sk_alarm',
            'autopilot',
            'weather_threshold',
            'manual_correction',
            'propulsion_change',
            'stopover'
          )
        ),
        subtype TEXT,
        lat REAL,
        lon REAL,
        comment TEXT,
        payload TEXT,
        source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('auto', 'manual')),
        created_at TEXT NOT NULL,
        client_ref TEXT
      );
      INSERT INTO events_new (
        id, entry_id, time, type, subtype, lat, lon, comment, payload, source, created_at, client_ref
      )
      SELECT id, entry_id, time, type, subtype, lat, lon, comment, payload, source, created_at, client_ref
      FROM events;
      DROP TABLE events;
      ALTER TABLE events_new RENAME TO events;
      CREATE INDEX idx_events_entry_time ON events (entry_id, time);
      CREATE INDEX idx_events_type ON events (type);
      CREATE UNIQUE INDEX idx_events_client_ref ON events (client_ref)
        WHERE client_ref IS NOT NULL;
    `);
    db.exec(`PRAGMA user_version = ${version + 1}`);
  });
  db.exec('PRAGMA foreign_keys = ON');
}

function addHeadingChangeEventType(db, version) {
  db.exec('PRAGMA foreign_keys = OFF');
  withTransaction(db, () => {
    db.exec(`
      -- The event-watcher logs a held course change (SPEC §4.6) the same way
      -- as the other automatic events.
      CREATE TABLE events_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entry_id INTEGER NOT NULL REFERENCES log_entries (id) ON DELETE CASCADE,
        time TEXT NOT NULL,
        type TEXT NOT NULL CHECK (
          type IN (
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
          )
        ),
        subtype TEXT,
        lat REAL,
        lon REAL,
        comment TEXT,
        payload TEXT,
        source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('auto', 'manual')),
        created_at TEXT NOT NULL,
        client_ref TEXT
      );
      INSERT INTO events_new (
        id, entry_id, time, type, subtype, lat, lon, comment, payload, source, created_at, client_ref
      )
      SELECT id, entry_id, time, type, subtype, lat, lon, comment, payload, source, created_at, client_ref
      FROM events;
      DROP TABLE events;
      ALTER TABLE events_new RENAME TO events;
      CREATE INDEX idx_events_entry_time ON events (entry_id, time);
      CREATE INDEX idx_events_type ON events (type);
      CREATE UNIQUE INDEX idx_events_client_ref ON events (client_ref)
        WHERE client_ref IS NOT NULL;
    `);
    db.exec(`PRAGMA user_version = ${version + 1}`);
  });
  db.exec('PRAGMA foreign_keys = ON');
}

function seedBuiltinManoeuvreTypes(db) {
  const insert = db.prepare(
    `INSERT INTO manoeuvre_types (key, label, sort_order, builtin)
     VALUES (?, ?, ?, 1)
     ON CONFLICT (key) DO NOTHING`
  );
  for (const [key, label, sortOrder] of BUILTIN_MANOEUVRE_TYPES) {
    insert.run(key, label, sortOrder);
  }
}

// Open transactions per connection. A call made inside another joins it
// rather than starting its own -- the retrospective replay wraps many
// detection ticks in one, so a long replay commits (and syncs) once per slice
// instead of once per tick. Only the outermost call commits or rolls back.
const transactionDepth = new WeakMap();

function withTransaction(db, fn) {
  const depth = transactionDepth.get(db) ?? 0;
  if (depth > 0) {
    transactionDepth.set(db, depth + 1);
    try {
      return fn();
    } finally {
      transactionDepth.set(db, depth);
    }
  }
  db.exec('BEGIN');
  transactionDepth.set(db, 1);
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    transactionDepth.delete(db);
  }
}

function getSchemaVersion(db) {
  return db.prepare('PRAGMA user_version').get().user_version;
}

function migrate(db) {
  const currentVersion = getSchemaVersion(db);

  for (let version = currentVersion; version < MIGRATIONS.length; version += 1) {
    const step = MIGRATIONS[version];
    if (typeof step === 'function') {
      step(db, version);
    } else {
      withTransaction(db, () => {
        db.exec(step);
        if (version === 0) {
          seedBuiltinManoeuvreTypes(db);
        }
        db.exec(`PRAGMA user_version = ${version + 1}`);
      });
    }
  }

  return { from: currentVersion, to: MIGRATIONS.length };
}

function openDatabase(dataDirPath) {
  const db = new DatabaseSync(path.join(dataDirPath, DATABASE_FILENAME));

  // WAL keeps reads working while a passage is being written, and survives
  // the abrupt power cuts a boat installation gets.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');

  const migrated = migrate(db);

  return { db, migrated };
}

module.exports = { openDatabase, withTransaction, getSchemaVersion, DATABASE_FILENAME };

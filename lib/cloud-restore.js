const { withTransaction } = require('./database');
const { getLogbookId, isRestoring } = require('./cloud-sync');
const { TRACK_READINGS, OBSERVATION_READINGS } = require('./passage-import');

const REQUEST_TIMEOUT_MS = 2 * 60 * 1000;

class CloudRestoreError extends Error {
  constructor(message, { status = null, code = null } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const json = (value) => (value === null || value === undefined ? null : JSON.stringify(value));

// Rows keep the id they had: the passage then hashes as it did when it was sent, and the
// backup that follows the restore has nothing to send again. An id taken since -- by something
// logged while the restore was under way -- gives way to a new one.
function insertKeepingId(db, table, id, values) {
  const taken =
    id !== null &&
    id !== undefined &&
    db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id) !== undefined;
  const row = taken || id === null || id === undefined ? values : { id, ...values };
  const columns = Object.keys(row);
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`
    )
    .run(...columns.map((column) => row[column]));
  return Number(lastInsertRowid);
}

// The next row a table numbers by itself comes after `id`: what is logged live during a
// restore must not take the number of a passage still to come.
function reserveIds(db, table, id) {
  const row = db.prepare('SELECT seq FROM sqlite_sequence WHERE name = ?').get(table);
  if (!row) {
    db.prepare('INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)').run(table, id);
  } else if (row.seq < id) {
    db.prepare('UPDATE sqlite_sequence SET seq = ? WHERE name = ?').run(id, table);
  }
}

// Places keep their ids too: passages point at them. Only what the service holds comes back --
// name, position, country -- so the list differs from the one sent, and is sent again once.
function restorePlaces(db, places, now) {
  const insert = db.prepare(
    `INSERT INTO places (id, name, lat, lon, source, country_code, country_checked, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO NOTHING`
  );
  for (const place of places) {
    insert.run(
      place.id,
      place.name,
      place.position.lat,
      place.position.lon,
      place.source === 'geocoding' ? 'geocoding' : 'manual',
      place.countryCode ?? null,
      place.countryCode ? 1 : 0,
      now,
      now
    );
  }
}

// Writes one passage as the service holds it, with everything that hangs from it, under the
// id it had. All or nothing. A passage still under way when it was last sent is closed where
// its track ends: whatever the boat is doing now, it is not on that passage any more.
function restorePassage(db, { passage, points }, now) {
  const { entry } = passage;
  return withTransaction(db, () => {
    const placeId = (id) =>
      id !== null &&
      id !== undefined &&
      db.prepare('SELECT 1 FROM places WHERE id = ?').get(id) !== undefined
        ? id
        : null;
    const closed = entry.state === 'closed' && entry.endTime;
    const endTime = closed ? entry.endTime : (points.at(-1)?.time ?? entry.startTime);

    db.prepare(
      `INSERT INTO log_entries (
         id, state, start_time, end_time, stopped_since, start_lat, start_lon, end_lat, end_lon,
         start_place_id, end_place_id, start_place_name, end_place_name,
         start_place_pending, end_place_pending, distance, engine_duration, sail_duration,
         start_tanks, start_batteries, created_at, updated_at
       ) VALUES (?, 'closed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      entry.id,
      entry.startTime,
      endTime < entry.startTime ? entry.startTime : endTime,
      closed ? (entry.stoppedSince ?? null) : null,
      entry.startPosition?.lat ?? null,
      entry.startPosition?.lon ?? null,
      entry.endPosition?.lat ?? null,
      entry.endPosition?.lon ?? null,
      placeId(entry.startPlaceId),
      placeId(entry.endPlaceId),
      entry.startPlaceName ?? null,
      entry.endPlaceName ?? null,
      entry.startPlacePending ? 1 : 0,
      entry.endPlacePending ? 1 : 0,
      entry.distance ?? 0,
      entry.engineDuration ?? 0,
      entry.sailDuration ?? 0,
      json(entry.startTanks),
      json(entry.startBatteries),
      entry.createdAt ?? now,
      entry.updatedAt ?? now
    );

    const insertPoint = db.prepare(
      `INSERT INTO track_points (entry_id, time, lat, lon, ${TRACK_READINGS.join(', ')})
       VALUES (?, ?, ?, ?, ${TRACK_READINGS.map(() => '?').join(', ')})`
    );
    for (const point of points) {
      insertPoint.run(
        entry.id,
        point.time,
        point.lat,
        point.lon,
        ...TRACK_READINGS.map((reading) => point[reading] ?? null)
      );
    }

    const eventIds = new Map();
    for (const event of passage.events ?? []) {
      const id = insertKeepingId(db, 'events', event.id, {
        entry_id: entry.id,
        time: event.time,
        type: event.type,
        subtype: event.subtype ?? null,
        lat: event.position?.lat ?? null,
        lon: event.position?.lon ?? null,
        comment: event.comment ?? null,
        payload: json(event.payload),
        source: event.source === 'auto' ? 'auto' : 'manual',
        created_at: event.createdAt ?? now,
        client_ref: event.clientRef ?? null
      });
      eventIds.set(event.id, id);
    }
    if (eventIds.has(entry.openedByEventId)) {
      db.prepare('UPDATE log_entries SET opened_by_event_id = ? WHERE id = ?').run(
        eventIds.get(entry.openedByEventId),
        entry.id
      );
    }

    for (const observation of passage.observations ?? []) {
      insertKeepingId(db, 'observations', observation.id, {
        entry_id: entry.id,
        time: observation.time,
        reason: observation.reason,
        lat: observation.position?.lat ?? null,
        lon: observation.position?.lon ?? null,
        ...Object.fromEntries(
          OBSERVATION_READINGS.map(([column, field]) => [column, observation[field] ?? null])
        ),
        engine_runtimes: json(observation.engineRuntimes)
      });
    }

    for (const segment of passage.propulsion ?? []) {
      insertKeepingId(db, 'propulsion_segments', segment.id, {
        entry_id: entry.id,
        type: segment.type,
        start_time: segment.startTime,
        end_time: segment.endTime ?? endTime,
        source: segment.source === 'manual' ? 'manual' : 'auto',
        average_rpm: segment.averageRpm ?? null
      });
    }

    for (const member of passage.crew ?? []) {
      // The crew list itself is not backed up, only who sailed each passage: the people are
      // made again from the passages they were on, under the number they had.
      let memberId = member.crewMemberId ?? null;
      if (memberId !== null) {
        const known = db.prepare('SELECT name FROM crew_members WHERE id = ?').get(memberId);
        if (!known) {
          db.prepare(
            `INSERT INTO crew_members (id, name, role, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?)`
          ).run(memberId, member.name, member.role ?? null, now, now);
        } else if (known.name !== member.name) {
          memberId = null;
        }
      }
      insertKeepingId(db, 'log_entry_crew', member.id, {
        entry_id: entry.id,
        crew_member_id: memberId,
        name: member.name,
        role: member.role ?? null,
        created_at: now
      });
    }

    for (const [table, forecast] of [
      ['tide_forecasts', passage.tide],
      ['weather_forecasts', passage.weather]
    ]) {
      if (forecast?.position && Array.isArray(forecast.points)) {
        db.prepare(
          `INSERT INTO ${table} (entry_id, lat, lon, fetched_at, points) VALUES (?, ?, ?, ?, ?)`
        ).run(
          entry.id,
          forecast.position.lat,
          forecast.position.lon,
          forecast.fetchedAt ?? now,
          JSON.stringify(forecast.points)
        );
      }
    }

    // A passage restored is not one just sailed: nobody is to be emailed its summary.
    db.prepare(
      `INSERT INTO passage_summary_mails (entry_id, error, created_at)
       VALUES (?, 'restored from the online backup', ?)`
    ).run(entry.id, now);
  });
}

// Brings an earlier logbook of this boat back from the online service into this one, empty
// (SPEC §4.17) -- after a lost SD card, a new computer. This logbook takes the identity of the
// one restored and its passages their numbers, so the backup carries on where it stopped
// instead of sending everything again as a second logbook. The boat asks; the service never
// calls it. Interrupted, it picks up where it stopped: the identity is taken first, and the
// passages already written are skipped.
function createCloudRestore({
  db,
  settings,
  userAgent,
  log,
  onDone = () => {},
  fetch = globalThis.fetch,
  clock = Date.now
}) {
  let running = null;
  let stopped = false;
  let progress = null;
  let lastError = null;
  let lastResult = null;

  const iso = (ms) => new Date(ms).toISOString();
  const configured = () => Boolean(settings.cloudSyncUrl && settings.cloudSyncToken);
  const isEmpty = () => db.prepare('SELECT count(*) AS n FROM log_entries').get().n === 0;

  async function call(path) {
    const response = await fetch(`${settings.cloudSyncUrl.replace(/\/+$/, '')}/v1${path}`, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${settings.cloudSyncToken}`,
        'user-agent': userAgent,
        'x-chiplog-version': userAgent.split('/')[1] ?? ''
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    if (!response.ok) {
      let detail = {};
      try {
        detail = await response.json();
      } catch {
        // Not every failure comes from the service itself: a proxy, a captive portal.
      }
      throw new CloudRestoreError(
        `GET ${path} answered ${response.status}${detail.message ? `: ${detail.message}` : ''}`,
        { status: response.status, code: detail.error ?? null }
      );
    }
    return response.json();
  }

  async function restore(logbookId) {
    const base = `/logbooks/${logbookId}`;
    const index = await call(`${base}/restore`);
    const now = iso(clock());
    withTransaction(db, () => {
      db.prepare('UPDATE logbook_identity SET id = ?, restoring = 1').run(logbookId);
      reserveIds(db, 'log_entries', Math.max(0, ...index.passages.map((item) => item.originId)));
      restorePlaces(db, index.places ?? [], now);
    });

    const onBoard = new Set(
      db
        .prepare('SELECT id FROM log_entries')
        .all()
        .map((row) => row.id)
    );
    const due = index.passages.filter((item) => !onBoard.has(item.originId));
    progress = { total: index.passages.length, done: index.passages.length - due.length };
    let restored = 0;
    let failed = 0;
    for (const item of due) {
      if (stopped) {
        return null;
      }
      const { passage } = await call(`${base}/passages/${item.originId}`);
      const points = [];
      for (let chunk = 0; chunk < item.trackChunks; chunk += 1) {
        if (stopped) {
          return null;
        }
        try {
          points.push(...(await call(`${base}/passages/${item.originId}/track/${chunk}`)).points);
        } catch (error) {
          // A chunk the service never received: the passage comes back with the track it has.
          if (error.code !== 'chunk_not_found') {
            throw error;
          }
        }
      }
      try {
        restorePassage(db, { passage, points }, iso(clock()));
        restored += 1;
      } catch (error) {
        // One passage this logbook cannot take must not keep all the others out.
        failed += 1;
        log('error', `Passage ${item.originId} could not be restored: ${error.message}`);
      }
      progress.done += 1;
    }
    db.prepare('UPDATE logbook_identity SET restoring = 0').run();
    return { passages: restored, failed, total: index.passages.length };
  }

  function start(logbookId) {
    if (running) {
      throw new CloudRestoreError('A restore is already under way', { code: 'restore_running' });
    }
    if (!configured()) {
      throw new CloudRestoreError('Pair this boat with the service first', {
        code: 'cloud_sync_not_configured'
      });
    }
    const resuming = isRestoring(db) && getLogbookId(db) === logbookId;
    if (!resuming && !isEmpty()) {
      throw new CloudRestoreError(
        'Only an empty logbook can take a restored one: this one already holds passages',
        { code: 'logbook_not_empty' }
      );
    }
    stopped = false;
    lastError = null;
    lastResult = null;
    progress = { total: 0, done: 0 };
    running = restore(logbookId)
      .then((result) => {
        if (result) {
          lastResult = { at: iso(clock()), logbookId, ...result };
          log(
            'info',
            `Logbook restored from the online backup: ${result.passages} passage(s)${result.failed ? `, ${result.failed} refused` : ''}`
          );
          onDone();
        }
      })
      .catch((error) => {
        lastError = { at: iso(clock()), message: error.message, code: error.code ?? null };
        log('error', `Restoring from the online backup failed: ${error.message}`);
      })
      .finally(() => {
        running = null;
        progress = null;
      });
    return running;
  }

  return {
    // The logbooks of this boat the service can give back; this one, still empty, is not one.
    async candidates() {
      if (!configured()) {
        return [];
      }
      const own = getLogbookId(db);
      const { logbooks } = await call('/restore/logbooks');
      return logbooks.filter((logbook) => logbook.logbookId !== own || isRestoring(db));
    },

    // Starts in the background; `finished` settles when the restore ends, well or not.
    start(logbookId) {
      const finished = start(logbookId);
      return { finished };
    },

    // Carries on with a restore the last run left unfinished, if any.
    resume() {
      if (!running && configured() && isRestoring(db)) {
        return this.start(getLogbookId(db));
      }
      return null;
    },

    status() {
      const restoring = isRestoring(db);
      return {
        // Unfinished: under way, or waiting to be carried on with.
        restoring,
        running: running !== null,
        possible: configured() && !restoring && running === null && isEmpty(),
        inProgress: progress,
        lastResult,
        lastError
      };
    },

    stop() {
      stopped = true;
    }
  };
}

module.exports = { createCloudRestore, restorePassage, CloudRestoreError };

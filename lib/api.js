const { getSchemaVersion } = require('./database');
const crew = require('./crew');
const { ApiError, badRequest, conflict, notFound } = require('./errors');
const entries = require('./entries');
const events = require('./events');
const { renderExport } = require('./export');
const { listEntryLandmarks } = require('./landmarks');
const { isTimeZone, PDF_LANGUAGES } = require('./logbook-pdf');
const { toGeoJson, toGpx } = require('./formats');
const manoeuvreTypes = require('./manoeuvre-types');
const { importPassage, TRACK_READINGS, OBSERVATION_READINGS } = require('./passage-import');
const places = require('./places');
const propulsion = require('./propulsion');
const { getTideForecast } = require('./tide-forecaster');
const { getWeatherForecast } = require('./weather-forecaster');
const { getStatistics } = require('./statistics');
const track = require('./track');
const v = require('./validation');

const SQLITE_CONSTRAINT = 19;

// Servers predating router.access() only support admin-only plugin routes.
// Falling back keeps the plugin usable there, at the cost of an admin login.
function scoped(router, level) {
  return typeof router.access === 'function' ? router.access(level) : router;
}

function sendError(res, err, logError) {
  if (err instanceof ApiError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message } });
    return;
  }
  // Extended SQLite codes carry the primary code in their low byte.
  if (err.code === 'ERR_SQLITE_ERROR' && (err.errcode & 0xff) === SQLITE_CONSTRAINT) {
    res.status(409).json({ error: { code: 'constraint_violation', message: err.message } });
    return;
  }
  logError(err);
  res
    .status(500)
    .json({ error: { code: 'internal_error', message: 'Unexpected error, see the server log' } });
}

function optional(body, field, parse) {
  return field in body ? parse(body[field], field) : undefined;
}

function withoutUndefined(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
}

function parsePayload(value, name) {
  if (value !== null && !v.isPlainObject(value)) {
    throw badRequest(`${name} must be a JSON object or null`);
  }
  return value;
}

function parseBoolean(value, name) {
  if (typeof value !== 'boolean') {
    throw badRequest(`${name} must be a boolean`);
  }
  return value;
}

function parseInteger(value, name) {
  if (!Number.isInteger(value)) {
    throw badRequest(`${name} must be an integer`);
  }
  return value;
}

const nullableString = (maxLength) => (value, name) =>
  v.parseString(value, name, { maxLength, allowNull: true });

const requiredString = (maxLength) => (value, name) => v.parseString(value, name, { maxLength });

function parseRange(query) {
  return {
    from: v.parseOptionalTimestamp(query.from, 'from'),
    to: v.parseOptionalTimestamp(query.to, 'to')
  };
}

const TRACK_POINT_FIELDS = ['time', 'lat', 'lon', ...TRACK_READINGS];
const OBSERVATION_FIELD_READINGS = OBSERVATION_READINGS.map(([, field]) => field);
const OBSERVATION_FIELDS = ['time', 'reason', 'position', ...OBSERVATION_FIELD_READINGS];
const OBSERVATION_REASONS = ['periodic', 'entry_start', 'entry_end', 'event'];

const nullableNumber = (value, name) => (value === null ? null : v.parseNumber(value, name));

// A list of objects in a request body, each checked field by field; an absent
// list is an empty one.
function parseList(body, field, parseItem) {
  if (!(field in body)) {
    return [];
  }
  if (!Array.isArray(body[field])) {
    throw badRequest(`${field} must be an array`);
  }
  return body[field].map((item, index) => parseItem(item, `${field}[${index}]`));
}

function parseTrackPoint(item, name) {
  const point = v.requireBody(item, TRACK_POINT_FIELDS);
  const { lat, lon } = v.parsePosition({ lat: point.lat, lon: point.lon }, name);
  return {
    time: v.parseTimestamp(point.time, `${name}.time`),
    lat,
    lon,
    ...Object.fromEntries(
      TRACK_READINGS.filter((reading) => reading in point).map((reading) => [
        reading,
        nullableNumber(point[reading], `${name}.${reading}`)
      ])
    )
  };
}

function parseObservation(item, name) {
  const observation = v.requireBody(item, OBSERVATION_FIELDS);
  return {
    time: v.parseTimestamp(observation.time, `${name}.time`),
    reason: v.parseEnum(observation.reason, `${name}.reason`, OBSERVATION_REASONS),
    position: optional(observation, 'position', v.parsePosition),
    ...Object.fromEntries(
      OBSERVATION_FIELD_READINGS.filter((reading) => reading in observation).map((reading) => [
        reading,
        nullableNumber(observation[reading], `${name}.${reading}`)
      ])
    )
  };
}

// A tank as noted at departure: level as a ratio, volume and capacity in m³.
function parseTank(item, name) {
  const tank = v.requireBody(item, ['type', 'id', 'name', 'level', 'volume', 'capacity']);
  const readings = ['level', 'volume', 'capacity'].filter((field) => tank[field] != null);
  if (!('level' in tank || 'volume' in tank)) {
    throw badRequest(`${name} needs a level or a volume`);
  }
  return {
    type: v.parseString(tank.type, `${name}.type`, { maxLength: 40 }),
    id: v.parseString(tank.id, `${name}.id`, { maxLength: 40 }),
    ...(tank.name == null
      ? {}
      : { name: v.parseString(tank.name, `${name}.name`, { maxLength: 100 }) }),
    ...Object.fromEntries(
      readings.map((field) => [field, v.parseNonNegativeNumber(tank[field], `${name}.${field}`)])
    )
  };
}

// A battery as noted at departure: volts, amps (negative discharging), state of
// charge as a ratio, kelvin.
function parseBattery(item, name) {
  const battery = v.requireBody(item, [
    'id',
    'name',
    'voltage',
    'current',
    'stateOfCharge',
    'temperature'
  ]);
  const readings = ['voltage', 'current', 'stateOfCharge', 'temperature'].filter(
    (field) => battery[field] != null
  );
  if (readings.length === 0) {
    throw badRequest(`${name} needs at least one reading`);
  }
  return {
    id: v.parseString(battery.id, `${name}.id`, { maxLength: 40 }),
    ...(battery.name == null
      ? {}
      : { name: v.parseString(battery.name, `${name}.name`, { maxLength: 100 }) }),
    ...Object.fromEntries(
      readings.map((field) => [field, v.parseNumber(battery[field], `${name}.${field}`)])
    )
  };
}

function parsePropulsionPeriod(item, name) {
  const segment = v.requireBody(item, ['type', 'startTime', 'endTime']);
  return {
    type: v.parseEnum(segment.type, `${name}.type`, ['engine', 'sail']),
    startTime: v.parseTimestamp(segment.startTime, `${name}.startTime`),
    endTime: v.parseTimestamp(segment.endTime, `${name}.endTime`)
  };
}

function registerRoutes(router, { getContext, logError }) {
  const readonly = scoped(router, 'readonly');
  const readwrite = scoped(router, 'readwrite');
  const admin = router;

  const handle = (fn) => async (req, res) => {
    try {
      const body = await fn(getContext(), req, res);
      if (!res.headersSent) {
        if (body === undefined) {
          res.status(204).end();
        } else {
          res.json(body);
        }
      }
    } catch (err) {
      sendError(res, err, logError);
    }
  };

  const entryId = (req) => v.parseId(req.params.id);

  readonly.get(
    '/api/state',
    handle(({ db, detection }) => {
      const { mode, motion, propulsion: under, stateIssue } = detection();
      return {
        activeEntryId:
          db.prepare("SELECT id FROM log_entries WHERE state = 'active'").get()?.id ?? null,
        detection: mode,
        motion,
        propulsion: under,
        stateIssue,
        schemaVersion: getSchemaVersion(db)
      };
    })
  );

  // Entries

  readonly.get(
    '/api/entries',
    handle(({ db }, req) =>
      entries.listEntries(db, { ...parseRange(req.query), ...v.parsePagination(req.query) })
    )
  );

  readonly.get(
    '/api/entries/stats',
    handle(({ db, now }, req) => entries.getStats(db, { ...parseRange(req.query), now: now() }))
  );

  readonly.get(
    '/api/statistics',
    handle(({ db, now }, req) => getStatistics(db, { ...parseRange(req.query), now: now() }))
  );

  readonly.get(
    '/api/entries/:id',
    handle(({ db }, req) => entries.getEntry(db, entryId(req)))
  );

  // A finished passage recorded elsewhere, such as another logbook's export.
  admin.post(
    '/api/entries',
    handle(({ db, config, now }, req, res) => {
      const body = v.requireBody(req.body, [
        'startTime',
        'endTime',
        'startPosition',
        'endPosition',
        'startPlaceName',
        'endPlaceName',
        'distance',
        'startTanks',
        'startBatteries',
        'trackPoints',
        'observations',
        'propulsion'
      ]);
      const entry = importPassage(
        db,
        {
          startTime: v.parseTimestamp(body.startTime, 'startTime'),
          endTime: v.parseTimestamp(body.endTime, 'endTime'),
          startPosition: optional(body, 'startPosition', v.parsePosition) ?? null,
          endPosition: optional(body, 'endPosition', v.parsePosition) ?? null,
          startPlaceName: optional(body, 'startPlaceName', nullableString(200)) ?? null,
          endPlaceName: optional(body, 'endPlaceName', nullableString(200)) ?? null,
          distance: optional(body, 'distance', v.parseNonNegativeNumber),
          startTanks: parseList(body, 'startTanks', parseTank),
          startBatteries: parseList(body, 'startBatteries', parseBattery),
          trackPoints: parseList(body, 'trackPoints', parseTrackPoint),
          observations: parseList(body, 'observations', parseObservation),
          propulsion: parseList(body, 'propulsion', parsePropulsionPeriod)
        },
        { placeMatchRadius: config.placeMatchRadius, now: now() }
      );
      res.status(201);
      return entry;
    })
  );

  readwrite.patch(
    '/api/entries/:id',
    handle(({ db, config, now }, req) => {
      const id = entryId(req);
      const body = v.requireBody(req.body, [
        'startTime',
        'endTime',
        'startPosition',
        'endPosition',
        'startPlaceName',
        'endPlaceName',
        'distance'
      ]);
      const patch = {
        startTime: optional(body, 'startTime', v.parseTimestamp),
        endTime: optional(body, 'endTime', v.parseTimestamp),
        startPosition: optional(body, 'startPosition', v.parsePosition),
        endPosition: optional(body, 'endPosition', v.parsePosition),
        startPlaceName: optional(body, 'startPlaceName', nullableString(200)),
        endPlaceName: optional(body, 'endPlaceName', nullableString(200)),
        distance: optional(body, 'distance', v.parseNonNegativeNumber)
      };
      return entries.updateEntry(db, id, patch, {
        placeMatchRadius: config.placeMatchRadius,
        now: now()
      });
    })
  );

  readwrite.post(
    '/api/entries/:id/close',
    handle(({ db, config, now, vesselPosition }, req) =>
      entries.closeEntry(db, entryId(req), {
        now: now(),
        position: vesselPosition(),
        placeMatchRadius: config.placeMatchRadius
      })
    )
  );

  readwrite.post(
    '/api/entries/:id/merge',
    handle(({ db, now }, req) => {
      const id = entryId(req);
      const body = v.requireBody(req.body, ['withEntryId']);
      return entries.mergeEntries(db, id, v.parseId(body.withEntryId, 'withEntryId'), now());
    })
  );

  admin.delete(
    '/api/entries/:id',
    handle(({ db }, req) => {
      entries.deleteEntry(db, entryId(req));
    })
  );

  // Track, observations, propulsion

  readonly.get(
    '/api/entries/:id/track',
    handle(({ db }, req, res) => {
      const id = entryId(req);
      const format = v.parseEnum(req.query.format ?? 'geojson', 'format', ['geojson', 'gpx']);
      const entry = entries.getEntry(db, id);
      const trackPoints = track.allTrackPoints(db, id);
      if (format === 'gpx') {
        res.type('application/gpx+xml').send(toGpx([{ entry, trackPoints }]));
        return null;
      }
      return toGeoJson(entry, trackPoints);
    })
  );

  readonly.get(
    '/api/entries/:id/observations',
    handle(({ db }, req) => track.listObservations(db, entryId(req), v.parsePagination(req.query)))
  );

  readonly.get(
    '/api/entries/:id/propulsion',
    handle(({ db }, req) => propulsion.listSegments(db, entryId(req), v.parsePagination(req.query)))
  );

  readwrite.patch(
    '/api/propulsion/:id',
    handle(({ db, now }, req) => {
      const id = v.parseId(req.params.id);
      const body = v.requireBody(req.body, ['type']);
      const type = v.parseEnum(body.type, 'type', ['engine', 'sail']);
      return propulsion.correctSegment(db, id, { type }, { now: now() });
    })
  );

  // The amers a line of this passage's journal can be read against (SPEC
  // §4.13); which one each line takes, and the bearing, is worked out where
  // the line is shown. Empty until the area's landmarks have been fetched.
  readonly.get(
    '/api/entries/:id/landmarks',
    handle(({ db }, req) => {
      const id = entryId(req);
      entries.requireEntryRow(db, id);
      const { limit, offset } = v.parsePagination(req.query);
      const items = listEntryLandmarks(db, id);
      return { total: items.length, limit, offset, items: items.slice(offset, offset + limit) };
    })
  );

  readonly.get(
    '/api/entries/:id/tide',
    handle(({ db }, req) => {
      const id = entryId(req);
      entries.requireEntryRow(db, id);
      const forecast = getTideForecast(db, id);
      if (!forecast) {
        throw notFound('tide', id);
      }
      return forecast;
    })
  );

  readonly.get(
    '/api/entries/:id/weather',
    handle(({ db }, req) => {
      const id = entryId(req);
      entries.requireEntryRow(db, id);
      const forecast = getWeatherForecast(db, id);
      if (!forecast) {
        throw notFound('weather', id);
      }
      return forecast;
    })
  );

  // Events

  readonly.get(
    '/api/entries/:id/events',
    handle(({ db }, req) =>
      events.listEvents(db, entryId(req), {
        type:
          req.query.type === undefined
            ? undefined
            : v.parseEnum(req.query.type, 'type', events.EVENT_TYPES),
        ...v.parsePagination(req.query)
      })
    )
  );

  const EVENT_FIELDS = ['type', 'subtype', 'comment', 'payload', 'time', 'position', 'clientRef'];

  const parseEventInput = (body) => ({
    type: v.parseEnum(body.type, 'type', events.CLIENT_EVENT_TYPES),
    subtype: optional(body, 'subtype', nullableString(200)),
    comment: optional(body, 'comment', nullableString(10000)),
    payload: optional(body, 'payload', parsePayload),
    time: optional(body, 'time', v.parseTimestamp),
    position: optional(body, 'position', v.parsePosition),
    clientRef: optional(body, 'clientRef', requiredString(100))
  });

  // Conditions at a manoeuvre, note or sketch belong in the log — but only as
  // it happens; readings now say nothing about one logged after the fact.
  // Likewise the boat's state, for a passage the crew opened by casting off.
  const observeLiveEvent = (context, input, { event, created, openedEntry }) => {
    if (created && events.CLIENT_EVENT_TYPES.includes(event.type) && input.time === undefined) {
      context.observeEvent(event.entryId, event.time);
      if (openedEntry) {
        context.noteDeparture(event.entryId);
      }
    }
  };

  readwrite.post(
    '/api/entries/:id/events',
    handle((context, req, res) => {
      const { db, now, vesselPosition } = context;
      const id = entryId(req);
      const input = parseEventInput(v.requireBody(req.body, EVENT_FIELDS));
      const outcome = events.createEvent(db, id, input, {
        now: now(),
        vesselPosition: vesselPosition()
      });
      observeLiveEvent(context, input, outcome);
      res.status(outcome.created ? 201 : 200);
      return outcome.event;
    })
  );

  // What the tablet posts: the server finds the passage the entry belongs to.
  readwrite.post(
    '/api/events',
    handle((context, req, res) => {
      const { db, config, now, vesselPosition } = context;
      const input = parseEventInput(v.requireBody(req.body, EVENT_FIELDS));
      const outcome = events.logCrewEvent(db, input, {
        now: now(),
        vesselPosition: vesselPosition(),
        placeMatchRadius: config.placeMatchRadius,
        stopClosureMinutes: config.stopClosureMinutes
      });
      observeLiveEvent(context, input, outcome);
      res.status(outcome.created ? 201 : 200);
      return { ...outcome.event, openedEntry: outcome.openedEntry };
    })
  );

  readwrite.patch(
    '/api/events/:id',
    handle(({ db, now }, req) => {
      const id = v.parseId(req.params.id);
      const body = v.requireBody(req.body, ['time', 'comment', 'subtype', 'payload']);
      const patch = withoutUndefined({
        time: optional(body, 'time', v.parseTimestamp),
        comment: optional(body, 'comment', nullableString(10000)),
        subtype: optional(body, 'subtype', nullableString(200)),
        payload: optional(body, 'payload', parsePayload)
      });
      return events.updateEvent(db, id, patch, { now: now() });
    })
  );

  readwrite.delete(
    '/api/events/:id',
    handle(({ db }, req) => {
      events.deleteEvent(db, v.parseId(req.params.id));
    })
  );

  // Places

  readonly.get(
    '/api/places',
    handle(({ db }, req) => places.listPlaces(db, v.parsePagination(req.query)))
  );

  readwrite.patch(
    '/api/places/:id',
    handle(({ db, now }, req) => {
      const id = v.parseId(req.params.id);
      const body = v.requireBody(req.body, ['name']);
      return places.renamePlace(
        db,
        id,
        v.parseString(body.name, 'name', { maxLength: 200 }),
        now()
      );
    })
  );

  admin.delete(
    '/api/places/:id',
    handle(({ db }, req) => {
      places.deletePlace(db, v.parseId(req.params.id));
    })
  );

  // Manoeuvre shortcuts

  readonly.get(
    '/api/manoeuvre-types',
    handle(({ db }, req) => manoeuvreTypes.listManoeuvreTypes(db, v.parsePagination(req.query)))
  );

  admin.post(
    '/api/manoeuvre-types',
    handle(({ db }, req, res) => {
      const body = v.requireBody(req.body, ['key', 'label', 'icon', 'sortOrder', 'enabled']);
      const type = manoeuvreTypes.createManoeuvreType(db, {
        key: v.parseString(body.key, 'key', { maxLength: 40 }),
        label: v.parseString(body.label, 'label', { maxLength: 100 }),
        icon: optional(body, 'icon', nullableString(100)),
        sortOrder: optional(body, 'sortOrder', parseInteger),
        enabled: optional(body, 'enabled', parseBoolean)
      });
      res.status(201);
      return type;
    })
  );

  admin.patch(
    '/api/manoeuvre-types/:key',
    handle(({ db }, req) => {
      const body = v.requireBody(req.body, ['label', 'icon', 'sortOrder', 'enabled']);
      return manoeuvreTypes.updateManoeuvreType(db, req.params.key, {
        label: optional(body, 'label', requiredString(100)),
        icon: optional(body, 'icon', nullableString(100)),
        sortOrder: optional(body, 'sortOrder', parseInteger),
        enabled: optional(body, 'enabled', parseBoolean)
      });
    })
  );

  admin.delete(
    '/api/manoeuvre-types/:key',
    handle(({ db }, req) => {
      manoeuvreTypes.deleteManoeuvreType(db, req.params.key);
    })
  );

  // Crew

  readonly.get(
    '/api/crew',
    handle(({ db }, req) => crew.listCrewMembers(db, v.parsePagination(req.query)))
  );

  readwrite.post(
    '/api/crew',
    handle(({ db, now }, req, res) => {
      const body = v.requireBody(req.body, ['name', 'role']);
      const member = crew.createCrewMember(
        db,
        {
          name: v.parseString(body.name, 'name', { maxLength: 100 }),
          role: optional(body, 'role', nullableString(100)) ?? null
        },
        now()
      );
      res.status(201);
      return member;
    })
  );

  readwrite.patch(
    '/api/crew/:id',
    handle(({ db, now }, req) => {
      const id = v.parseId(req.params.id);
      const body = v.requireBody(req.body, ['name', 'role']);
      return crew.updateCrewMember(
        db,
        id,
        {
          name: optional(body, 'name', requiredString(100)),
          role: optional(body, 'role', nullableString(100))
        },
        now()
      );
    })
  );

  readwrite.delete(
    '/api/crew/:id',
    handle(({ db }, req) => {
      crew.deleteCrewMember(db, v.parseId(req.params.id));
    })
  );

  readwrite.put(
    '/api/entries/:id/crew',
    handle(({ db, now }, req) => {
      const id = entryId(req);
      entries.requireEntryRow(db, id);
      const body = v.requireBody(req.body, ['members']);
      if (!Array.isArray(body.members)) {
        throw badRequest('members must be an array');
      }
      const members = body.members.map((item, index) => {
        if (!v.isPlainObject(item)) {
          throw badRequest(`members[${index}] must be an object`);
        }
        if ('crewMemberId' in item) {
          const member = v.requireBody(item, ['crewMemberId']);
          return {
            crewMemberId: v.parseId(member.crewMemberId, `members[${index}].crewMemberId`)
          };
        }
        const member = v.requireBody(item, ['name', 'role']);
        return {
          name: v.parseString(member.name, `members[${index}].name`, { maxLength: 100 }),
          role: optional(member, 'role', nullableString(100))
        };
      });
      return crew.setEntryCrew(db, id, members, now());
    })
  );

  // Export

  readonly.get(
    '/api/export',
    handle(async ({ db, now, pdfOptions }, req, res) => {
      const format = v.parseEnum(req.query.format ?? 'json', 'format', [
        'json',
        'csv',
        'gpx',
        'pdf'
      ]);
      const pdf = pdfOptions();
      if (req.query.lang !== undefined) {
        pdf.language = v.parseEnum(req.query.lang, 'lang', PDF_LANGUAGES);
      }
      if (req.query.tz !== undefined) {
        if (!isTimeZone(req.query.tz)) {
          throw badRequest('tz must be an IANA time zone, such as Europe/Paris');
        }
        pdf.timeZone = req.query.tz;
      }
      const { contentType, filename, body } = await renderExport(
        db,
        format,
        parseRange(req.query),
        now(),
        pdf
      );
      res.attachment(filename).type(contentType).send(body);
      return null;
    })
  );

  readonly.get(
    '/api/export/usb',
    handle(({ config, usbExport }) => ({ directory: config.usbExportPath, ...usbExport.status() }))
  );

  // Goes through the scheduler, so it never overlaps an automatic copy.
  admin.post(
    '/api/export/usb',
    handle(({ config, usbExport }) => {
      if (!config.usbExportPath) {
        throw conflict(
          'usb_export_not_configured',
          'Set the USB export directory in the plugin configuration first'
        );
      }
      return usbExport.run('manual');
    })
  );

  readonly.get(
    '/api/summary-mail',
    handle(({ summaryMailer }) => summaryMailer.status())
  );

  // Sends one passage's summary now, whether or not it already went out: how
  // the SMTP settings are tried without waiting for the next arrival.
  admin.post(
    '/api/entries/:id/summary-mail',
    handle(async ({ db, summaryMailer }, req) => {
      const id = entryId(req);
      entries.requireEntryRow(db, id);
      try {
        return await summaryMailer.send(id);
      } catch (err) {
        throw conflict('summary_mail_failed', err.message);
      }
    })
  );

  readonly.get(
    '/api/cloud-sync',
    handle(({ cloudSync, cloudPairing, cloudRestore }) => ({
      ...cloudSync.status(),
      pairing: cloudPairing.status(),
      restore: cloudRestore.status()
    }))
  );

  // The earlier logbooks of this boat the service can give back, asked of the service now.
  readonly.get(
    '/api/cloud-sync/restore',
    handle(async ({ cloudRestore }) => {
      try {
        return { ...cloudRestore.status(), logbooks: await cloudRestore.candidates() };
      } catch (err) {
        throw conflict('cloud_restore_failed', err.message);
      }
    })
  );

  // Starts bringing one of them back into this logbook, which must be empty; the restore
  // goes on in the background and GET /cloud-sync follows it.
  admin.post(
    '/api/cloud-sync/restore',
    handle(({ cloudRestore }, req) => {
      const logbookId = req.body?.logbookId;
      if (typeof logbookId !== 'string' || !/^[0-9a-f-]{36}$/i.test(logbookId)) {
        throw badRequest('logbookId is required');
      }
      try {
        cloudRestore.start(logbookId.toLowerCase());
      } catch (err) {
        throw conflict(err.code ?? 'cloud_restore_failed', err.message);
      }
      return cloudRestore.status();
    })
  );

  // Asks the service for a pairing code, then waits in the background for someone to claim
  // it; GET /cloud-sync follows the pairing.
  admin.post(
    '/api/cloud-sync/pairing',
    handle(async ({ cloudPairing }, req) => {
      if (typeof req.body?.url !== 'string' || req.body.url.trim() === '') {
        throw badRequest('url is required');
      }
      try {
        return await cloudPairing.start(req.body.url.trim());
      } catch (err) {
        if (err.code === 'invalid_url') {
          throw badRequest(err.message);
        }
        throw conflict('cloud_pairing_failed', err.message);
      }
    })
  );

  admin.delete(
    '/api/cloud-sync/pairing',
    handle(({ cloudPairing }) => {
      cloudPairing.cancel();
      return cloudPairing.status();
    })
  );

  // Starts a backup run now rather than at the next interval; the run itself
  // goes on in the background, through its schedule, never alongside another.
  admin.post(
    '/api/cloud-sync',
    handle(({ cloudSync, nudgeCloudSync }) => {
      const status = cloudSync.status();
      if (!status.enabled || !status.configured) {
        throw conflict(
          'cloud_sync_not_configured',
          `Turn the online backup on and fill in its settings first${status.problem ? `: ${status.problem}` : ''}`
        );
      }
      // Asked for by hand, the run sends everything in full, costly link or not.
      cloudSync.requestFull();
      nudgeCloudSync();
      return status;
    })
  );

  // Declares the link costly, or cheap again (SPEC §4.17).
  admin.post(
    '/api/cloud-sync/costly-link',
    handle(async ({ cloudSync, saveCostlyLink }, req) => {
      if (typeof req.body?.costly !== 'boolean') {
        throw badRequest('costly must be true or false');
      }
      try {
        await saveCostlyLink(req.body.costly);
      } catch (err) {
        throw conflict('cloud_sync_save_failed', err.message);
      }
      return cloudSync.status();
    })
  );

  readonly.get(
    '/api/replay',
    handle(({ replayJob }) => replayJob.status())
  );

  admin.post(
    '/api/replay',
    handle(({ replayJob }, req) => {
      const from = v.parseTimestamp(req.body.from, 'from');
      const to = v.parseTimestamp(req.body.to, 'to');
      if (to <= from) {
        throw badRequest('to must be after from');
      }
      return replayJob.start(from, to);
    })
  );

  admin.post(
    '/api/replay/cancel',
    handle(({ replayJob }) => {
      if (!replayJob.cancel()) {
        throw conflict('replay_not_running', 'No retrospective replay is running');
      }
    })
  );
}

module.exports = { registerRoutes };

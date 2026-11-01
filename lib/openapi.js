// The OpenAPI document of the versioned API (/api/v1), which docs/API.md describes in prose.
// Signal K serves it with the server's other API documents (plugin.getOpenApi), and so does
// GET /api/v1/openapi.json; companion apps generate their client from it.
//
// Response schemas leave additional properties open -- a field added in v1 must not break a
// client generated earlier -- while request bodies close them, since the server refuses
// unknown fields. test/openapi.test.js checks that every v1 route is described here, and only
// those, with its access level.

const { version } = require('../package.json');

const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const nullableRef = (name) => ({ allOf: [ref(name)], nullable: true });
const nullable = (schema) => ({ ...schema, nullable: true });
const string = (description, extra = {}) => ({ type: 'string', description, ...extra });
const timestamp = (description) => string(description, { format: 'date-time' });
const number = (description) => ({ type: 'number', description });
const integer = (description) => ({ type: 'integer', description });
const boolean = (description) => ({ type: 'boolean', description });
const arrayOf = (items, description) => ({
  type: 'array',
  items,
  ...(description ? { description } : {})
});

const object = (properties, { required = [], description, closed = false } = {}) => ({
  type: 'object',
  ...(description ? { description } : {}),
  ...(required.length > 0 ? { required } : {}),
  properties,
  ...(closed ? { additionalProperties: false } : {})
});

// A loosely described object: its shape is in docs/API.md.
const loose = (description) => ({ type: 'object', description, additionalProperties: true });

const list = (name) =>
  object(
    {
      total: integer('Items matching, across every page'),
      limit: integer('Page size'),
      offset: integer('Items skipped'),
      items: arrayOf(ref(name))
    },
    { required: ['total', 'limit', 'offset', 'items'] }
  );

const tank = object(
  {
    type: string('Signal K tank type: fuel, freshWater, ...'),
    id: string('Signal K tank id'),
    name: string('Name the boat gives it'),
    level: number('Ratio, 0 to 1'),
    volume: number('m³'),
    capacity: number('m³')
  },
  { required: ['type', 'id'] }
);

const battery = object(
  {
    id: string('Signal K battery id'),
    name: string('Name the boat gives it'),
    voltage: number('V'),
    current: number('A, negative discharging'),
    stateOfCharge: number('Ratio, 0 to 1'),
    temperature: number('K')
  },
  { required: ['id'] }
);

const entryProperties = {
  id: integer('Entry id'),
  state: string('active while under way', { enum: ['active', 'closed'] }),
  startTime: timestamp('Departure'),
  endTime: nullable(timestamp('Arrival, null while active')),
  stoppedSince: nullable(timestamp('Set while a passage opened by casting off waits to move')),
  startPosition: nullableRef('Position'),
  endPosition: nullableRef('Position'),
  startPlaceId: nullable(integer('Place of departure')),
  endPlaceId: nullable(integer('Place of arrival')),
  startPlaceName: nullable(string('As recorded at the time')),
  endPlaceName: nullable(string('As recorded at the time')),
  startPlacePending: boolean('Name generated from coordinates, awaiting geocoding'),
  endPlacePending: boolean('Name generated from coordinates, awaiting geocoding'),
  distance: number('m'),
  engineDuration: integer('s'),
  sailDuration: integer('s'),
  openedByEventId: nullable(integer('The departure manoeuvre that opened it')),
  startTanks: nullable(arrayOf(ref('Tank'), 'Tanks as the passage opened')),
  startBatteries: nullable(arrayOf(ref('Battery'), 'Batteries as the passage opened')),
  endTanks: nullable(arrayOf(ref('Tank'), 'Tanks as the passage ended (feature endTanks)')),
  createdAt: timestamp('Created'),
  updatedAt: timestamp('Last changed')
};

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

const PLAN_STATUSES = ['draft', 'ready', 'active', 'done', 'cancelled'];
const DEFECT_SEVERITIES = ['minor', 'major', 'critical'];
const DEFECT_STATUSES = ['open', 'fixed'];
const ROUTE_REF = '^/resources/routes/[^/\\s]{1,200}$';
const WAYPOINT_REF = '^/resources/waypoints/[^/\\s]{1,200}$';

const memberChoice = (extra = {}, extraRequired = []) => ({
  oneOf: [
    object(
      {
        ...extra,
        crewMemberId: integer('Roster member'),
        role: nullable(string('Role on this plan; the roster role by default', { maxLength: 100 }))
      },
      { required: [...extraRequired, 'crewMemberId'], closed: true }
    ),
    object(
      {
        ...extra,
        name: string('Name, for this plan alone', { maxLength: 100 }),
        role: nullable(string('Role', { maxLength: 100 }))
      },
      { required: [...extraRequired, 'name'], closed: true }
    )
  ]
});

const watchTimes = {
  start: timestamp('Watch begins'),
  end: timestamp('Watch ends, after start')
};

const planMemberProperties = {
  crewMemberId: nullable(integer('Roster member, null for a name typed for this plan')),
  name: string('As it stood when planned'),
  role: nullable(string('As it stood when planned'))
};

const planEditable = {
  title: string('Title', { maxLength: 200 }),
  status: string('Status', { enum: PLAN_STATUSES }),
  departureTime: nullable(timestamp('Planned departure')),
  departurePlaceName: nullable(string('Planned departure place', { maxLength: 200 })),
  departurePosition: nullableRef('Position'),
  arrivalTime: nullable(timestamp('Planned arrival, not before the departure')),
  arrivalPlaceName: nullable(string('Planned arrival place', { maxLength: 200 })),
  arrivalPosition: nullableRef('Position'),
  routeRef: nullable(string('Signal K route', { pattern: ROUTE_REF })),
  fallbackRefs: arrayOf(string('Signal K waypoint', { pattern: WAYPOINT_REF }), 'Fallback points'),
  criteria: nullable(loose('The no-go criteria applied, as the app copied them in')),
  entryId: nullable(integer('The passage sailing it; linking boards the planned crew'))
};

const planWritable = {
  ...planEditable,
  crew: arrayOf(ref('PlanMemberInput'), 'Planned crew, at most 100'),
  watches: arrayOf(ref('PlanWatchInput'), 'Watches, at most 100')
};

const defectEditable = {
  title: string('Title', { maxLength: 200 }),
  description: nullable(string('Description', { maxLength: 10000 })),
  severity: string('Severity, minor by default', { enum: DEFECT_SEVERITIES }),
  status: string('Status, open by default', { enum: DEFECT_STATUSES }),
  time: timestamp('Noticed, now by default'),
  fixedAt: nullable(timestamp('Fixed; now by default when the status becomes fixed')),
  entryId: nullable(integer("Passage; by default that of eventId's journal line")),
  planId: nullable(integer('Plan')),
  eventId: nullable(integer('Journal line that reported it'))
};

const clientRefInput = string('Idempotency key', { minLength: 1, maxLength: 100 });
const clientRefOutput = nullable(string('Idempotency key chosen by the client'));

const SCHEMAS = {
  Position: object(
    {
      lat: number('Decimal degrees, -90 to 90'),
      lon: number('Decimal degrees, -180 to 180')
    },
    { required: ['lat', 'lon'] }
  ),
  Error: object(
    {
      error: object(
        { code: string('Machine-readable code'), message: string('For a person') },
        { required: ['code', 'message'] }
      )
    },
    { required: ['error'] }
  ),
  State: object(
    {
      activeEntryId: nullable(integer('The passage in progress')),
      detection: string('What drives detection', { enum: ['autostate', 'fallback'] }),
      motion: string('As last detected', { enum: ['underway', 'stopped', 'unknown'] }),
      propulsion: nullable(string('Under way only', { enum: ['engine', 'sail'] })),
      stateIssue: nullable(loose('Why navigation.state is not followed')),
      schemaVersion: integer('Database migration level, not an API version'),
      logbookId: string('This logbook, for a client to tell logbooks apart', { format: 'uuid' }),
      apiVersions: arrayOf(integer('API version'), 'Versions served, as /api/v<n>'),
      pluginVersion: string('signalk-chiplog version'),
      features: arrayOf(
        string('Feature', { enum: ['plans', 'defects', 'changes', 'endTanks'] }),
        'Features beyond the first v1; send a field of one only when it is listed'
      )
    },
    { required: ['activeEntryId', 'schemaVersion', 'apiVersions', 'features'] }
  ),
  Tank: tank,
  TankInput: { ...tank, additionalProperties: false },
  Battery: battery,
  Entry: object(entryProperties, { required: ['id', 'state', 'startTime'] }),
  EntryDetail: {
    allOf: [
      ref('Entry'),
      object({
        previousEntryId: nullable(integer('Passage before in the log')),
        nextEntryId: nullable(integer('Passage after in the log')),
        counts: object({
          trackPoints: integer('Track points'),
          observations: integer('Instrument snapshots'),
          events: integer('Events')
        }),
        maxSpeed: nullable(number('m/s over ground')),
        maxWindSpeed: nullable(number('m/s, true wind unless maxWindApparent')),
        maxWindApparent: boolean('maxWindSpeed is apparent wind'),
        crew: arrayOf(ref('EntryCrewMember'), 'Who was aboard')
      })
    ]
  },
  EntryPatch: object(
    {
      startTime: timestamp('Departure'),
      endTime: timestamp('Arrival; closed entries only'),
      startPosition: nullableRef('Position'),
      endPosition: nullableRef('Position'),
      startPlaceName: nullable(string('Remembered for the place', { maxLength: 200 })),
      endPlaceName: nullable(string('Remembered for the place', { maxLength: 200 })),
      distance: number('m'),
      startTanks: nullable(arrayOf(ref('TankInput'), 'Tanks noted by hand (feature endTanks)')),
      endTanks: nullable(
        arrayOf(ref('TankInput'), 'Tanks noted by hand, closed entries only (feature endTanks)')
      )
    },
    { closed: true }
  ),
  EntryImport: loose('A finished passage recorded elsewhere; see docs/API.md, POST /entries'),
  EntryStats: object({
    count: integer('Passages'),
    distance: number('m'),
    duration: integer('s')
  }),
  Statistics: loose('The statistics page; see docs/API.md'),
  EntryCrewMember: object(
    {
      id: integer('Assignment id'),
      crewMemberId: nullable(integer('Roster member, null once deleted from the roster')),
      name: string('As recorded at the time'),
      role: nullable(string('As recorded at the time'))
    },
    { required: ['id', 'name'] }
  ),
  Observation: object(
    {
      id: integer('Observation id'),
      time: timestamp('Taken'),
      reason: string('Why', { enum: ['periodic', 'entry_start', 'entry_end', 'event'] }),
      position: nullableRef('Position'),
      ...Object.fromEntries(
        [
          ['sog', 'm/s'],
          ['cog', 'rad'],
          ['heading', 'rad'],
          ['stw', 'm/s'],
          ['twd', 'rad'],
          ['tws', 'm/s'],
          ['awa', 'rad'],
          ['aws', 'm/s'],
          ['depth', 'm'],
          ['pressure', 'Pa'],
          ['airTemp', 'K'],
          ['waterTemp', 'K'],
          ['tripLog', 'm'],
          ['engineRuntime', 's']
        ].map(([field, unit]) => [field, nullable(number(unit))])
      ),
      engineRuntimes: nullable(loose('Engine hours by Signal K engine id, s'))
    },
    { required: ['id', 'time', 'reason'] }
  ),
  PropulsionSegment: object(
    {
      id: integer('Segment id'),
      entryId: integer('Passage'),
      type: string('Propulsion', { enum: ['engine', 'sail'] }),
      startTime: timestamp('Start'),
      endTime: nullable(timestamp('End, null while running')),
      source: string('Detected or corrected', { enum: ['auto', 'manual'] }),
      averageRpm: nullable(number('Hz'))
    },
    { required: ['id', 'entryId', 'type', 'startTime'] }
  ),
  Landmark: loose('A landmark (amer); see docs/API.md'),
  Forecast: loose('A forecast fetched near the departure; see docs/API.md'),
  TrackGeoJson: loose('A GeoJSON Feature with a LineString'),
  Event: object(
    {
      id: integer('Event id'),
      entryId: integer('Passage'),
      time: timestamp('When it happened'),
      type: string('Event type', { enum: EVENT_TYPES }),
      subtype: nullable(string('Qualifies the type; companion.* for a companion app record')),
      position: nullableRef('Position'),
      comment: nullable(string('Readable text')),
      payload: nullable(loose('Structured detail: strokes, a companion app record, ...')),
      source: string('Who logged it', { enum: ['auto', 'manual'] }),
      clientRef: clientRefOutput,
      createdAt: timestamp('Recorded')
    },
    { required: ['id', 'entryId', 'time', 'type', 'source'] }
  ),
  EventCreated: {
    allOf: [ref('Event'), object({ openedEntry: boolean('This event opened the passage') })]
  },
  EventInput: object(
    {
      type: string('What a client may create', {
        enum: ['manoeuvre', 'text_annotation', 'handwritten_annotation']
      }),
      subtype: nullable(string('Manoeuvre key; free for an annotation', { maxLength: 200 })),
      comment: nullable(string('Required for a text_annotation', { maxLength: 10000 })),
      payload: nullable(loose('payload.strokes for a handwritten_annotation')),
      time: timestamp('Defaults to now; a past time is an entry replayed from a queue'),
      position: nullableRef('Position'),
      clientRef: clientRefInput
    },
    { required: ['type'], closed: true }
  ),
  EventPatch: object(
    {
      time: timestamp('Redates the event'),
      comment: nullable(string('Comment', { maxLength: 10000 })),
      subtype: nullable(string('Subtype', { maxLength: 200 })),
      payload: nullable(loose('Payload'))
    },
    { closed: true }
  ),
  Place: object(
    {
      id: integer('Place id'),
      name: string('Name'),
      position: ref('Position'),
      source: string('Where the name came from', { enum: ['geocoding', 'manual'] }),
      countryCode: nullable(string('ISO 3166-1 alpha-2')),
      createdAt: timestamp('Created'),
      updatedAt: timestamp('Last changed')
    },
    { required: ['id', 'name', 'position', 'source'] }
  ),
  ManoeuvreType: object(
    {
      key: string('Key, the subtype of a manoeuvre event'),
      label: string('Label'),
      icon: nullable(string('Icon')),
      sortOrder: integer('Order'),
      builtin: boolean('Shipped with the plugin'),
      enabled: boolean('Shown as a shortcut')
    },
    { required: ['key', 'label'] }
  ),
  CrewMember: object(
    {
      id: integer('Roster member id'),
      name: string('Name'),
      role: nullable(string('Role')),
      createdAt: timestamp('Created'),
      updatedAt: timestamp('Last changed')
    },
    { required: ['id', 'name'] }
  ),
  PlanMember: object(planMemberProperties, { required: ['name'] }),
  PlanWatch: object(
    { ...watchTimes, ...planMemberProperties },
    {
      required: ['start', 'end', 'name']
    }
  ),
  PlanMemberInput: memberChoice(),
  PlanWatchInput: memberChoice(watchTimes, ['start', 'end']),
  Plan: object(
    {
      id: integer('Plan id'),
      clientRef: clientRefOutput,
      ...planEditable,
      crew: arrayOf(ref('PlanMember'), 'Planned crew'),
      watches: arrayOf(ref('PlanWatch'), 'Watches, one row per member and period'),
      createdAt: timestamp('Created'),
      updatedAt: timestamp('Last changed')
    },
    { required: ['id', 'title', 'status', 'fallbackRefs', 'crew', 'watches'] }
  ),
  PlanInput: object(
    { clientRef: clientRefInput, ...planWritable },
    {
      required: ['title'],
      closed: true
    }
  ),
  PlanPatch: object(planWritable, { closed: true }),
  Defect: object(
    {
      id: integer('Defect id'),
      clientRef: clientRefOutput,
      ...defectEditable,
      createdAt: timestamp('Created'),
      updatedAt: timestamp('Last changed')
    },
    { required: ['id', 'title', 'severity', 'status', 'time'] }
  ),
  DefectInput: object(
    { clientRef: clientRefInput, ...defectEditable },
    {
      required: ['title'],
      closed: true
    }
  ),
  DefectPatch: object(defectEditable, { closed: true }),
  Change: object(
    {
      seq: integer('Position in the feed'),
      resource: string('What changed', {
        enum: ['entry', 'event', 'crewMember', 'entryCrew', 'plan', 'defect']
      }),
      id: integer('Its id; the entry id for entryCrew'),
      changedAt: timestamp('Last changed'),
      deleted: boolean('Gone: item is null'),
      item: nullable(
        loose('As it stands: Entry, Event, CrewMember, { entryId, crew }, Plan or Defect')
      )
    },
    { required: ['seq', 'resource', 'id', 'deleted', 'item'] }
  ),
  Changes: object(
    {
      logbookId: string('The logbook these changes are of', { format: 'uuid' }),
      cursor: integer('What to ask from next, as since'),
      more: boolean('Another page follows at once'),
      items: arrayOf(ref('Change'))
    },
    { required: ['logbookId', 'cursor', 'more', 'items'] }
  ),
  MergeInput: object(
    { withEntryId: integer('The other passage') },
    {
      required: ['withEntryId'],
      closed: true
    }
  ),
  PropulsionPatch: object(
    { type: string('Propulsion', { enum: ['engine', 'sail'] }) },
    {
      required: ['type'],
      closed: true
    }
  ),
  NameInput: object(
    { name: string('Name', { maxLength: 200 }) },
    {
      required: ['name'],
      closed: true
    }
  ),
  ManoeuvreTypeInput: object(
    {
      key: string('Key', { maxLength: 40 }),
      label: string('Label', { maxLength: 100 }),
      icon: nullable(string('Icon', { maxLength: 100 })),
      sortOrder: integer('Order'),
      enabled: boolean('Shown')
    },
    { required: ['key', 'label'], closed: true }
  ),
  ManoeuvreTypePatch: object(
    {
      label: string('Label', { maxLength: 100 }),
      icon: nullable(string('Icon', { maxLength: 100 })),
      sortOrder: integer('Order'),
      enabled: boolean('Shown')
    },
    { closed: true }
  ),
  CrewMemberInput: object(
    {
      name: string('Name', { maxLength: 100 }),
      role: nullable(string('Role', { maxLength: 100 }))
    },
    { required: ['name'], closed: true }
  ),
  CrewMemberPatch: object(
    {
      name: string('Name', { maxLength: 100 }),
      role: nullable(string('Role', { maxLength: 100 }))
    },
    { closed: true }
  ),
  EntryCrewInput: object(
    {
      members: arrayOf({
        oneOf: [
          object(
            { crewMemberId: integer('Roster member') },
            {
              required: ['crewMemberId'],
              closed: true
            }
          ),
          object(
            {
              name: string('Name', { maxLength: 100 }),
              role: nullable(string('Role', { maxLength: 100 }))
            },
            { required: ['name'], closed: true }
          )
        ]
      })
    },
    { required: ['members'], closed: true }
  ),
  EntryList: list('Entry'),
  EventList: list('Event'),
  ObservationList: list('Observation'),
  PropulsionSegmentList: list('PropulsionSegment'),
  LandmarkList: list('Landmark'),
  PlaceList: list('Place'),
  ManoeuvreTypeList: list('ManoeuvreType'),
  CrewMemberList: list('CrewMember'),
  PlanList: list('Plan'),
  DefectList: list('Defect')
};

const pathParam = (name = 'id') => ({
  name,
  in: 'path',
  required: true,
  schema: name === 'key' ? { type: 'string' } : { type: 'integer', minimum: 1 }
});
const query = (name, schema, description) => ({ name, in: 'query', schema, description });
const PAGINATION = [
  query('limit', { type: 'integer', minimum: 1, maximum: 500, default: 50 }, 'Page size'),
  query('offset', { type: 'integer', minimum: 0, default: 0 }, 'Items to skip')
];
const RANGE = [
  query('from', { type: 'string', format: 'date-time' }, 'Starting from, inclusive'),
  query('to', { type: 'string', format: 'date-time' }, 'Starting before, exclusive')
];
const ID = [pathParam()];

const json = (schema) => ({ 'application/json': { schema } });
const ok = (schema, description = 'OK') => ({ description, content: json(schema) });
const ERROR = { description: 'Error', content: json(ref('Error')) };
const created = (name) => ({
  200: ok(ref(name), 'Already there, by its clientRef: unchanged'),
  201: ok(ref(name), 'Created')
});
const NO_CONTENT = { 204: { description: 'Done' } };

// Every v1 operation: [level, operationId, summary, tag, { params, body, responses }], keyed
// by "METHOD /path" with the path in Express form, relative to /api/v1. `level` is the Signal
// K access level the route requires.
const OPERATIONS = {
  'GET /state': [
    'readonly',
    'getState',
    'Plugin state, API versions and features',
    'state',
    {
      responses: { 200: ok(ref('State')) }
    }
  ],
  'GET /openapi.json': [
    'readonly',
    'getOpenApi',
    'This document',
    'state',
    {
      responses: { 200: ok({ type: 'object' }) }
    }
  ],
  'GET /changes': [
    'readonly',
    'listChanges',
    'What changed after a cursor (feature changes)',
    'changes',
    {
      params: [
        query('since', { type: 'integer', minimum: 0, default: 0 }, 'cursor of the last page'),
        query('limit', { type: 'integer', minimum: 1, maximum: 500, default: 200 }, 'Page size')
      ],
      responses: { 200: ok(ref('Changes')) }
    }
  ],
  'GET /entries': [
    'readonly',
    'listEntries',
    'Passages, newest first',
    'entries',
    {
      params: [...RANGE, ...PAGINATION],
      responses: { 200: ok(ref('EntryList')) }
    }
  ],
  'GET /entries/stats': [
    'readonly',
    'getEntryStats',
    'Totals over a range',
    'entries',
    {
      params: RANGE,
      responses: { 200: ok(ref('EntryStats')) }
    }
  ],
  'GET /statistics': [
    'readonly',
    'getStatistics',
    'The statistics page',
    'entries',
    {
      params: RANGE,
      responses: { 200: ok(ref('Statistics')) }
    }
  ],
  'GET /entries/:id': [
    'readonly',
    'getEntry',
    'One passage, with its figures',
    'entries',
    {
      params: ID,
      responses: { 200: ok(ref('EntryDetail')) }
    }
  ],
  'POST /entries': [
    'admin',
    'importEntry',
    'Import a finished passage',
    'entries',
    {
      body: 'EntryImport',
      responses: { 201: ok(ref('EntryDetail'), 'Imported') }
    }
  ],
  'PATCH /entries/:id': [
    'readwrite',
    'updateEntry',
    'Correct a passage',
    'entries',
    {
      params: ID,
      body: 'EntryPatch',
      responses: { 200: ok(ref('EntryDetail')) }
    }
  ],
  'POST /entries/:id/close': [
    'readwrite',
    'closeEntry',
    'Close the passage',
    'entries',
    {
      params: ID,
      responses: { 200: ok(ref('EntryDetail')) }
    }
  ],
  'POST /entries/:id/merge': [
    'readwrite',
    'mergeEntries',
    'Merge two passages',
    'entries',
    {
      params: ID,
      body: 'MergeInput',
      responses: { 200: ok(ref('EntryDetail')) }
    }
  ],
  'DELETE /entries/:id': [
    'admin',
    'deleteEntry',
    'Delete a passage',
    'entries',
    {
      params: ID,
      responses: NO_CONTENT
    }
  ],
  'GET /entries/:id/track': [
    'readonly',
    'getTrack',
    'The track',
    'entries',
    {
      params: [
        ...ID,
        query('format', { type: 'string', enum: ['geojson', 'gpx'], default: 'geojson' }, 'Format')
      ],
      responses: {
        200: {
          description: 'OK',
          content: {
            ...json(ref('TrackGeoJson')),
            'application/gpx+xml': { schema: { type: 'string' } }
          }
        }
      }
    }
  ],
  'GET /entries/:id/observations': [
    'readonly',
    'listObservations',
    'Instrument snapshots',
    'entries',
    {
      params: [...ID, ...PAGINATION],
      responses: { 200: ok(ref('ObservationList')) }
    }
  ],
  'DELETE /observations/:id': [
    'admin',
    'deleteObservation',
    'Delete a snapshot',
    'entries',
    {
      params: ID,
      responses: NO_CONTENT
    }
  ],
  'GET /entries/:id/propulsion': [
    'readonly',
    'listPropulsion',
    'Engine and sail',
    'entries',
    {
      params: [...ID, ...PAGINATION],
      responses: { 200: ok(ref('PropulsionSegmentList')) }
    }
  ],
  'PATCH /propulsion/:id': [
    'readwrite',
    'correctPropulsion',
    'Correct a segment',
    'entries',
    {
      params: ID,
      body: 'PropulsionPatch',
      responses: { 200: ok(ref('PropulsionSegment')) }
    }
  ],
  'GET /entries/:id/landmarks': [
    'readonly',
    'listLandmarks',
    'Landmarks nearby',
    'entries',
    {
      params: [...ID, ...PAGINATION],
      responses: { 200: ok(ref('LandmarkList')) }
    }
  ],
  'GET /entries/:id/tide': [
    'readonly',
    'getTide',
    'Tide forecast at departure',
    'entries',
    {
      params: ID,
      responses: { 200: ok(ref('Forecast')) }
    }
  ],
  'GET /entries/:id/weather': [
    'readonly',
    'getWeather',
    'Weather at departure',
    'entries',
    {
      params: ID,
      responses: { 200: ok(ref('Forecast')) }
    }
  ],
  'GET /entries/:id/events': [
    'readonly',
    'listEvents',
    'Events, oldest first',
    'events',
    {
      params: [
        ...ID,
        query('type', { type: 'string', enum: EVENT_TYPES }, 'Only this type'),
        ...PAGINATION
      ],
      responses: { 200: ok(ref('EventList')) }
    }
  ],
  'POST /entries/:id/events': [
    'readwrite',
    'createEntryEvent',
    'Log in a given passage',
    'events',
    {
      params: ID,
      body: 'EventInput',
      responses: created('Event')
    }
  ],
  'POST /events': [
    'readwrite',
    'logEvent',
    'Log, the server picking the passage',
    'events',
    {
      body: 'EventInput',
      responses: created('EventCreated')
    }
  ],
  'PATCH /events/:id': [
    'readwrite',
    'updateEvent',
    'Edit an event',
    'events',
    {
      params: ID,
      body: 'EventPatch',
      responses: { 200: ok(ref('Event')) }
    }
  ],
  'DELETE /events/:id': [
    'readwrite',
    'deleteEvent',
    'Delete an event',
    'events',
    {
      params: ID,
      responses: NO_CONTENT
    }
  ],
  'GET /places': [
    'readonly',
    'listPlaces',
    'The gazetteer',
    'places',
    {
      params: PAGINATION,
      responses: { 200: ok(ref('PlaceList')) }
    }
  ],
  'PATCH /places/:id': [
    'readwrite',
    'renamePlace',
    'Rename a place',
    'places',
    {
      params: ID,
      body: 'NameInput',
      responses: { 200: ok(ref('Place')) }
    }
  ],
  'DELETE /places/:id': [
    'admin',
    'deletePlace',
    'Delete a place',
    'places',
    {
      params: ID,
      responses: NO_CONTENT
    }
  ],
  'GET /manoeuvre-types': [
    'readonly',
    'listManoeuvreTypes',
    'Manoeuvre shortcuts',
    'manoeuvres',
    {
      params: PAGINATION,
      responses: { 200: ok(ref('ManoeuvreTypeList')) }
    }
  ],
  'POST /manoeuvre-types': [
    'admin',
    'createManoeuvreType',
    'Add a shortcut',
    'manoeuvres',
    {
      body: 'ManoeuvreTypeInput',
      responses: { 201: ok(ref('ManoeuvreType'), 'Created') }
    }
  ],
  'PATCH /manoeuvre-types/:key': [
    'admin',
    'updateManoeuvreType',
    'Edit a shortcut',
    'manoeuvres',
    {
      params: [pathParam('key')],
      body: 'ManoeuvreTypePatch',
      responses: { 200: ok(ref('ManoeuvreType')) }
    }
  ],
  'DELETE /manoeuvre-types/:key': [
    'admin',
    'deleteManoeuvreType',
    'Remove a shortcut',
    'manoeuvres',
    {
      params: [pathParam('key')],
      responses: NO_CONTENT
    }
  ],
  'GET /crew': [
    'readonly',
    'listCrew',
    'The crew roster',
    'crew',
    {
      params: PAGINATION,
      responses: { 200: ok(ref('CrewMemberList')) }
    }
  ],
  'POST /crew': [
    'readwrite',
    'createCrewMember',
    'Add to the roster',
    'crew',
    {
      body: 'CrewMemberInput',
      responses: { 201: ok(ref('CrewMember'), 'Created') }
    }
  ],
  'PATCH /crew/:id': [
    'readwrite',
    'updateCrewMember',
    'Edit a roster member',
    'crew',
    {
      params: ID,
      body: 'CrewMemberPatch',
      responses: { 200: ok(ref('CrewMember')) }
    }
  ],
  'DELETE /crew/:id': [
    'readwrite',
    'deleteCrewMember',
    'Remove from the roster',
    'crew',
    {
      params: ID,
      responses: NO_CONTENT
    }
  ],
  'PUT /entries/:id/crew': [
    'readwrite',
    'setEntryCrew',
    'Who is aboard a passage',
    'crew',
    {
      params: ID,
      body: 'EntryCrewInput',
      responses: { 200: ok(arrayOf(ref('EntryCrewMember'))) }
    }
  ],
  'GET /plans': [
    'readonly',
    'listPlans',
    'Planned passages (feature plans)',
    'plans',
    {
      params: [
        query('status', { type: 'string', enum: PLAN_STATUSES }, 'Only this status'),
        query('entryId', { type: 'integer', minimum: 1 }, 'The plan of this passage'),
        ...PAGINATION
      ],
      responses: { 200: ok(ref('PlanList')) }
    }
  ],
  'GET /plans/:id': [
    'readonly',
    'getPlan',
    'One plan',
    'plans',
    {
      params: ID,
      responses: { 200: ok(ref('Plan')) }
    }
  ],
  'POST /plans': [
    'readwrite',
    'createPlan',
    'Plan a passage',
    'plans',
    {
      body: 'PlanInput',
      responses: created('Plan')
    }
  ],
  'PATCH /plans/:id': [
    'readwrite',
    'updatePlan',
    'Edit a plan, or link it to its passage',
    'plans',
    {
      params: ID,
      body: 'PlanPatch',
      responses: { 200: ok(ref('Plan')) }
    }
  ],
  'DELETE /plans/:id': [
    'readwrite',
    'deletePlan',
    'Delete a plan',
    'plans',
    {
      params: ID,
      responses: NO_CONTENT
    }
  ],
  'GET /defects': [
    'readonly',
    'listDefects',
    'Defects, newest first (feature defects)',
    'defects',
    {
      params: [
        query('status', { type: 'string', enum: DEFECT_STATUSES }, 'Only this status'),
        query('entryId', { type: 'integer', minimum: 1 }, 'Only those of this passage'),
        query('planId', { type: 'integer', minimum: 1 }, 'Only those of this plan'),
        ...PAGINATION
      ],
      responses: { 200: ok(ref('DefectList')) }
    }
  ],
  'GET /defects/:id': [
    'readonly',
    'getDefect',
    'One defect',
    'defects',
    {
      params: ID,
      responses: { 200: ok(ref('Defect')) }
    }
  ],
  'POST /defects': [
    'readwrite',
    'createDefect',
    'Report a defect',
    'defects',
    {
      body: 'DefectInput',
      responses: created('Defect')
    }
  ],
  'PATCH /defects/:id': [
    'readwrite',
    'updateDefect',
    'Edit a defect, or mark it fixed',
    'defects',
    {
      params: ID,
      body: 'DefectPatch',
      responses: { 200: ok(ref('Defect')) }
    }
  ],
  'GET /export': [
    'readonly',
    'exportLogbook',
    'Export the logbook',
    'export',
    {
      params: [
        query(
          'format',
          { type: 'string', enum: ['json', 'csv', 'gpx', 'pdf'], default: 'json' },
          'Format'
        ),
        ...RANGE,
        query('lang', { type: 'string', enum: ['en', 'fr'] }, 'PDF language'),
        query('tz', { type: 'string' }, 'PDF time zone, IANA')
      ],
      responses: {
        200: {
          description: 'An attachment',
          content: {
            'application/json': { schema: { type: 'object' } },
            'text/csv': { schema: { type: 'string' } },
            'application/gpx+xml': { schema: { type: 'string' } },
            'application/pdf': { schema: { type: 'string', format: 'binary' } }
          }
        }
      }
    }
  ]
};

function toOperation([level, operationId, summary, tag, { params = [], body, responses }]) {
  return {
    operationId,
    summary,
    tags: [tag],
    'x-signalk-access': level,
    ...(params.length > 0 ? { parameters: params } : {}),
    ...(body ? { requestBody: { required: true, content: json(ref(body)) } } : {}),
    responses: { ...responses, default: ERROR }
  };
}

const openApiPath = (expressPath) => expressPath.replace(/:(\w+)/g, '{$1}');

function getOpenApi() {
  const paths = {};
  for (const [key, spec] of Object.entries(OPERATIONS)) {
    const [method, expressPath] = key.split(' ');
    const path = openApiPath(expressPath);
    paths[path] = { ...paths[path], [method.toLowerCase()]: toOperation(spec) };
  }
  return {
    openapi: '3.0.3',
    info: {
      title: 'Chiplog',
      version,
      description:
        'The logbook API of signalk-chiplog, version 1 (docs/API.md). Units are Signal K SI ' +
        'units, times ISO 8601 UTC, JSON camelCase. Unknown fields in a request body are ' +
        'refused with 400; read a field you do not know in a response as optional, and send ' +
        'a field of a feature only once GET /state lists it in features. x-signalk-access is ' +
        'the Signal K access level an operation requires.',
      license: { name: 'MIT' }
    },
    servers: [{ url: '/plugins/signalk-chiplog/api/v1' }],
    components: {
      schemas: SCHEMAS,
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        cookieAuth: { type: 'apiKey', in: 'cookie', name: 'JAUTHENTICATION' }
      }
    },
    security: [{}, { bearerAuth: [] }, { cookieAuth: [] }],
    paths
  };
}

module.exports = { getOpenApi, OPERATIONS, openApiPath };

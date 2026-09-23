# REST API

The plugin registers its routes through `registerWithRouter`, so everything below is mounted at:

```text
/plugins/signalk-chiplog/api
```

The `/api` prefix keeps the plugin's routes clear of `GET /plugins/signalk-chiplog` and
`GET`/`POST /plugins/signalk-chiplog/config`, which the Signal K server reserves. The tablet PWA is a static webapp at
`/signalk-chiplog/entry/` and uses this API.

Implemented in [`lib/api.js`](../lib/api.js); the behaviour described here is covered by the tests in
[`test/`](../test).

## Conventions

**Access levels.** Signal K gives routes registered directly on the router **admin** authentication;
`router.access('readonly')` and `router.access('readwrite')` open them further. The policy here:

| Level       | What it covers                                                                                                                               |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `readonly`  | Reading the logbook and exporting it                                                                                                         |
| `readwrite` | What the crew does underway: annotations, manoeuvres, closing an entry, correcting a name or a propulsion segment                            |
| admin       | Destructive or configuration-shaped operations: importing a passage, deleting entries and places, managing shortcuts, triggering a USB write |

Corrections are `readwrite` rather than admin on purpose — a crew member at the helm has to be able to fix a wrong place
name or a mis-detected engine segment without an admin login.

On a server too old to provide `router.access()`, every route falls back to admin-only: the plugin stays usable, at the
cost of requiring an admin login for reads.

**JSON is `camelCase`**, mapped from the `snake_case` columns of the [data model](DATA_MODEL.md). Positions are
`{ "lat": …, "lon": … }` in decimal degrees, or `null`.

**Units are Signal K SI units** — radians, m/s, metres, seconds. Conversion to degrees, knots and nautical miles belongs
to the client; the CSV export is the one exception (see [Export](#export)). Timestamps are ISO 8601 UTC; any parseable
timestamp is accepted in requests and normalised to millisecond precision.

**Collections** all share one envelope, `{ total, limit, offset, items }`, with `limit` from 1 to 500 (default 50) and
`offset` ≥ 0.

**Unknown fields** in a request body are rejected with `400` rather than ignored, so a client typo fails loudly.

**Errors** return the matching HTTP status with a body of:

```json
{ "error": { "code": "entry_already_closed", "message": "Entry 42 is already closed" } }
```

| Status | When                                                               | Codes                                                                                                                                                                                                                               |
| ------ | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `400`  | Malformed request                                                  | `invalid_request`, `unknown_manoeuvre_type`                                                                                                                                                                                         |
| `404`  | Unknown resource                                                   | `entry_not_found`, `event_not_found`, `place_not_found`, `propulsion_segment_not_found`, `manoeuvre_type_not_found`, `crew_member_not_found`, `tide_not_found`, `weather_not_found`                                                 |
| `409`  | The request conflicts with current state                           | `no_passage`, `entry_active`, `entry_already_closed`, `entry_overlaps`, `entries_not_consecutive`, `manoeuvre_type_exists`, `builtin_manoeuvre_type`, `usb_export_not_configured`, `usb_export_unavailable`, `constraint_violation` |
| `500`  | Unexpected failure — detail goes to the server log, not the client | `internal_error`                                                                                                                                                                                                                    |
| `503`  | The plugin is disabled or stopped                                  | `plugin_not_started`                                                                                                                                                                                                                |

The server registers plugin routes once and never removes them, so they keep answering while the plugin is disabled —
with `503` until it is started again.

## Plugin state

### `GET /state` — `readonly`

What the UI needs to render its header, in one call.

```json
{
  "activeEntryId": 42,
  "detection": "autostate",
  "motion": "underway",
  "propulsion": "engine",
  "stateIssue": null,
  "schemaVersion": 4
}
```

As of the last detection cycle, at most 15 seconds old:

- `detection` is `autostate` while a current, recognised `navigation.state` is driving detection — which is what
  `signalk-autostate` provides — and `fallback` when the speed fallback is (SPEC §4.2). The UI must show the
  degraded-mode indicator in the latter case (SPEC §2).
- `motion` is `underway`, `stopped`, or `unknown` when there is no current data to decide.
- `propulsion` is `engine` or `sail` while under way — from engine data, `navigation.state` or the configured default
  (SPEC §4.2) — and `null` otherwise.
- `activeEntryId` is `null` when no passage is open.
- `stateIssue` says why `navigation.state` is not followed, and is `null` in `autostate` mode: `{ "reason": "absent" }`
  when nothing publishes it; otherwise `{ reason, source, value, updatedAt }` with `reason` `pending` (a `null` value,
  as signalk-autostate publishes while starting), `stale` (not updated for 20 minutes) or `unrecognised` (a value such
  as `default`). `source` is the Signal K source reference, `null` when the server gives none. When signalk-autostate is
  among several sources of `navigation.state`, its value is the one used.

## Entries

### `GET /entries` — `readonly`

Query: `from` (inclusive) and `to` (exclusive), both filtering on `startTime`; `limit`, `offset`.

Newest first. Day grouping (SPEC §3.2) is done by the client, which is why a flat list is returned.

### `GET /entries/stats` — `readonly`

Query: `from`/`to`, filtering the same way as `GET /entries`.

```json
{ "count": 42, "distance": 1234567, "duration": 456789 }
```

Totals across every entry the range matches, not just a loaded page: the number of passages, the summed `distance`
(metres), and the summed elapsed time (seconds) — each entry's `endTime` minus `startTime`, `now` for one still open.
For a summary line above the day-grouped list.

### `GET /statistics` — `readonly`

Query: `from`/`to`, filtering on `startTime` like `GET /entries`. The figures of the statistics page (SPEC §4.14):

```json
{
  "count": 42,
  "distance": 1234567,
  "duration": 456789,
  "firstTime": "2026-03-14T07:30:00.000Z",
  "lastTime": "2026-09-13T15:47:30.000Z",
  "maxSpeed": 5.2,
  "maxWindSpeed": 14.5,
  "maxWindApparent": false,
  "longestNonStop": {
    "entryId": 12,
    "startTime": "2026-08-02T06:10:00.000Z",
    "endTime": "2026-08-02T18:40:00.000Z",
    "distance": 84500,
    "duration": 45000,
    "startPlaceName": "La Rochelle (Les Minimes)",
    "endPlaceName": "Gijón"
  },
  "countries": [{ "code": "FR", "firstTime": "2026-03-14T07:30:00.000Z" }],
  "top": { "duration": [], "distance": [], "averageSpeed": [], "maxSpeed": [], "maxWindSpeed": [] }
}
```

- `count`, `distance` (metres) and `duration` (seconds) are those of `GET /entries/stats`; a passage in progress counts
  up to now everywhere. `firstTime` is the earliest start and `lastTime` the latest end, or `null` when nothing matches.
- `maxSpeed` and `maxWindSpeed` are in m/s, `null` when no passage has a reading. The wind is true wind, or apparent
  where a passage had no true one; `maxWindApparent` says which it is for the strongest.
- `longestNonStop` is the greatest distance of a stretch between two stops — a passage cut at each of its `stopover`
  events, each stretch measured from its track — or of a whole passage that never stopped. `startTime` of a stretch that
  follows a stop is the first track point after it. Its place names are those of the passage, or the stopover's. `null`
  when there is no track distance at all.
- `countries` lists the upper-case ISO 3166-1 alpha-2 code of every place a departure or arrival in the range was at,
  each with the time of its first visit, in that order. A place whose country is not known is left out.
- `top` holds up to five passages for each ranking, the highest first. Each has the same shape:

  ```json
  {
    "id": 12,
    "startTime": "2026-08-02T06:10:00.000Z",
    "endTime": "2026-08-02T18:40:00.000Z",
    "startPlaceName": "La Rochelle (Les Minimes)",
    "endPlaceName": "Gijón",
    "startPlacePending": false,
    "endPlacePending": false,
    "distance": 84500,
    "duration": 45000,
    "averageSpeed": 1.9,
    "maxSpeed": 5.2,
    "maxWindSpeed": 14.5,
    "maxWindApparent": false
  }
  ```

  `averageSpeed` is `distance` over `duration`. A passage with no value for a ranking's figure is left out of it.

### `GET /entries/:id` — `readonly`

One entry, with the counts the detail view needs:

```json
{
  "id": 42,
  "state": "closed",
  "startTime": "2026-09-13T06:12:00.000Z",
  "endTime": "2026-09-13T15:47:30.000Z",
  "stoppedSince": null,
  "startPosition": { "lat": 46.1591, "lon": -1.1522 },
  "endPosition": { "lat": 46.5012, "lon": -1.7899 },
  "startPlaceId": 3,
  "endPlaceId": 7,
  "startPlaceName": "La Rochelle",
  "endPlaceName": "Les Sables-d'Olonne",
  "startPlacePending": false,
  "endPlacePending": false,
  "distance": 68500,
  "engineDuration": 4200,
  "sailDuration": 30330,
  "openedByEventId": null,
  "startTanks": [{ "type": "fuel", "id": "0", "level": 0.8, "volume": 0.096, "capacity": 0.12 }],
  "startBatteries": [{ "id": "house", "voltage": 12.8, "current": -3.2, "stateOfCharge": 0.86 }],
  "createdAt": "2026-09-13T06:12:00.000Z",
  "updatedAt": "2026-09-13T15:47:30.000Z",
  "previousEntryId": 41,
  "nextEntryId": null,
  "counts": { "trackPoints": 1187, "observations": 11, "events": 9 },
  "maxSpeed": 6.7,
  "maxWindSpeed": 12.9,
  "maxWindApparent": false,
  "crew": [{ "id": 5, "crewMemberId": 3, "name": "Alex Martin", "role": "skipper" }]
}
```

On an active entry, `endPosition` is the last position detection saw — not yet an arrival.

`previousEntryId` and `nextEntryId` are the passages just before and just after this one in the log's order (start time,
then id), `null` for the first and the last, so a page can step from one passage to the next.

`maxSpeed` is the highest speed over ground seen in the track, `null` with none. `maxWindSpeed` is the highest true wind
speed seen, from the track and the instrument snapshots (SPEC §4.5.1) combined, falling back to apparent wind — flagged
by `maxWindApparent` — only for a passage with no true-wind reading at all; `null` with neither.

`startTanks` — `[{ type, id, name?, level?, volume?, capacity? }]` — and `startBatteries` —
`[{ id, name?, voltage?, current?, stateOfCharge?, temperature? }]` — are the boat's state noted as the passage opened
(SPEC §4.5.1): ratios, m³, V, A (negative discharging), K, a field absent when not published. `null` when the boat
published none, for a passage opened after the fact (a queued tablet entry, a retrospective replay), or one opened
before migration 11.

`startPlacePending`/`endPlacePending` mean the name was generated from coordinates (`"46.1234N 1.5678W"`) and online
geocoding has not answered yet (SPEC §4.8); the name may still change on its own. A UI can show it as provisional.
Geocoded names from the public instance are OpenStreetMap data and need its attribution.

`crew` is who was recorded aboard, in the order they were added — see [Crew](#crew) for how it is set. `name`/`role` are
denormalised at assignment time like `startPlaceName`, so correcting or deleting a roster member never rewrites a past
passage's recorded crew.

### `POST /entries` — admin

Adds a finished passage recorded elsewhere, such as another logbook's export — SPEC §4.15. `scripts/import-postgsail.js`
uses it to bring in a PostgSail export. One passage per request, all or nothing: `201` with the entry as
[`GET /entries/:id`](#get-entriesid--readonly) gives it.

```json
{
  "startTime": "2026-08-16T12:16:50.731Z",
  "endTime": "2026-08-16T14:46:54.122Z",
  "startPosition": { "lat": 14.541493, "lon": -61.035652 },
  "endPosition": { "lat": 14.687516, "lon": -61.176903 },
  "startPlaceName": "Les Trois-Îlets",
  "endPlaceName": "Anse Four à Chaux",
  "distance": 23872,
  "startTanks": [{ "type": "fuel", "id": "0", "level": 0.95 }],
  "startBatteries": [{ "id": "house", "voltage": 13.3, "stateOfCharge": 0.6 }],
  "trackPoints": [{ "time": "2026-08-16T12:16:50.731Z", "lat": 14.541493, "lon": -61.035652, "sog": 2.1, "tws": 6 }],
  "observations": [
    {
      "time": "2026-08-16T12:16:50.731Z",
      "reason": "entry_start",
      "position": { "lat": 14.541493, "lon": -61.035652 },
      "airTemp": 300.7
    }
  ],
  "propulsion": [{ "type": "sail", "startTime": "2026-08-16T12:16:50.731Z", "endTime": "2026-08-16T14:46:54.122Z" }]
}
```

- `startTime` and `endTime` are required, `endTime` not before `startTime`. Everything else is optional: the positions
  and place names, `distance` in metres, and the three lists.
- `startTanks` are the tanks as noted at departure, shaped as in `startTanks` of `GET /entries/:id`: `type`, `id`, and a
  `level` (ratio) or a `volume` (m³), with optionally a `name` and a `capacity` (m³).
- `startBatteries` are the batteries as noted at departure, shaped as in `startBatteries` of `GET /entries/:id`: an `id`
  and, of `voltage` (V), `current` (A, negative discharging), `stateOfCharge` (ratio) and `temperature` (K), at least
  one, with optionally a `name`.
- `trackPoints` take `time`, `lat` and `lon` and, when known, `sog`, `cog`, `stw`, `heading`, `tws`, `twd`, `aws` and
  `awa` — the fields of [`GET /entries/:id/track`](#get-entriesidtrack--readonly) points, in Signal K units. `null`, or
  absent, for a reading not made.
- `observations` take `time`, `reason` (`periodic`, `entry_start`, `entry_end` or `event`), `position`, the readings
  above, and `depth`, `pressure`, `airTemp`, `waterTemp`, `tripLog`, `engineRuntime` — the fields of
  [`GET /entries/:id/observations`](#get-entriesidobservations--readonly).
- `propulsion` periods take `type` (`engine` or `sail`), `startTime` and `endTime`. The entry's `engineDuration` and
  `sailDuration` are worked out from them.
- Every time in the lists must fall between `startTime` and `endTime`.
- **Names.** A place name is kept as given. With a position, it is tied to the known place within the matching radius
  (`placeMatchRadius`), else to one of the same name within 500 m, else a new place is made of it (`source: "manual"`),
  so later passages from there are named alike. Without a name, a position is named as for a passage detected live: a
  known place, else its coordinates, pending geocoding.
- **Distance** defaults to the sum over `trackPoints`, as for a passage logged live.
- **Nothing is reopened.** The passage is closed by neither detection nor the crew (`closed_by` empty), so a departure
  soon after it starts another passage instead of continuing it.

`409 entry_overlaps` when the passage overlaps one on record, the one in progress included — a passage that ends where
another starts does not. That makes an import safe to repeat: what is already there is refused, whatever else is sent.

### `PATCH /entries/:id` — `readwrite`

Accepts `startTime`, `endTime`, `startPosition`, `endPosition`, `startPlaceName`, `endPlaceName`, `distance`.

- `endTime` can only be set on a closed entry — `409 entry_active` otherwise; use
  [close](#post-entriesidclose--readwrite). An end before the start is `400`.
- `endPosition` and `endPlaceName` are likewise refused with `409 entry_active` on an entry still in progress: there is
  no arrival yet, only the last position detection saw, which keeps moving.
- **Renaming a place here is remembered.** Per SPEC §4.8, setting `startPlaceName`/`endPlaceName` also updates the
  nearest known place within the configured matching radius, or creates one, marking it `source: "manual"`; the entry's
  `startPlaceId`/`endPlaceId` then points to it. The next passage starting or ending within the radius reuses the name
  without calling the geocoder. Any other entry that already reused that place, timestamped later than the corrected
  side, is renamed too; one timestamped earlier keeps the name it recorded.
- If the entry has no position on that side, the name is stored on the entry alone and no place is created.
- `null` clears a name or a position.
- Setting a name, or clearing it, ends any pending geocoding for that side: a lookup still on its way will not override
  it. Correcting the position of a side whose name is still pending regenerates that name from the new coordinates and
  looks it up again.

### `POST /entries/:id/close` — `readwrite`

Closes an open entry, with no request body — confirming an arrival, or ending a passage detection has not ended. If
detection has already seen the vessel stop (`stoppedSince`), that is the end time; otherwise it is now. The end position
is the one detection recorded, or failing that the vessel's current position. Unless the arrival already has a name, it
is named as detection would name it: after a known place, or from its coordinates pending geocoding.
`409 entry_already_closed` if it is already closed.

A closed entry is final: detection does not reopen it, whether the boat is still moving or leaves again soon after — the
next passage starts at the next real departure. An entry detection closed, by contrast, is reopened by a departure
within `stopClosureMinutes` of its end (SPEC §4.2), which also means `stoppedSince` is only ever set on an entry opened
by casting off that has not moved yet.

### `POST /entries/:id/merge` — `readwrite`

```json
{ "withEntryId": 43 }
```

Manual concatenation of two passages (SPEC §3.1), for when a stop outlasted the tolerance but was really the same
outing.

- **The earlier entry survives**, whichever of the two the request is addressed to, so the passage keeps its id and
  departure. It takes the later entry's end time, end position, end place and state.
- Track points, observations, propulsion segments and events move to it; distances are summed and engine/sail durations
  recomputed from the segments.
- **Crew is unioned onto the surviving entry**, skipping anyone already aboard it — carrying a passage's crew over to
  the next one (see [Crew](#crew)) means the two lists usually overlap.
- **The place the earlier entry had stopped at is kept as a `stopover` event** on the surviving entry, at that stop's
  position, since it would otherwise be overwritten with no trace by the later entry's own end. Not added when that stop
  had no position (and so no place) to begin with.
- The two entries must be consecutive — `409 entries_not_consecutive` — and the earlier one must be closed —
  `409 entry_active`.

Returns the surviving entry.

### `DELETE /entries/:id` — admin

Removes the entry and everything attached to it. `204`.

## Track, observations, propulsion

### `GET /entries/:id/track` — `readonly`

Query `format`: `geojson` (default) or `gpx`.

GeoJSON is a single `Feature`: a `LineString`, a `Point` for a one-point track, or a `null` geometry for an empty one.
`properties` carries the entry's times and place names plus `coordTimes`, the timestamp of each coordinate, and
`readings`, one `{ sog, cog, stw, tws, twd, awa, heading }` per coordinate in the same order (SI units, `null` where not
current when sampled) — the webapp's position scrubber reads these rather than fetching each point on its own; a point
recorded before migration 9 has `stw: null`. GPX 1.1 is served as `application/gpx+xml`.

### `GET /entries/:id/observations` — `readonly`

The instrument snapshots behind the facsimile PDF, oldest first. Paginated. `reason` is `entry_start`, `periodic`,
`entry_end` or `event` (SPEC §4.5.1); readings that were not current when the snapshot was taken are `null`.
`engineRuntimes` holds every engine's hour counter in seconds, keyed by Signal K engine id
(`{ "port": 2924700, "starboard": 2873220 }`), or `null` with no counter; `engineRuntime` is the main (or first)
engine's, as before. Snapshots recorded before migration 5 only have `engineRuntime`.

### `GET /entries/:id/propulsion` — `readonly`

The engine/sail segments, oldest first. Paginated. They cover only time under way, so a stop leaves a gap; the ongoing
segment has `endTime: null`.

### `PATCH /propulsion/:id` — `readwrite`

```json
{ "type": "sail" }
```

Corrects a mis-detected segment (SPEC §4.2). The segment is flagged `source: "manual"`, the entry's durations are
recomputed, and a `manual_correction` event is added to the timeline at the segment's start time, with the before and
after in its payload. Setting the type a segment already has changes nothing.

Detection logs its own automatic switches the same way: a `propulsion_change` event, same payload shape, at the
segment's start time, with an instrument snapshot taken for it like a manoeuvre's. Not for the ongoing segment's first
switch when a passage opens — only an actual change partway through.

Correcting the **ongoing** segment holds until the engine data changes: detection does not revert it on its next cycle
just because the sensors — or the configured default — still say otherwise.

### `GET /entries/:id/landmarks` — `readonly`

```json
{
  "total": 2,
  "limit": 50,
  "offset": 0,
  "items": [
    {
      "id": 2,
      "name": "Phare du Cap-Ferret",
      "kind": "lighthouse",
      "position": { "lat": 44.6459646, "lon": -1.2488154 },
      "lightRange": 40744,
      "osm": { "type": "way", "id": 715849418 },
      "updatedAt": "2026-09-13T08:02:11.000Z"
    }
  ]
}
```

The amers any line of this passage's journal could be read against (SPEC §4.13): those within the area it sailed
through, widened by the furthest an amer is quoted from. Paginated. `kind` is `lighthouse`, `light`, `cape`, `landmark`,
`beacon` or `harbour`; `lightRange` is the nominal range of its light in metres, or `null`.

Which landmark a given position takes, and the bearing and distance from it, are computed by the client —
`public/js/landmarks.mjs`, which the webapp and the PDF logbook share. The list is empty while the area's landmarks have
not been fetched, or with `landmarksEnabled` off: a client then shows the coordinates alone.

### `GET /entries/:id/tide` — `readonly`

```json
{
  "position": { "lat": 46.4383, "lon": -1.6769 },
  "fetchedAt": "2026-09-13T06:12:30.000Z",
  "datum": "msl",
  "points": [
    { "time": "2026-09-13T06:00:00.000Z", "height": 1.9 },
    { "time": "2026-09-13T07:00:00.000Z", "height": 2.7 }
  ]
}
```

The tide forecast fetched near this entry's departure (SPEC §4.5.2): hourly water height in metres, at the position
asked about, for the 24 h starting at departure. `404 tide_not_found` while none has been fetched yet, or none is
available for the position — the two are not distinguished, since there is nothing to show either way. High and low tide
are not a separate field: they are the local peaks and troughs of `points`, derived by the client.

`datum` is always `"msl"` today: heights are relative to mean sea level, the only reference Open-Meteo's
`sea_level_height_msl` offers — not the lowest-astronomical-tide chart datum nautical tide tables use. A client showing
`points` or the derived extremes should say so, as the webapp does, rather than imply a charted "hauteur d'eau".

### `GET /entries/:id/weather` — `readonly`

```json
{
  "position": { "lat": 46.1466, "lon": -1.1686 },
  "fetchedAt": "2026-09-13T08:00:12.000Z",
  "points": [
    {
      "time": "2026-09-13T09:00:00.000Z",
      "windSpeed": 6.2,
      "windDirection": 3.93,
      "windGust": 9.8,
      "pressure": 101600,
      "weatherCode": 80,
      "visibility": 24000,
      "precipitation": 0.0004,
      "cloudCover": 0.75,
      "airTemperature": 291.2,
      "waveHeight": 1.1,
      "waveDirection": 4.71,
      "wavePeriod": 6.5,
      "swellHeight": 0.8,
      "swellDirection": 4.89,
      "swellPeriod": 11,
      "seaTemperature": 289.6,
      "currentSpeed": 0.3,
      "currentDirection": 0.79
    }
  ]
}
```

The marine weather forecast fetched near this entry's departure (SPEC §4.5.3): hourly, in SI units, for the 24 h
starting at departure. Fields are described in the [data model](DATA_MODEL.md#weather_forecasts-migration-12); any of
them is `null` when the service did not give it — all the sea fields, far from the sea. Wind, wave and swell directions
are where they come from; the current's is where it flows to. `404 weather_not_found` while none has been fetched yet,
or none is available for the position.

## Events

### `GET /entries/:id/events` — `readonly`

Optional `type` filter. Oldest first. Paginated.

Besides what clients post, the timeline holds events the plugin logs itself — `sk_alarm`, `autopilot`,
`weather_threshold`, `manual_correction`, `propulsion_change`, `stopover` and `heading_change`, with `source: "auto"`;
their subtypes and payloads are listed in the [data model](DATA_MODEL.md#events). An alarm raised at anchor between
passages belongs to the passage that ended there, so its time can be later than that entry's `endTime`.

### `POST /events` — `readwrite`

The endpoint the tablet's manoeuvre shortcuts and annotations hit. The client does not need to know which passage is
open: the server attaches the entry to

1. the passage in progress;
2. failing that, for a **departure manoeuvre** — `cast_off` or `anchor_up` — the passage detection closed less than
   `stopClosureMinutes` before the event, which detection reopens once the vessel moves within that time of the event
   (`openedEntry` is `false`); otherwise a new passage it opens at the event's time (SPEC §4.3). The new passage starts
   stopped, at the event's position, named as detection would name it; detection carries it on as soon as the vessel
   moves, or closes it at the event if the vessel has not left within `stopClosureMinutes`. The start is never earlier
   than the previous passage's end;
3. failing that, the last passage while the vessel is within 1 nm of its arrival — a note in the marina belongs to the
   passage that ended there;
4. otherwise the request is refused with `409 no_passage`.

```json
{
  "type": "manoeuvre",
  "subtype": "reef_in",
  "comment": "25 kn, second reef",
  "payload": { "sail": "main" },
  "clientRef": "3f6c1a52-8f0e-4a0e-9d43-2a1c5d4b7e10"
}
```

Accepts `type`, `subtype`, `comment`, `payload`, `time`, `position`, `clientRef`:

- `time` defaults to now and `position` to the vessel's position at that time, so a shortcut button is a single call
  with no client-side clock or GPS; pass `"position": null` to record none. For a past `time` — an entry replayed from
  an offline queue — the position is the nearest track point within 2 minutes, else the current position if `time` is
  within 5 minutes of now, else none.
- `clientRef` (1–100 characters) is an idempotency key: posting a `clientRef` already logged answers `200` with that
  event and changes nothing, so a retry after a lost response neither duplicates the entry nor opens a second passage.

Answers `201` with the event — `entryId` says where it went — plus `"openedEntry": true` when it opened the passage.

A client-created event posted without `time` also takes an instrument snapshot (`reason: "event"`) at the event's time,
so the log shows the conditions it was made in — a manoeuvre, a keyboard note, or a handwritten one. Posted with a
`time` (an entry replayed from an offline queue), no snapshot is taken: current readings say nothing about a moment
already past.

Clients may create three types; the others are produced by the plugin itself:

| `type`                   | Requires                                                                                                               |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `manoeuvre`              | `subtype`, the key of an existing manoeuvre type — `400 unknown_manoeuvre_type` otherwise                              |
| `text_annotation`        | `comment`                                                                                                              |
| `handwritten_annotation` | `payload.strokes`: `[{ "points": [{ "x", "y", "t", "pressure"? }], "color"?, "tool"?, "width"? }]`, non-empty, numeric |

A stroke's `color` (`"#rrggbb"`), `tool` (`"pen"` or `"highlighter"`) and `width` (canvas pixels, before pressure
scaling) are optional — a note drawn before the tablet's toolbar existed has none, and is shown in the current text
colour at a default width. `tool: "highlighter"` is the only one drawn translucent, wherever the note is later shown.

### `POST /entries/:id/events` — `readwrite`

The same as [`POST /events`](#post-events--readwrite), for a given entry — open or closed — with no attachment rule.
`clientRef` and the snapshot behave the same; the response has no `openedEntry`.

### `PATCH /events/:id` — `readwrite`

Accepts `time`, `comment`, `subtype`, `payload`, and validates the result by the same rules as creation. On an event the
plugin produced (`sk_alarm`, `autopilot`, `weather_threshold`, `manual_correction`, `propulsion_change`, `stopover`,
`heading_change`), only `comment` may change — annotating an alarm is fine, rewriting it is not.

### `DELETE /events/:id` — `readwrite`

`204`. Deleting the departure manoeuvre that opened a passage, while the vessel has not moved yet and nothing else was
logged in it, deletes that passage too: this is how a mistaken "Cast off" is undone. An `sk_alarm` event is logged in
pairs — the notification reaching `alarm`/`emergency`, and the one that later cleared it — so deleting either takes the
other with it; an escalation from `alarm` to `emergency` is not a pair (both are critical) and is left alone.

## Places

### `GET /places` — `readonly`

The gazetteer, for a management screen, sorted by name — accent- and case-insensitively, so "Île de Ré" sorts among the
I's. Paginated.

Each place carries `countryCode`, the upper-case ISO 3166-1 alpha-2 code of the country it is in, or `null` while it is
not known — geocoding is off, or has not answered yet, or the position is not in any country. It is filled in by the
same background lookup as pending names (SPEC §4.8) and is not editable.

### `PATCH /places/:id` — `readwrite`

```json
{ "name": "Port des Minimes" }
```

Marks the place `source: "manual"`, which makes the name authoritative for later passages within the radius. Past
entries are untouched.

### `DELETE /places/:id` — admin

Entries that referenced it lose the reference but keep their recorded names. `204`.

## Manoeuvre shortcuts

### `GET /manoeuvre-types` — `readonly`

Ordered by `sortOrder`. Disabled types are included, so a settings screen can show them. Paginated.

### `POST /manoeuvre-types` — admin

```json
{
  "key": "spinnaker_up",
  "label": "Hoist spinnaker",
  "icon": null,
  "sortOrder": 110,
  "enabled": true
}
```

`key` is 1–40 lowercase letters, digits or underscores; `label` is required. `sortOrder` defaults to after the last
type. `409 manoeuvre_type_exists` for a taken key. Answers `201`.

### `PATCH /manoeuvre-types/:key` — admin

Accepts `label`, `icon`, `sortOrder`, `enabled` — on built-in types too. The key cannot change.

### `DELETE /manoeuvre-types/:key` — admin

`409 builtin_manoeuvre_type` for a built-in; disable it instead. Events that used a deleted type keep their `subtype`.
`204`.

## Crew

The crew list (SPEC §4.11): a global, editable roster, and the entry-scoped list of who was aboard a given passage.

### `GET /crew` — `readonly`

The roster, sorted by name — accent- and case-insensitively, like [places](#places). Paginated.

### `POST /crew` — `readwrite`

```json
{ "name": "Alex Martin", "role": "skipper" }
```

`name` is required; `role` is free text, optional. Anyone aboard can add a name here, not just an admin — the same
reasoning as a place-name correction (§4.8): a crew member at the helm has to be able to extend the roster without an
admin login. Answers `201`.

### `PATCH /crew/:id` — `readwrite`

Accepts `name`, `role`. A passage that already recorded this person keeps the name and role as they stood at the time
(see `PUT /entries/:id/crew` below).

### `DELETE /crew/:id` — `readwrite`

Removing someone from the roster is `readwrite` too, not `admin` — unlike `places`/`manoeuvre-types` — so the crew can
correct the roster from the tablet without an admin login. Passages that already recorded this person keep their name
and role. `204`.

### `PUT /entries/:id/crew` — `readwrite`

```json
{ "members": [{ "crewMemberId": 3 }, { "name": "Jo", "role": "crew" }] }
```

Replaces the entry's crew list. Each item either picks an existing roster member by id (`404 crew_member_not_found` if
unknown), or gives a `name` (and optional `role`) that extends the roster — reusing an existing member of the same name
(case- and accent-insensitively) rather than creating a duplicate, the same way an unrecognised place name becomes a new
place.

**Carried over from the previous passage.** When a new passage opens — automatically or by casting off (§4.3) — it
starts with the same crew as the one immediately before it, still adjustable here.

Not a separate read endpoint: an entry's crew is included in [`GET /entries/:id`](#get-entriesid--readonly) as `crew`.

## Export

### `GET /export` — `readonly`

Query: `format` — `json` (default), `csv`, `gpx` or `pdf`; `from`, `to` as for [`GET /entries`](#get-entries--readonly);
for `pdf`, `lang` (`en` or `fr`) and `tz` (an IANA time zone such as `Europe/Paris`), which default to the plugin's
logbook language and time zone — `400` for an unknown value. Served as an attachment named `chiplog.<format>`.

- **`json`** — the complete record, in SI units: `{ exportedAt, schemaVersion, units, entries }`, where each entry
  carries its `trackPoints`, `observations`, `propulsion`, `events`, `landmarks` (as
  [`GET /entries/:id/landmarks`](#get-entriesidlandmarks--readonly) lists them), `weather` (the body of
  [`GET /entries/:id/weather`](#get-entriesidweather--readonly), or `null`) and `crew` (see [Crew](#crew)). This is the
  machine-readable abandon-ship payload (SPEC §4.5).
- **`csv`** — one chronological line per departure, observation, event and arrival: a paper logbook readable in any
  spreadsheet. Unlike everything else, it is **converted to nautical units** — knots, degrees, hPa, °C, nautical miles,
  engine hours — with units in the column names. After the fixed columns, one `engine_runtime_<engine>_h` column per
  engine found in the export (e.g. `engine_runtime_port_h`) keeps each engine's hour counter; `engine_runtime_h` is the
  main or first engine's. Free text that a spreadsheet would execute as a formula is prefixed with `'`.
- **`gpx`** — one track per entry.
- **`pdf`** — the facsimile logbook (SPEC §4.5): A4 landscape, a page per day in the given time zone, with time,
  position — with its bearing from the nearest amer under it (SPEC §4.13) — course, speed over ground, wind, barometer,
  depth, engine or sail and remarks; departures and arrivals with their totals, day totals, handwritten notes drawn. The
  wording is the webapp's, in `lang`.

### `GET /export/usb` — `readonly`

What the USB copy is set to do and how it last went, for the export screen.

```json
{
  "directory": "/media/usb",
  "configured": true,
  "intervalMinutes": 15,
  "onArrival": true,
  "running": false,
  "nextAt": "2026-09-13T16:00:12.000Z",
  "lastSuccess": {
    "at": "2026-09-13T15:45:12.310Z",
    "reason": "scheduled",
    "entries": 12,
    "written": 1,
    "unchanged": 11,
    "removed": 0
  },
  "lastError": null
}
```

- The copy runs by itself every `intervalMinutes` (the first one a minute after the plugin starts, leaving the drive
  time to mount) and, with `onArrival`, when a passage closes — by detection or by hand. `nextAt` is `null` without a
  periodic copy or a directory.
- `reason` is `scheduled`, `arrival` or `manual`. `lastError` — `{ at, reason, code, message }` — is the failure of the
  latest copy, cleared by the next one that succeeds; a failed copy leaves `lastSuccess` as it was. Both are kept in
  memory and start empty when the plugin starts.
- Copies never overlap: a copy requested while one is running waits for it, and requests made meanwhile share a single
  copy after it.

### `POST /export/usb` — admin

Copies the logbook to a `chiplog/` subdirectory of the directory set in the plugin configuration, as one JSON, CSV, GPX
and PDF file per passage, in the same formats as [`GET /export`](#get-export--readonly) restricted to that passage; the
PDF uses the plugin's logbook language and time zone.

- **Names sort by departure**: `<start date>_<start time>Z_<departure>_<arrival>.<format>`, in UTC, with place names
  reduced to ASCII letters, digits and hyphens — e.g. `2026-09-13_0612Z_La-Rochelle_Les-Sables-d-Olonne.json`. A passage
  in progress ends in `underway`; one with no name has `unnamed`; two passages starting in the same minute get `_2` on
  the later one.
- **Incremental.** Only passages that are new or changed since the last export are written. What was exported is
  recorded in `chiplog/.chiplog-export.json`, with a fingerprint of each passage's content, so a correction made later —
  a renamed place, a switched engine period, an edited comment, an alarm added at anchor, a weather forecast arriving
  after departure — rewrites that passage, and so does a change of the logbook language, time zone or vessel name. A new
  plugin version does not. Files already on the drive with no record are kept as they are; a missing file is written
  again.
- **Obsolete files are removed**: those of passages deleted, merged or renamed. Only files named like passage files are
  touched in `chiplog/`.
- Each file is flushed to the device and renamed into place, so pulling the drive never leaves a half-written export.

```json
{
  "directory": "/media/usb/chiplog",
  "entries": 12,
  "written": 1,
  "unchanged": 11,
  "files": ["/media/usb/chiplog/2026-09-13_0612Z_La-Rochelle_Les-Sables-d-Olonne.json", "…csv", "…gpx"],
  "removed": []
}
```

`entries` counts all passages, `written` those whose files were written, `unchanged` those left as they were; `files`
and `removed` list full paths.

`409 usb_export_not_configured` without a configured directory; `409 usb_export_unavailable` if it does not exist —
typically, the drive is not mounted. The copy made here is the same as the automatic one, and waits for one already
running.

## Retrospective analysis

Reconstructs passages for a past date range from the boat's recorded history — the server's own History API provider, or
a signalk-to-influxdb database (InfluxDB 1.x) read directly — through the same detection pipeline used live (SPEC
§4.10). One reconstruction runs at a time, in the background.

### `GET /replay` — `readonly`

```json
{
  "configured": true,
  "running": true,
  "progress": {
    "from": "2026-01-01T00:00:00.000Z",
    "to": "2026-01-08T00:00:00.000Z",
    "now": "2026-01-03T11:20:00.000Z",
    "phase": "replaying",
    "summary": {
      "passages": 2,
      "distance": 41200,
      "engineDuration": 3600,
      "sailDuration": 9800,
      "trackPoints": 1840,
      "events": 3
    },
    "retry": { "attempt": 1, "of": 3, "message": "InfluxDB at http://influx:8086 did not answer within 30s" }
  },
  "lastResult": null,
  "lastError": null
}
```

- `configured` says whether a history source is usable: with the History API selected, that the server exposes one at
  all; with InfluxDB 1.x, that a host and database are set in the plugin configuration. A server that exposes the API
  but has no provider registered still reports `true`, and the run fails with that as its `lastError`. `progress` is
  `null` while nothing runs.
- `progress.phase` is `"scanning"` while a light pass over the whole range looks for when the vessel moved, then
  `"replaying"` while each window of motion is fetched and run through the detection pipeline (SPEC §4.10);
  `progress.now` tracks whichever phase is in flight — during `"scanning"` it is how far through the range the scan has
  got, during `"replaying"` it is the detector's simulated clock, which jumps over the stretches the vessel lay still.
- `progress.summary` is recomputed after every committed slice (SPEC §4.10) with the same shape as `lastResult.summary`
  below, `null` while still scanning — so the webapp can show what has actually been saved so far rather than only the
  clock position, and a run that then times out still leaves something on screen instead of a bare error.
- `progress.retry` — `{ attempt, of, message }`, `null` outside a retry — appears while an individual history query is
  being retried after timing out (SPEC §4.10), `attempt` counting from 1 up to `of` (3); it disappears again as soon as
  a query gets through. Either history source is bounded and retried the same way.
- The scan reads a week at a time and a window's history two hours at a time, with a short pause between requests, so
  one query cannot overwhelm a resource-constrained host running both Signal K and its history (SPEC §4.10).
- `lastResult` — `{ at, from, to, cancelled?, summary }` — and `lastError` — `{ at, from, to, message, summary }` —
  describe the latest attempt. `summary` — `{ passages, distance, engineDuration, sailDuration, trackPoints, events }`,
  metres and seconds — totals what the run added, including up to a cancellation or a failure; a passage live detection
  opened meanwhile is not counted. Both are kept in memory and start empty when the plugin starts. `lastError.message`
  names the vessel contexts actually found when none match the one configured (SPEC §4.10) — the usual cause of a replay
  that runs to completion but reconstructs nothing — whichever history source was read. A query that times out is
  retried up to 3 times, 5 seconds apart, before `lastError` reports it; passages already committed before the failing
  chunk stay on record, so `lastError.summary` reports them and a follow-up run starting after them does not repeat the
  work.

### `POST /replay` — admin

Body: `{ from, to }`, ISO 8601 timestamps, `to` after `from`. Answers `{ from, to }` as soon as the reconstruction has
started, without waiting for it to finish — poll [`GET /replay`](#get-replay--readonly) for its progress.

`409 replay_not_configured` without an InfluxDB connection configured; `409 replay_running` if one is already running;
`409 replay_navigation_active` if a passage is currently under way, whatever the requested range — the replay drives the
same detector against the same database as live detection, and the two running at once would corrupt that passage;
`409 replay_overlaps` if the range overlaps a passage already on record — nothing is reconstructed in that case, on
purpose (SPEC §4.10).

### `POST /replay/cancel` — admin

Stops the reconstruction in progress, whether it is still scanning history or already replaying; `204`. The range
already reconstructed up to that point stays on record — cancelling does not roll it back. `409 replay_not_running` with
nothing to cancel.

## Not yet provided

- **`getOpenApi()`**, the machine-readable version of this document, which the Signal K server can surface. Worth adding
  once the API has settled, so the two do not have to be kept in step while it still moves.

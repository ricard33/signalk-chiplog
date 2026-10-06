# Data model

The authoritative schema is the DDL in [`lib/database.js`](../lib/database.js). This document records the conventions
and the reasoning behind the non-obvious parts — read it before changing the schema.

Functional requirements it implements are in [SPEC.md](SPEC.md).

## Conventions

**Units follow Signal K, unconverted.** Angles in radians, speeds in m/s, distances in metres, durations in seconds,
pressure in Pa, temperatures in K. Values arrive from the SK bus in SI and are exported to the user in knots, degrees
and nautical miles; doing that conversion at the presentation layer only means there is exactly one place where a unit
bug can live. Never store display units.

**Timestamps are ISO 8601 UTC text** with millisecond precision (`2026-09-13T08:00:00.000Z`). SQLite has no date type;
ISO 8601 sorts lexicographically, is readable in a raw export, and sidesteps the ambiguity of storing a boat's local
time as it crosses time zones. Local time is a rendering concern.

**Column names are `snake_case`; the REST API exposes `camelCase`.** The mapping happens in the API layer.

**Nullable readings.** Every instrument reading is nullable: a vessel may have no wind sensor, no log, no depth sounder,
and per SPEC §4.7 the absence of a sensor must never block logging.

## Entities

### `log_entries`

One row per passage (start → underway → stop), per SPEC §3.1.

`state` is `active` or `closed`. A partial unique index enforces **at most one active entry** at a time — one vessel per
instance, and passages are sequential, so two open entries would always be a bug.

`stopped_since` is when an active entry's vessel stopped. Since migration 13, detection closes an entry as soon as it
sees the stop (`end_time` taken from `stopped_since`), so it only lasts on an entry the crew opened by casting off,
which waits there until the vessel moves or the `stopClosureMinutes` threshold passes — and on an entry an earlier
version left waiting out a stop, which ends the same way.

`closed_by` (migration 13) is `detection` or `crew`, `NULL` while active and on entries closed before it existed. A
departure less than `stopClosureMinutes` after the end of the last entry reopens it — back to `active`, `end_time` and
the arrival place cleared, the stop recorded as a `stopover` event — only when detection closed it (SPEC §4.2); a crew
close confirms the arrival, and a passage imported through `POST /entries` (SPEC §4.15) has none at all, so nothing ever
reopens it. A crew departure manoeuvre logged on that entry after its end counts as the start of the wait. Merging keeps
the later entry's value. Not exposed by the API.

`last_moving_at` (migration 2) is a heartbeat: passage detection refreshes it about once a minute while under way. It
exists for restarts — when the plugin comes back to an open entry, it is the only record of when the boat was last seen
moving, and so dates the end of a passage that stopped while the plugin was off. It is not exposed by the API.

`start_tanks` and `start_batteries` (migration 11) hold the boat's state noted as the passage opened (SPEC §4.5.1) —
once, on the passage, since it is what a skipper checks before casting off, not a reading to follow along the way like
those in `observations`. Both are JSON arrays in SI units, `NULL` when the boat publishes none or the passage was opened
after the fact:

| Column            | Signal K paths                                                                                                                                                                                                                                                                                                   | Current for |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| `start_tanks`     | every `tanks.<type>.<id>` with a `currentLevel` or `currentVolume`: `[{"type": "fuel", "id": "0", "name": "…", "level": 0.8, "volume": 0.096, "capacity": 0.12}]` — ratio and m³ (`.name`, `.capacity`), a field absent when not published; fuel first, then fresh water, grey and black water, the others after | counter     |
| `start_batteries` | every `electrical.batteries.<id>` with a current reading: `[{"id": "house", "name": "…", "voltage": 12.8, "current": -3.2, "stateOfCharge": 0.86, "temperature": 295.1}]` — V, A (negative discharging), ratio (`capacity.stateOfCharge`), K                                                                     | 15 min      |

They are written by detection as it opens the entry, or, for an entry the crew opens by hand, as the departure manoeuvre
is logged live. Merging keeps the earlier entry's, its departure being the merged passage's.

`opened_by_event_id` (migration 4) points to the departure manoeuvre — cast off or anchor up — that opened the entry by
hand before the vessel moved (SPEC §4.3). Such an entry starts with `stopped_since` equal to `start_time` and
`last_moving_at` null: detection sees a stopped passage, resumes it on the first movement and closes it like any long
stop if the vessel never leaves. Deleting that event while `last_moving_at` is still null and nothing else was logged
deletes the entry too — the undo of a mistaken tap.

While an entry is **active**, `end_lat`/`end_lon` hold the last position seen moving, then the position where the vessel
stopped; they become the arrival position when the entry closes. Clients should not present them as an arrival until
`state` is `closed`.

`start_place_name` / `end_place_name` are **denormalised on purpose**, alongside the `place_id` references. A logbook is
a historical record: renaming a place later (SPEC §4.8) must apply to future passages, not silently rewrite what last
year's entries say. The foreign keys are `ON DELETE SET NULL` for the same reason — deleting a place must not erase the
name a past entry recorded.

### `track_points` vs `observations`

The spec asks for two different things from the recorded data, so they are two tables:

- **`track_points`** is dense geometry — position, SOG, COG (true), and, since migration 6, wind and heading (`tws`,
  `twd`, `aws`, `awa`, `heading`), plus, since migration 9, speed through water (`stw`) — at the same read each point
  takes — sampled per SPEC §4.1 (fixed interval plus extra points on heading/speed deltas). It feeds the map, the GPX
  export, and figures that need a real maximum rather than an hourly sample, such as `maxWindSpeed`
  (`GET /entries/:id`); the passage page's position scrubber (SPEC §4.1) reads it directly rather than interpolating
  from the hourly `observations`. True wind angle is not a column: it is `twd` minus `heading`, computed where shown
  rather than stored, since it needs no sensor of its own. Keeping it narrow still matters: a long passage produces a
  lot of rows — about 240 an hour under way at the default 15 s interval. Point times come from the host clock, like
  entry times, so they always fall within their entry. `log_entries.distance` is kept as the running sum of the
  distances between an entry's consecutive points.
- **`observations`** is a sparse, wide snapshot of every instrument at one moment: wind, depth, barometer, log, engine
  hours. These are the rows the facsimile PDF (SPEC §4.5) renders as classic logbook lines. `reason` records why the
  snapshot was taken (`periodic`, `entry_start`, `entry_end`, `event`). An `entry_end` row's `time` is the passage's
  actual end (`log_entries.end_time`), dated from raw speed, not the later tick that found out about it — otherwise it
  could sort after readings genuinely taken first. Entries closed by an earlier version, which waited
  `stopClosureMinutes` before closing, may have their `entry_end` row later than `end_time`. A passage reopened after a
  stopover, or merged, holds several `entry_start` and `entry_end` rows: the first `entry_start` is its departure, the
  last `entry_end` its arrival, and the others belong to its stopovers — each later `entry_start` dated from when the
  vessel set off again.

The two overlap on wind and heading since migration 6, and on speed through water since migration 9, but still do
different jobs: `observations` is the timed, reasoned record the PDF renders as logbook lines; `track_points` is the
dense series a chart or a maximum is computed from. Merging them would mean either carrying every instrument column on
the dense table, unread most of the time, or losing the hourly conditions record — so each keeps its own copy of what it
needs, even where that duplicates a reading.

**Where observation columns come from** (`lib/observation-recorder.js`). A reading is recorded only while current — its
Signal K timestamp changed within the stated age — and is `null` otherwise. Counters are the exception: their last value
stays a true reading while they do not move, so they are recorded whatever their age.

| Column            | Signal K path                                                                                                                                               | Current for              |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| `lat`, `lon`      | `navigation.position`                                                                                                                                       | 2 min                    |
| `sog`             | `navigation.speedOverGround`                                                                                                                                | 2 min                    |
| `cog`             | `navigation.courseOverGroundTrue`                                                                                                                           | 2 min                    |
| `heading`         | `navigation.headingTrue`, else `navigation.headingMagnetic` + `navigation.magneticVariation`                                                                | 2 min (variation 15 min) |
| `stw`             | `navigation.speedThroughWater`                                                                                                                              | 2 min                    |
| `twd`, `tws`      | `environment.wind.directionTrue`, `environment.wind.speedTrue`                                                                                              | 2 min                    |
| `awa`, `aws`      | `environment.wind.angleApparent`, `environment.wind.speedApparent`                                                                                          | 2 min                    |
| `depth`           | `environment.depth.belowSurface`, else `environment.depth.belowTransducer`                                                                                  | 2 min                    |
| `pressure`        | `environment.outside.pressure`                                                                                                                              | 15 min                   |
| `air_temp`        | `environment.outside.temperature`                                                                                                                           | 15 min                   |
| `water_temp`      | `environment.water.temperature`                                                                                                                             | 15 min                   |
| `trip_log`        | `navigation.log`                                                                                                                                            | counter                  |
| `engine_runtimes` | `propulsion.<id>.runTime` of every engine that has one, as JSON `{"port": 2924700, "starboard": 2873220}` in seconds, `main` first then by id (migration 5) | counter                  |
| `engine_runtime`  | the first of `engine_runtimes`: `propulsion.main.runTime`, else the first engine that has one — kept for readers of the single value                        | counter                  |

True wind is taken as published, not computed from apparent wind; a boat without a true-wind source can add one with the
`signalk-derived-data` plugin. A snapshot in which every column would be `null` is not recorded.

### `events`

The timestamped timeline within an entry (SPEC §3.3): manoeuvres, annotations, automatic Signal K events.

`type` is the coarse category; `subtype` qualifies it — the manoeuvre key, the SK notification path, the autopilot
state. `subtype` is deliberately **not** a foreign key to `manoeuvre_types`: deleting a custom shortcut must not rewrite
or cascade away the passages where it was used. The UI falls back to displaying the raw key for a type that no longer
exists.

`comment` carries free text for any event. `payload` is JSON, reserved for structured detail: handwritten stroke data
(SPEC §4.4), the sail selected on a sail change, the before/after of a manual correction.

`source` distinguishes automatic events from user entries, so corrections can be told apart from detections.

Events the plugin produces (SPEC §4.6), all with `source: 'auto'`:

| `type`                            | `subtype`                                       | `payload`                                                                                                                                                                      |
| --------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `sk_alarm`                        | the notification path, e.g. `notifications.mob` | `{ state, message }` — `state` is `alarm`, `emergency`, or `normal` when it cleared                                                                                            |
| `autopilot`                       | `engaged`, `disengaged` or `mode_changed`       | `{ mode, state, target }` — `target` in radians, a number or `{ headingTrue, headingMagnetic, windAngleApparent, windAngleTrue }`; `null` once disengaged                      |
| `weather_threshold`               | `wind_above` or `wind_below`                    | `{ threshold, windSpeed }` in m/s                                                                                                                                              |
| `weather_threshold`               | `pressure_drop`                                 | `{ drop, over, pressure }` — Pa, seconds, Pa                                                                                                                                   |
| `manual_correction`               | `propulsion`                                    | `{ segmentId, before, after }`                                                                                                                                                 |
| `propulsion_change` (migration 7) | _(none)_                                        | `{ segmentId, before, after }` — same shape as `manual_correction`, for an automatic switch rather than a crew override                                                        |
| `stopover` (migration 10)         | _(none)_                                        | `{ placeName, placePending }` — the place and position an entry ended at, before a merge (SPEC §3.1) or a quick departure (SPEC §4.2) folded it into the middle of the passage |
| `heading_change` (migration 17)   | _(none)_                                        | `{ heading, previousHeading }` in radians — the average heading over the hold, and the one it changed from                                                                     |

`client_ref` (migration 4) is an optional idempotency key chosen by the client, unique when present. The tablet sets it
on every entry, so one replayed from its offline queue after a lost response returns the event already logged instead of
a duplicate.

`propulsion_change` (migration 7), `stopover` (migration 10) and `heading_change` (migration 17) needed `type`'s CHECK
constraint widened, which SQLite can only do by rebuilding the table — `lib/database.js`'s
`addPropulsionChangeEventType`, `addStopoverEventType` and `addHeadingChangeEventType`. Foreign keys are turned off
around the rebuild: `log_entries.opened_by_event_id` references `events`, and with them enforced, `DROP TABLE events`
would fire its `ON DELETE SET NULL` for every referencing row before the table (and the reference) is gone.

`stopover`'s `lat`/`lon` and `comment` are also set, unlike the other automatic types: `comment` carries the raw place
name, like an `sk_alarm`'s message, so it still reads in a CSV export or before a crew annotation is added on top of it.
Its `time` follows the merged-away entry's own `entry_end` observation when the two disagree — only possible for an
entry closed before `entry_end` was dated correctly (below), since the two are otherwise the same instant.

An event's `time` may fall **after its entry's `end_time`**: alarms and weather events between passages go to the
passage that ended where the vessel still is.

### `places`

The gazetteer behind SPEC §4.8. `source` is `geocoding` (proposed by the online lookup) or `manual` (the user corrected
it, so it wins on subsequent passages). It doubles as the geocoding cache: a departure or arrival within the radius of
any place, whatever its source, is named from it without a request.

`country_code` (migration 16) is the country the place is in, an upper-case ISO 3166-1 alpha-2 code, for the statistics
page's list of countries visited (SPEC §4.14). It is stored on the place and reached from an entry through
`start_place_id` / `end_place_id`, not copied onto the entry as a name is: it is a fact about the place rather than part
of the logbook's record, so deleting a place takes it away from the passages that used it. `country_checked` says the
lookup has been made — a place with no country (open water) must not be asked about again, and a place saved before the
migration, or added by hand, starts unchecked and is filled in by the background chain that names pending departures.

On `log_entries`, `start_place_pending` and `end_place_pending` (migration 3) flag a name generated from coordinates
that online geocoding has yet to answer for. They are cleared when the lookup resolves or finds nothing to name, and as
soon as someone sets the name. A pending name follows a corrected position: the generated name is regenerated and the
lookup redone.

The index on `(lat, lon)` supports a bounding-box prefilter; the exact radius test runs in application code, since
SQLite has no spatial functions here and the candidate set after the bounding box is tiny.

### `landmarks` and `landmark_areas` (migration 15)

The gazetteer of amers behind SPEC §4.13, and the record of which areas it covers. Deliberately apart from `places`: a
place _names_ a departure or arrival and is part of what the logbook recorded, while a landmark is reference data the
bearing under each position is computed from — nothing here is denormalised onto an entry, and deleting the tables would
lose nothing but the trouble of fetching them again.

| Column                | Meaning                                                                        |
| --------------------- | ------------------------------------------------------------------------------ |
| `osm_type` / `osm_id` | Where it came from; unique together, so a re-fetch updates rather than doubles |
| `name`                | OpenStreetMap's `name`, else `seamark:name`; a feature with neither is skipped |
| `kind`                | `lighthouse`, `light`, `cape`, `landmark`, `beacon` or `harbour`               |
| `lat` / `lon`         | A node's own position, or the centre of a way or relation                      |
| `light_range`         | The greatest range of its light in metres, when tagged; `null` otherwise       |

`landmark_areas` holds one row per half-degree cell already fetched (`cell_lat`/`cell_lon` are the cell's floor
indices). The fetch covers the cell plus a margin as wide as the furthest an amer is quoted from, so a cell recorded
here means every position inside it has all its landmarks. `log_entries.landmarks_pending` is the cursor: set on
creation and whenever an entry is edited or merged, cleared once every cell that entry has positions in is covered —
except for an active entry, which keeps moving into new cells.

The index on `(lat, lon)` supports the same bounding-box prefilter as `places`; distance and bearing are computed at
read time, in `public/js/landmarks.mjs`, shared by the webapp and the PDF.

### `propulsion_segments`

Engine vs sail periods within an entry (SPEC §4.2), with `average_rpm` and a `source` flag marking segments a user has
manually corrected.

Segments cover only time **under way**: a stop ends one and moving again starts the next, so there are gaps during stops
and `engine_duration + sail_duration` on the entry is time under way, not elapsed time. At most one segment is open
(`end_time IS NULL`) — the ongoing one of the active entry — and it counts up to now in the entry's durations, which are
rewritten on every detection cycle while under way.

### `manoeuvre_types`

The shortcut list (SPEC §4.3). Built-in entries are seeded by the migration with `builtin = 1`; users may disable or
reorder them (`enabled`, `sort_order`) and add their own. Seeding uses `ON CONFLICT DO NOTHING`, so a user's edits to a
built-in row survive restarts.

### `crew_members` (migration 14)

The roster behind SPEC §4.11 — who might be aboard, ever. Unlike `manoeuvre_types` there is no `builtin`/`sort_order`:
the list is short enough to sort alphabetically at read time, the same way `places` does (`listCrewMembers`,
`Intl.Collator` — SQLite's `NOCASE` only folds ASCII). `role` is free text and optional (e.g. "skipper", "crew").

### `log_entry_crew` (migration 14)

Who was aboard a given passage — the schema's first many-to-many relationship. `name` and `role` are **denormalised on
purpose**, exactly like `log_entries.start_place_name`: a logbook is a historical record, so correcting or deleting a
`crew_members` row (`ON DELETE SET NULL`) must not rewrite who a past passage says was aboard. A partial unique index on
`(entry_id, crew_member_id)` (`WHERE crew_member_id IS NOT NULL`) stops the same roster member being assigned to one
entry twice; an ad hoc crew member with no roster row (`crew_member_id IS NULL`) has nothing to deduplicate against,
hence the partial index rather than a plain one.

A new passage starts with the same crew as the one immediately before it (`copyCrewFromPreviousEntry`, SPEC §4.11);
merging two entries (`mergeEntries`) unions the two crew lists onto the survivor rather than reassigning rows outright,
since carry-over means they usually already overlap and a plain reassignment would collide with the unique index.

### `tide_forecasts` (migration 8)

At most one row per entry (`entry_id` is the primary key), fetched once near departure (SPEC §4.5.2): `lat`/`lon` are
the position asked about, `points` the JSON `[{ time, height }]` hourly curve for the 24 h from departure, height in
metres. No row means no attempt has resolved yet — still pending, or the departure is now too old for one to be worth
making. `points: []` means a fetch answered but had nothing usable for the position (an inland lake); `getTideForecast`
(`lib/tide-forecaster.js`) treats that the same as no row, since the webapp has nothing to show either way — the
distinction only matters to the fetcher itself, so it does not keep re-asking.

There is no `datum` column: every row is Open-Meteo `sea_level_height_msl`, relative to mean sea level rather than the
chart datum nautical tide tables use, and `getTideForecast` reports that as the constant `datum: "msl"` rather than
storing it per row. A second source with a different reference would need one.

High and low tide are not stored: they are the local peaks and troughs of `points`, found when read
(`public/js/tide.mjs`'s `tideExtremes`), the same principle as `maxSpeed`/`maxWindSpeed` on `GET /entries/:id`.

### `weather_forecasts` (migration 12)

Same shape and lifecycle as `tide_forecasts` (SPEC §4.5.3): one row per entry, `lat`/`lon` the position asked about,
`points` the hourly JSON for the 24 h from departure, `[]` once fetched if neither service had anything for the
position. `getWeatherForecast` (`lib/weather-forecaster.js`) treats `[]` as no forecast. Each point is:

| Field                              | Unit                      | Open-Meteo variable                         |
| ---------------------------------- | ------------------------- | ------------------------------------------- |
| `time`                             | ISO 8601 UTC, on the hour |                                             |
| `windSpeed`, `windGust`            | m/s                       | `wind_speed_10m`, `wind_gusts_10m`          |
| `windDirection`                    | rad, where it comes from  | `wind_direction_10m`                        |
| `pressure`                         | Pa, at sea level          | `pressure_msl`                              |
| `weatherCode`                      | WMO code                  | `weather_code`                              |
| `visibility`                       | m                         | `visibility`                                |
| `precipitation`                    | m of water over the hour  | `precipitation`                             |
| `cloudCover`                       | ratio                     | `cloud_cover`                               |
| `airTemperature`, `seaTemperature` | K                         | `temperature_2m`, `sea_surface_temperature` |
| `waveHeight`, `swellHeight`        | m                         | `wave_height`, `swell_wave_height`          |
| `wavePeriod`, `swellPeriod`        | s                         | `wave_period`, `swell_wave_period`          |
| `waveDirection`, `swellDirection`  | rad, where they come from | `wave_direction`, `swell_wave_direction`    |
| `currentSpeed`                     | m/s                       | `ocean_current_velocity`                    |
| `currentDirection`                 | rad, where it flows to    | `ocean_current_direction`                   |

Every field is `null` when the service did not give it — all the sea fields, inland. An hour with nothing at all is left
out. The 3-hour steps the webapp and the PDF show are derived when read (`public/js/weather.mjs`'s `forecastSteps`), not
stored.

### `passage_summary_mails` (migration 18)

One row per entry (`entry_id` is the primary key) recording what became of its summary email (SPEC §4.16). The row is
the whole mechanism: a closed passage with **no** row is one still due a summary, and writing a row is what stops a
second one going out. `sent_at` holds when the mail left and `recipients` the addresses it went to; a row with `sent_at`
null is one that will never be sent, with `error` saying why — the relay refused it for good, or it was closed too long
ago for a summary to be worth sending.

Nothing else is kept: the summary itself is rendered from the passage each time, so a correction to a place name or a
figure is reflected in a summary resent by hand (`POST /entries/:id/summary-mail`).

Two deletions matter. The foreign key cascades, so merging or deleting a passage takes its row with it; and detection
deletes the row when a departure reopens a passage (§4.2), since the arrival that was summarised is no longer the
passage's end.

The migration that creates the table fills it for every entry already closed, marked as never sent. That is what keeps
switching the option on from mailing the whole logbook.

### `logbook_identity` (migrations 19, 20)

One row: the logbook's own `id`, a random UUID made by the migration, and when. The online service (SPEC §4.17) files
passages under it and the entry id, which is what keeps a reinstalled plugin — whose ids start again from 1 — from
overwriting or deleting what an earlier logbook sent. It travels with the database file: a restored copy is the same
logbook. Nothing about what was sent is stored: the service reports what it holds.

`restoring` (migration 20) is 1 while an earlier logbook is being read back from the service: the `id` is already that
of the logbook restored, but not all its passages are written yet. The backup does not run while it is set — it would
report the missing passages as deleted on board — and a restore cut short is carried on with at the next start.
Restoring writes rows under the ids they had (`log_entries`, `events`, `observations`, `propulsion_segments`,
`log_entry_crew`, `places`), which is what makes a restored passage hash as the original did; it raises
`sqlite_sequence` for `log_entries` first, so a passage logged meanwhile cannot take the id of one still to come.

## Migrations

`MIGRATIONS` in `lib/database.js` is an ordered, **append-only** list; the applied index is stored in SQLite's
`user_version`. Once a version has shipped to a boat, editing its entry would leave that installation on a schema the
code no longer expects — add a new entry instead.

Most entries are a SQL string, run inside a transaction. An entry may instead be a function `(db, version)` for the rare
change a transaction can't express as one statement or that needs a pragma toggled outside one — such as
`addPropulsionChangeEventType` (migration 7), which rebuilds a table to change a CHECK constraint. A function migration
must set `user_version` itself once it has made its change durable.

Each migration runs in a transaction and rolls back as a unit on failure.

## Deferred

Not in the schema yet, to be added by a later migration when the feature lands:

- **Author per event** (SPEC §3.4) — attributing an individual annotation or manoeuvre to whoever logged it, if V2
  confirms the need. A per-passage crew _roster_ is delivered in V1 instead — see `crew_members`/`log_entry_crew` above.

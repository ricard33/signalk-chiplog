# Changelog

All notable changes to Chiplog are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **Heading changes are logged automatically.** A turn of 30° or more (configurable), held steady for a minute above 2
  knots, is added to the timeline as the average heading it settled on. Can be turned off in settings.

- **The retrospective analysis can read the Signal K History API.** Instead of connecting to an InfluxDB 1.x database
  itself, Chiplog can now read whichever history provider the server has registered — signalk-to-influxdb2, QuestDB,
  TimescaleDB — with no database credentials to set. Pick it with **History source** in the settings; InfluxDB 1.x stays
  the default, so an existing installation is untouched.
- **Engine and sail segments are reconstructed from an InfluxDB 1.x history too.** The retrospective analysis read the
  engine RPMs but never listed the boat's engines, so a reconstructed passage carried no propulsion segment and no
  engine hours.

### Changed

- **`navigation.state` is followed whatever its source.** Chiplog no longer prefers signalk-autostate's value over
  another source of the same path: it uses the one Signal K resolves the path to. On a boat where the AIS transponder
  and signalk-autostate both publish it, which one wins is settled in the server's source priorities — that is also
  where a transponder left at "under way using engine" while moored is corrected.

## [2.6.0] - 2026-09-20

### Changed

- **The animation's date range is kept in the address.** Picking a period updates the page's URL, so reloading the page
  or sharing the link keeps the same dates.
- **The boat no longer disappears when a passage leaves from where the last one arrived.** There is then no camera move
  at all: the boat stays in the frame through the short rest and the next passage starts from it. It is still hidden
  while the camera flies between two different places.
- **The animation opens and closes on the whole navigation.** It starts on a view of everything that will be sailed,
  zooms down to the first position in two seconds, and after the last arrival pulls back out to the whole navigation in
  two seconds, the boat not drawn during either move: it appears where the sailing begins. The rest at the end of each
  passage is shortened to a beat (0.3 s at ×1), so the boat no longer stands still for a second or more between
  passages.

### Added

- **A 3D view of the animation.** The Animation page has a new _View_ switch: the same film, at the map's own scale and
  with north at the top, seen by a camera tilted down onto a 3D sailboat, with the map laid flat under it. The boat
  follows the general direction of the track rather than every sampled heading, yet turns with it at a tack or a
  headland, heels and trims its sails to the wind, rides the waves with a pitch and a light roll, and you can frame it
  closer or wider than the map and choose the boat's size. Load your own boat as a `.glb` file and it is used instead —
  with its sails trimmed to the wind too, if their nodes are named `Mainsail` and `Jib` (the README has a guide to
  preparing a model) — kept in that browser. **Export the video** films whichever view is showing (`-3d` in the file
  name). The 3D view needs WebGL 2 and is loaded only when asked for; without it, the map view is used. It adds three.js
  to the vendored libraries (about 600 KB, MIT).

## [2.5.1] - 2026-09-19

### Fixed

- The webapp icon now shows on the Signal K Webapps page. `signalk.appIcon` was `./public/icon.svg`, but the server
  builds the icon URL from the served `public/` folder (`/signalk-chiplog/public/icon.svg`, which does not exist); it is
  now `./icon.svg`, which the Webapps page and the App Store both resolve.

## [2.5.0] - 2026-09-18

### Added

- **Import a PostgSail logbook.** `node scripts/import-postgsail.js <trips.geojson> --url <server>` reads PostgSail's
  GeoJSON export and adds each trip as a passage — track, wind, engine and sail periods, place names, fuel level, house
  battery, instrument snapshots — through the API, so the logbook can be on the boat's server. It is safe to run again:
  a passage already on record is skipped. The route it uses, `POST /entries` (administrator), adds any finished passage
  and answers `409 entry_overlaps` when it overlaps one on record. See the README's _Importing from PostgSail_.

## [2.4.0] - 2026-09-18

### Added

- **Previous and next passage links at the top of a passage page**, to step through the log without going back to it.
  `GET /entries/:id` gives them as `previousEntryId` and `nextEntryId`, in the log's order. Alt+← and Alt+→ do the same
  from the keyboard.
- **A Statistics page** sums the logbook up over a period: number of passages, first and last dates, total distance,
  time under way, top speed, strongest wind, the longest passage without a stop (a passage is cut at its stopovers, each
  stretch measured on its own), the flags of the countries visited, and the top 5 passages by duration, distance,
  average speed, top speed and wind. The period is a shortcut — all time, this month, last month, the last 12 months,
  this year, last year — or a range picked in a calendar with two clicks, the first and the last day. It reads
  `GET /statistics`.
- **One range picker for every date range** in the webapp: the Animation, Export and Retrospective pages use the same
  calendar — two clicks, the first and the last day — instead of a pair of date fields, so a range with its end before
  its start can no longer be entered.
- **Places now know their country** (`countryCode` on `GET /places`), from the same geocoding lookup that names them;
  places saved earlier, or added by hand, are asked about in the background once pending names are done. Database
  migration 16.

## [2.3.1] - 2026-09-18

### Added

- **Retrospective analysis now shows what has been reconstructed so far while it is still running**, not only once it
  finishes: passages, distance, engine/sail time, track points and events update after every committed slice instead of
  only the clock position. A run that fails partway — an InfluxDB query timing out on a slow host — keeps that same
  summary next to the error, instead of leaving a bare error message with no way to tell what was saved.
- **A retrospective replay retries an InfluxDB query that times out** up to 3 times, 5 seconds apart, instead of failing
  the whole run on what is often just a Raspberry Pi momentarily busy sharing its InfluxDB with Signal K itself; the
  webapp shows which attempt is under way while it waits. The timeout covers the whole round trip, including a chunk's
  JSON still streaming in after the connection answered, not just getting a connection in the first place. Each window
  of history is also fetched in smaller, two-hour chunks instead of six, so a slow host has less to answer per request.

### Fixed

- **A retrospective replay running alongside live tracking** could have a live detection tick, track sample or event
  check land on the passage the replay was reconstructing — mistaking it for the current one, since both read the same
  `active` row — and close it early or splice live position and instrument data into a past passage. Live detection,
  track sampling and event watching now pause for as long as a replay is running.

## [2.3.0] - 2026-09-18

### Added

- **InfluxDB query timeout** setting (`influxQueryTimeoutSeconds`, 30 s by default): how long a retrospective replay
  waits for the InfluxDB server to answer before giving up on it as unreachable or overloaded, now configurable instead
  of a fixed 30 seconds — useful against a Raspberry Pi that is simply slow to answer a six-hour chunk.

### Fixed

- **Retrospective replay backfilling a gap before passages already logged live** no longer dated every reconstructed
  passage to the most recent existing passage's end time. Detection's guard against an out-of-order departure looked at
  the latest `end_time` in the whole logbook rather than only at passages that actually preceded the new one, so filling
  in an earlier gap — installing Chiplog after the fact, or after a stop — pinned every reconstructed departure to that
  unrelated, later date, and the replay summary reported no passage found for the requested period even though entries
  had been created.

## [2.2.0] - 2026-09-18

### Added

- **Landmark bearings (amers)** — every position in the log is now also given the way a paper logbook gives one: a
  distance and a bearing from the nearest landmark, "2,3 M ENE (065°) — Phare de Chauveau", under the coordinates in a
  lighter grey, on the passage page and in the PDF logbook. The coordinates themselves are unchanged. Landmarks —
  lighthouses, capes, named towers, harbours — are fetched from OpenStreetMap area by area and kept, so past passages
  fill in as soon as their area is known and the same waters are never asked for twice; the bearing is computed when the
  page is drawn, never stored. The landmark quoted is the one closest relative to its own range, so a lighthouse three
  miles off wins over a marina alongside, and offshore the coordinates stay alone. A new setting, **Read each journal
  line against the nearest landmark**, turns it off.
- **Animation** — a new page that replays passages on the map. Pick a start and an end date and every passage between
  them plays in sequence, the time spent in port skipped, so a week's cruise takes seconds. The map follows the boat at
  a scale chosen for each passage — a short hop stays readable instead of being magnified, a long crossing gets a wider
  view without leaving the boat crawling across empty water — and a bubble on the chart shows the speed, the distance
  covered since the animation began and the date and hour. Play, pause, four speeds (×0,5, ×1, ×2, ×4 — an hour of
  sailing per second at ×1) and a slider over the animation's own time. A passage page links straight to it with its own
  dates filled in.
- **Save an animation as an MP4** — Mobile (9:16), Portrait (3:4), Square (1:1), Landscape (4:3) or Widescreen (16:9),
  encoded in the browser: nothing is uploaded, and the Signal K server renders nothing. Each frame's map is downloaded
  just before that frame is drawn, so the film is the same whatever the connection was doing and no range is ever too
  long to export. Needs a browser with WebCodecs (Chrome, Edge, Safari 17, Firefox 130 and later); without one the
  animation still plays on screen.
- **Delete an alarm** — a logged alarm can now be removed from a passage's log, like a crew-entered line already could.
  Deleting either the alarm or the line that later cleared it removes both, so no orphaned half is left behind.

## [2.1.0] - 2026-09-17

### Added

- Crew list: a per-passage roster of who is aboard, shown as a compact list on the tablet's main screen and editable
  from a dialog that picks from — and can extend — a global crew roster (name + optional role, e.g. skipper/crew),
  without an admin login the same way a place name can be corrected. A name typed there is added to the roster and
  picked at once, immediately correctable or permanently removable with its own icons, right alongside every other name.
  A new passage starts with the same crew as the one before it, still adjustable. Shown read-only, one member per line,
  in its own card on the webapp's passage page, and in the PDF logbook's departure line; included in the JSON export
  (`GET /entries/:id`'s `crew`, `GET /crew`, `PATCH`/`DELETE /crew/:id`, `PUT /entries/:id/crew`).
- Marine weather forecast: fetched near the departure position for the next 24 hours when a passage opens (Open-Meteo
  Forecast and Marine, free and keyless, can be turned off with its own setting), shown — titled with the departure
  place — on the passage page as a table every 3 hours (sky and rain, wind as a Beaufort force with direction, speed and
  gusts, waves, swell, pressure, visibility, air and sea temperature, and current), in a full-width block of its own
  above the day's table in the PDF logbook, and in the JSON export (`GET /entries/:id/weather`). Far from the sea, the
  atmospheric part is kept on its own.
- PDF logbook: the tide forecast's high and low times and heights, and the tanks and batteries noted as the passage
  opened, now print side by side in a block of their own, below the weather forecast and above the day's table.

### Changed

- A passage now closes as soon as the boat stops, instead of 30 minutes later: its arrival is named, its arrival reading
  taken and the USB copy written straight away. Leaving again within that tolerance reopens the same passage, the stop
  being kept on its timeline as a stopover line naming the place, as a merge does, followed by a departure line at the
  time the boat set off again — with its instrument reading, and in the PDF as "Departure from" the stopover's place. A
  passage closed from the webapp is never reopened. Casting off from the tablet within the tolerance of an arrival goes
  to the passage that just ended, which carries on once the boat moves. The "Stop duration that ends a passage" setting
  (`stopClosureMinutes`, unchanged) is now titled "Stop duration within which a new departure continues the passage".
- The "Tide service" setting is now titled "Marine service", since the weather forecast also reads the sea state and
  current from it. The setting itself (`tideUrl`) is unchanged.

### Fixed

- A new passage's tide and weather forecasts are fetched as soon as it opens, instead of up to a minute later — or up to
  an hour later when an earlier passage's fetch had kept failing while offline, since the retry delay carried over from
  one passage to the next.
- On a phone, the webapp no longer scrolls sideways: the top navigation wraps onto a second line when it does not fit,
  and the cards shown side by side on a wide screen (tide, engine and sail, boat status) now shrink to the screen width
  instead of staying 420 px wide.

## [2.0.0] - 2026-09-16

### Added

- The passage page has a **Boat status** card: each engine's hour counter, at departure and arrival, and every tank's
  level (and volume) and every battery's charge, voltage and current as noted at departure. Tanks and batteries are
  noted once on the passage as it opens (`startTanks`, `startBatteries`), whether detection or the crew opens it, and
  included in the JSON export.
- Merging two entries now keeps a record of the stop between them: a `stopover` line on the surviving passage's
  timeline, naming the place and its position — previously that information was silently lost once the merge took the
  later entry's arrival as its own.
- The passage page's track map now shows a small boat marker at the selected point, pointing along its heading, and a
  scrubber under the map to step back and forth through the track's history — it defaults to the latest point, doubling
  as the current position on a passage in progress. A band below it shows that point's time, SOG, COG, STW, TWS, TWD,
  TWA and AWA. Speed through water now rides along with every track point like wind and heading already did, not just
  the hourly instrument snapshot.
- Retrospective analysis: a new **Retrospective** page reconstructs past passages for a date range from a
  [signalk-to-influxdb](https://github.com/tkurki/signalk-to-influxdb) history (InfluxDB 1.x, local or remote — a new
  recommended companion plugin), through the exact same detection pipeline used live rather than a separate
  implementation. Runs in the background with a progress bar, refuses a range that overlaps a passage already on record,
  refuses to run at all while a passage is under way (it would be driving that same live passage through the replay's
  detector at the same time), and can be cancelled mid-way without losing what it already reconstructed. Data is matched
  to this server's own vessel identity by default, overridable (`influxSelfContext`) for running it from a different
  Signal K server than the one that wrote the history; a mismatch fails with the vessel contexts actually found, rather
  than reconstructing nothing with no explanation. An InfluxDB that never answers — unreachable, or overloaded — fails
  after 30 seconds with the actual connection problem, rather than hanging indefinitely on a generic "fetch failed". A
  quick first pass reads one mean speed per minute to find when the boat moved, and only those stretches are then
  fetched — one value per track interval — and replayed, committing once per ten simulated minutes, and the page sums up
  what a run added (passages, distance, engine and sail time, track points, events): a month now takes seconds rather
  than the best part of an hour, and no longer holds every raw reading of the range in memory. Requests stay bounded (a
  week for the scan, six hours for a stretch) with a short pause between them, so a multi-week reconstruction cannot
  overwhelm a database sharing a resource-constrained host (a Raspberry Pi) with Signal K itself; cancelling works at
  any stage. A replay wakes the place-naming lookup immediately once it finishes, rather than leaving
  newly-reconstructed departures and arrivals waiting out whatever backoff that chain was already in. Signal K alarms
  are not reconstructed, since a typical InfluxDB history does not archive notifications the way it does a numeric
  reading, nor are weather events while the boat lay still between passages, nor the extra track points live recording
  adds on turns and speed changes.

### Fixed

- The arrival instrument snapshot (`entry_end`) is now dated from the moment the passage actually ended, not from the
  later tick that found out about it once the stop had held past the closure threshold (up to `stopClosureMinutes`) — it
  could otherwise sort after an hourly reading taken during that wait, even though the passage had already ended before
  that reading was taken.

## [1.2.0] - 2026-09-15

### Added

- The tablet app's handwriting pad now fills the whole screen and has a toolbar: fine pen, thick pen, highlighter,
  eraser, undo and a choice of colour (kept to the theme's colour in night mode). The eraser removes only the points it
  touches, splitting a stroke instead of deleting all of it; undo now steps back through erasing too, not just strokes.
  A stroke's colour and tool travel with it to the webapp's timeline and the PDF export, not just the tablet.

### Fixed

- The tablet app's stylus canvas now prevents the default action on every contact, not just the pen's — a resting palm's
  touch was left to the browser, which could hijack it as a gesture and cancel the pen's in-progress stroke, or show a
  native text-selection highlight over the canvas. iOS Safari's long-press selection callout on the canvas needed the
  whole entry app, not just the canvas, to opt out of selection to reliably stay away, plus blocking
  `selectstart`/`contextmenu`/`dragstart` directly since the CSS alone is unreliable on some iOS versions.
- Quickly lifting and reapplying the pen could have its next stroke silently dropped: the previous contact's pointerup
  can arrive after the next one's pointerdown, which read as "still drawing" and refused to start the new stroke.
- Worked around an iPadOS Safari/Scribble bug that could swallow a pen's pointer events mid-stroke, dropping strokes or
  having them mistakenly typed into the comment field, by also preventing the canvas's underlying touch events directly,
  not just the pointer ones.
- An autopilot engagement, disengagement or mode change now takes an instrument snapshot like every other automatic
  event, instead of logging the change with no conditions attached.

## [1.1.0] - 2026-09-15

### Added

- A summary above the logbook's day-grouped list: number of passages, total distance and total time, across every
  passage logged rather than just the pages currently loaded (`GET /entries/stats`).
- Tide forecast: fetched near the departure position for the next 24 hours when a passage opens (Open-Meteo Marine, free
  and keyless, configurable and can be turned off), shown on the passage page with the departure's place, the date, time
  and height of each high/low tide, and the water height curve. Sits next to the engine/sail card, each taking about
  half the width on a wide screen instead of the full width. Heights are relative to mean sea level, not the chart datum
  nautical tide tables use, and the app says so (`datum: "msl"` in the API).
- Editing and deleting logbook lines from the webapp's passage page: any line's comment can be corrected, and a
  manoeuvre or note the crew logged themselves can be deleted (automatic lines — alarms, autopilot, weather, corrections
  — can only be annotated).
- Highest speed and wind seen on a passage, shown alongside the average speed on the passage page
  (`maxSpeed`/`maxWindSpeed` in the API). Wind (true and apparent) and heading now ride along with every track point,
  not just the hourly instrument snapshot, so a gust between snapshots is no longer missed.
- Automatic engine/sail switches now show as a line in the passage log, not just on the engine/sail strip, with the
  conditions at that moment (`propulsion_change` event).
- Facsimile PDF logbook: A4 landscape, a page per day in ship's time, with time, position, course, speed, wind,
  barometer, depth, engine or sail and remarks; departure and arrival lines with passage totals, day totals, handwritten
  notes drawn. Downloadable from the export page in the webapp's language and the device's time zone.
- Engine hours of every engine: each engine's hour counter is recorded in readings, shown at departure and arrival with
  the hours run on the passage page and in the PDF, and exported as one CSV column per engine and in the JSON
  (`engineRuntimes`).
- One PDF per passage in the USB copy, in the new logbook language and ship's time zone settings. Existing copies gain
  their PDFs at the next copy.
- Screenshots for the Signal K App Store listing (`signalk.screenshots` in `package.json`).

### Changed

- The tablet app's comment and delete actions on a recent entry are now icon buttons, keeping the same touch target
  size.
- Times are shown on the 24-hour clock in English too.

### Fixed

- The log reading in instrument snapshots now comes from `navigation.log` (the total, non-resettable distance log), not
  `navigation.trip.log`, which a crew resetting the trip counter could zero out mid-passage.
- Renaming a departure or arrival now also renames that place on every later passage that already reused it, as
  documented; an earlier passage keeps the name it recorded.
- An alarm's message is no longer repeated as its comment in the passage log.
- The arrival correction field no longer appears, and is refused by the API (`409 entry_active`), on a passage still in
  progress — it has no arrival yet, only a moving last-seen position.
- A note or handwritten sketch logged live now takes an instrument snapshot too, like a manoeuvre already did, so the
  conditions it was written in show in the log.
- The App Store icon (`signalk.appIcon`) pointed at a non-existent `icon.svg` at the package root; the icon has always
  lived at `public/icon.svg`.

## [1.0.0] - 2026-09-13

First release.

### Added

#### Logbook

- One logbook entry per passage, opened when the boat gets under way and closed when it arrives, with a configurable
  tolerance for short stops (30 minutes by default).
- Under way or stopped decided from `navigation.state` published by
  [signalk-autostate](https://github.com/meri-imperiumi/signalk-autostate), or from speed over ground averaged over 3
  minutes when it is absent. Departures and arrivals are dated from raw speed, so the passage starts where the boat
  actually left.
- signalk-autostate's value is preferred when another source, such as the boat's own AIS transponder, also publishes
  `navigation.state`. When detection works from speed alone, the apps say why.
- Passages closed at their last movement after a power cut; passages split by a long stop can be merged back.
- GPS track at a configurable interval (15 s by default), with extra points on turns and speed changes; distance from
  the track.
- Engine and sail periods from engine revolutions, engine state, `navigation.state` or a configurable default, with
  manual correction.
- Instrument readings at departure, every hour on the hour (configurable), at arrival and with each live manoeuvre.
- Automatic events: Signal K alarms and emergencies, autopilot changes, true wind crossing configurable thresholds,
  barometer falling over 3 hours.
- Departure and arrival names from known places, then online geocoding (any Nominatim-compatible service, can be turned
  off); a renamed place is remembered for later passages.

#### Logbook webapp

- Status bar, passages grouped by day, passage page with map (OpenStreetMap and OpenSeaMap), engine and sail periods,
  and the log of readings and events, handwritten notes included.
- Corrections: rename departure or arrival, switch an engine or sail period, close, merge and delete passages.
- Export of the whole logbook or a date range as JSON, CSV (nautical units) or GPX.
- English and French.

#### Tablet entry app

- Installable app at `/signalk-chiplog/entry/`, designed for gloves and wet fingers, with a red night mode.
- Manoeuvre shortcuts, with the sail picked on a sail change; casting off or weighing anchor opens the passage before
  the boat moves.
- Keyboard notes and stylus handwriting with pressure and palm rejection.
- Undo and comment right after each entry; latest entries with edit and delete.
- Entries kept on the tablet while the Wi-Fi is down and sent in order when it is back, never twice.
- Signal K device access requests when security is enabled; offline start-up over HTTPS.

#### Abandon-ship copy

- One JSON, CSV and GPX file per passage on a USB drive, named to sort by date, written only when new or changed, with
  obsolete files removed.
- Copied automatically every 15 minutes and at each arrival (both configurable), or on demand; a missing drive is
  reported in the plugin status and on the export page.

#### API and data

- REST API under `/plugins/signalk-chiplog/api`, documented in [docs/API.md](docs/API.md).
- Single SQLite database through Node's built-in `node:sqlite`: no native module to build.

[Unreleased]: https://github.com/ricard33/signalk-chiplog/compare/v2.6.0...HEAD
[2.6.0]: https://github.com/ricard33/signalk-chiplog/compare/v2.5.1...v2.6.0
[2.5.1]: https://github.com/ricard33/signalk-chiplog/compare/v2.5.0...v2.5.1
[2.5.0]: https://github.com/ricard33/signalk-chiplog/compare/v2.4.0...v2.5.0
[2.4.0]: https://github.com/ricard33/signalk-chiplog/compare/v2.3.1...v2.4.0
[2.3.1]: https://github.com/ricard33/signalk-chiplog/compare/v2.3.0...v2.3.1
[2.3.0]: https://github.com/ricard33/signalk-chiplog/compare/v2.2.0...v2.3.0
[2.2.0]: https://github.com/ricard33/signalk-chiplog/compare/v2.1.0...v2.2.0
[2.1.0]: https://github.com/ricard33/signalk-chiplog/compare/v2.0.0...v2.1.0
[2.0.0]: https://github.com/ricard33/signalk-chiplog/compare/v1.2.0...v2.0.0
[1.2.0]: https://github.com/ricard33/signalk-chiplog/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/ricard33/signalk-chiplog/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/ricard33/signalk-chiplog/releases/tag/v1.0.0

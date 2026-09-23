# Chiplog — Initial Specifications

Signal K plugin: automated digital logbook, with handwriting/keyboard entry on tablet.

Status: draft v0.2 — result of two scoping sessions; the structuring points (§7) are now settled.

## 1. Context and goal

Chiplog aims to replace the paper logbook with a Signal K plugin that:

- leverages data already available on the Signal K bus to automate entries (position, speed, engine/sail state,
  stopped/underway);
- allows fast manual entry (handwritten or keyboard annotations) for anything sensors can't infer;
- remains consultable and usable even if the vessel is lost (export/external sync).

Functional references: [meri-imperiumi/signalk-logbook](https://github.com/meri-imperiumi/signalk-logbook) (and its fork
johansolve/signalk-sailing-logbook) for the semi-automatic log model,
[@meri-imperiumi/signalk-autostate](https://github.com/meri-imperiumi/signalk-autostate) for navigation state detection.

**Reuse decision**: we draw inspiration from signalk-logbook's functional and data model, but write a fresh codebase
tailored to our specific needs (handwritten annotations, configurable navigation granularity, abandon-ship export). We
do not fork the existing repository.

## 2. Architecture principles adopted

- **Backend**: standard Signal K plugin (Node.js), subscribing to relevant SK deltas, managing the lifecycle of log
  entries, and exposing an HTTP (REST) API for the webapps.
- **Stopped/underway detection**: `signalk-autostate` as an **optional** dependency. If present and active, Chiplog
  reads `navigation.state`. If absent, a minimal internal fallback (configurable SOG speed threshold) takes over in
  degraded mode, with a UI indicator flagging that detection is running in simplified mode.
- **Engine/sail detection**: automatic, based on `propulsion.*.state`/`revolutions` and `navigation.state`/`sailing`
  (depending on what autostate exposes), with the option to manually correct an entry afterwards.
- **User interfaces** (two distinct surfaces):
  - **Standard Signal K webapp**: log consultation, plugin configuration, export. Implemented in `public/`, served by
    Signal K at `/signalk-chiplog/`: day-grouped log, passage page (map, engine/sail strip, logbook lines with a comment
    edit and, for the crew's own manoeuvres and notes, delete), corrections (place names, engine/sail, close, merge,
    delete) and export (downloads, USB write). Plugin configuration stays in the Signal K admin, which the webapp links
    to.
  - **Dedicated, installable PWA, tablet/stylus-oriented**: real-time field entry (handwritten annotations, manoeuvre
    shortcuts), designed for use at the helm, with gloves or wet fingers. Implemented in `public/entry/`, served at
    `/signalk-chiplog/entry/`: manoeuvre pad (with the sail picked on a sail change), keyboard notes, a stylus canvas,
    the latest entries with delete and comment, undo and comment right after each entry, a night mode, and an offline
    queue (§4.9).
- **Storage**: a single **SQLite** database in the plugin's data folder, covering entries, events, GPS track, and
  annotations (including vectorized handwritten strokes), accessed through Node's built-in `node:sqlite` module. The GPS
  track remains exportable as GPX on demand (generated from the database, not stored as a separate file).
- **Instance scope**: one vessel per Signal K instance (standard usage for SK plugins) — no multi-profile/multi-fleet
  management in the data model.

## 3. Logbook model

### 3.1 Granularity of an entry ("passage")

A log entry corresponds to a start → underway → stop cycle, **with configurable tolerance for short stops**:

- A `stop_closure_threshold` parameter (`stopClosureMinutes`, 30 min by default, user-configurable) defines the stop
  duration below which we stay within the same entry (e.g. waiting at a lock, lunch anchorage).
- The entry is closed as soon as the vessel stops, so the logbook shows the arrival straight away. Getting under way
  again within the threshold reopens it, the stop being kept as a `stopover` event (§4.2); beyond the threshold, a new
  underway cycle triggers a new entry.
- Each entry carries: start date/time, end date/time, start/end position, **start/end place name** (see §4.8), distance
  covered, engine vs sail duration, GPS track.
- Manual concatenation of two entries is possible. The earlier entry's own end — the stop the merge is folding away —
  would otherwise leave no trace once overwritten by the later entry's end; it is kept as a `stopover` event on the
  surviving entry instead (§4.6), at that stop's position, dated no earlier than the entry's own arrival reading so it
  still follows it on the timeline rather than the raw, earlier moment detection dated the stop from.

### 3.2 Grouping by day

Grouping "by day" is a **display-time aggregation view** (an entry may span midnight on a long passage): the logbook
calendar/list groups entries by start date, and displays entries spanning multiple days visibly on each day concerned.

Above the day-grouped list, a summary line totals every entry, not just the pages loaded so far: number of passages,
total distance, total elapsed time (`GET /entries/stats`).

A passage page has links at the top to the previous and the next passage, in the log's order (start time, then id), so
the log can be walked without going back to the list; they come with the entry as `previousEntryId` and `nextEntryId`
(`GET /entries/:id`), and the end of the log leaves its own link dimmed. **Alt+←** and **Alt+→** do the same from the
keyboard, except while typing in a field; the key is taken even at either end of the log, where it does nothing, so the
browser's own Alt+← (back) does not fire instead.

### 3.3 Events within an entry

Within an entry in progress, a timestamped timeline of events is recorded:

- engine ↔ sail changes (automatic, with the option of manual correction);
- manoeuvres (see §4.3);
- free-form annotations (text or handwritten);
- automatic Signal K events (see §4.6).

### 3.4 Author / crew list

No notion of author per event/annotation in V1: the logbook is a single shared document for the vessel, and who logged a
given manoeuvre or note is not recorded. A **per-passage crew list** is, however, a V1 feature (§4.11) — the tablet's
main screen shows who is currently aboard, adjustable from a dialog that picks from, and extends, a global roster.
Per-event authorship and skipper/crew permissions remain deferred to a V2 if the need is confirmed in practice.

## 4. Detailed features

### 4.1 Boat track

- **Combined** sampling: a point at least every X seconds (configurable fixed interval, e.g. 10–30 s by default) **and**
  an additional point as soon as a significant heading or speed delta is detected (manoeuvres, tacks) — ensures a
  faithful track during dynamic phases without inflating volume in straight lines.

  As implemented (`lib/track-recorder.js`), position fixes are read once a second:
  - an **interval point** every `trackIntervalSeconds` (15 s by default), skipped until the vessel has moved 10 m, so a
    wait at a lock does not pile up identical points;
  - an extra point on a **course change of 15° or more** — only above 2 kn, since course over ground is noise at low
    speed — or a **speed change of 1 kn or more**, at most every 2 s.

- **Points belong to a moving passage.** They are held in memory while no passage is open or while the open one is
  stopped, and attached once it moves: detection dates a departure back to when the vessel left its berth, up to 20
  minutes before it opens the entry, so the held points make the track start there rather than a mile out. Up to 20
  minutes of points are held.
- **Wind and heading ride along with each point** (migration 6), and **speed through water** since migration 9: true and
  apparent wind speed/angle, heading and STW — the same readings `observations` takes hourly, but at the track's own
  resolution, so a figure like the highest wind speed seen on a passage reflects an actual gust rather than whatever an
  hourly sample happened to catch.
- **Distance** is the sum of the distances between consecutive track points, updated as points are recorded.
- Standard **GPX** export per entry or for a date range, generated on the fly from the SQLite database.
- **Interactive map embedded in the webapp** (track displayed on tile background), in addition to export — no delegation
  to freeboard-sk for display. A small boat marker sits at the selected point, pointing along its heading (falling back
  to course over ground); a scrubber under the map steps through the track's points, defaulting to the latest one so it
  doubles as the boat's current position on a passage in progress. A band below it shows that point's time, SOG, COG,
  STW, TWS, TWD, TWA and AWA — SI readings converted for display like everywhere else, TWA computed from TWD and heading
  rather than stored. That map stays a Leaflet view of one passage; replaying a range of passages as an animation is a
  separate surface with a renderer of its own (§4.12).

### 4.2 Engine/sail and stopped/underway detection

- Automatic engine/sail detection, logged with metadata (average RPM, duration); manual correction possible on an
  existing entry.

**Engine or sail** (implemented in `lib/propulsion-detector.js`, evaluated with passage detection):

- **Source, in order of trust.** Current `propulsion.*.revolutions` — any engine turning means engine, which covers
  twin-engine boats; otherwise current `propulsion.*.state` (`started`/`stopped`, as published by
  `signalk-alternator-engine-on`); otherwise `navigation.state` (`motoring`/`sailing`); otherwise the configured
  `defaultPropulsion` (`sail` by default, like signalk-autostate). Engine data is current for 2 minutes after it last
  changed. Engine off while under way counts as sail.
- **Segments only cover time under way.** A passage's first segment starts at its departure; a stop ends the current
  segment when the vessel stopped, and moving again starts a new one when it started moving — an engine idling at a lock
  is not motoring time. Engine plus sail duration is therefore time under way.
- **Durations are kept current** during a passage, the open segment counting up to now.
- **Average RPM** is kept for engine segments, over the running engines.
- **Corrections hold.** A manual correction of the ongoing segment lasts until the engine data actually changes, so a
  boat whose sensors keep reporting the old value — or that has none — keeps the correction rather than reverting on the
  next cycle. After a restart, an automatic segment that disagrees with the engine is split.
- **An automatic switch shows in the log.** A `propulsion_change` event is logged at each actual sensed transition, the
  same way a manual correction is above, so the journal reads "under way under engine"/"under way under sail" where it
  happened, not just the engine/sail strip. Not logged for the passage's first segment, nor for the resync a restart
  does when it finds the engine disagreeing with an automatic segment — neither is something that happened at that
  moment.

**Stopped/underway and passages** (implemented in `lib/detection.js`), evaluated every 15 seconds:

- **Decision.** `navigation.state` decides, when it is current and a recognised value: `moored`, `anchored`, `aground`
  and `not-under-way` mean stopped; `sailing`, `motoring` and the working statuses (fishing, towing…) mean under way.
  Otherwise the **speed fallback** decides: speed over ground averaged over 3 minutes, under way above the configured
  speed (1 kn by default) and stopped below half of it. Averaging keeps a boat swinging at anchor from starting a
  passage; the gap between the two thresholds keeps it from flickering.
- **Several sources of navigation.state.** An AIS class A transponder also reports the boat's own navigational status —
  often left undefined (`default`), or at "under way using engine" while moored — and Signal K shows whichever source
  updated last. Chiplog follows that answer whatever the source. Settling which source wins is the server's business,
  through its source priorities: that is where a transponder left at "under way using engine" is corrected, by giving
  signalk-autostate priority over it, rather than through a preference wired into the plugin. When detection falls back
  to speed, the apps say why: no `navigation.state`, a source that has not decided yet, a value not updated for 20
  minutes (with its source and time), or a value Chiplog does not use (with its source).
- **Dating and placing transitions.** signalk-autostate works from distance covered over a window, so it announces a
  departure several minutes late, when the boat has already left the harbour. Whatever decided, the departure is dated
  when raw speed first left standstill and placed where the vessel was last still; an arrival is dated when raw speed
  first dropped to standstill. This is what makes departure and arrival positions fall within a known place's radius
  (§4.8), which is filled in automatically.
- **Arrivals and short stops.** A stop closes the passage at once, with the end time and position set to when and where
  the vessel stopped — the arrival name, the arrival reading and the USB copy follow straight away, rather than once a
  tolerance has run out. Getting under way again less than `stopClosureMinutes` (30 by default) after that end reopens
  the same passage instead of opening a new one: its end is cleared, and the stop is kept on its timeline as a
  `stopover` event at that place, like the stop a merge folds away (§3.1); the arrival reading taken then stays too, and
  a departure reading is taken as when a passage opens, dated from when the vessel set off again — the webapp shows it
  as a "Departure" line and the PDF as "Departure from" the stopover's place. Only a passage detection closed is
  reopened — the crew closing one confirms the arrival (`closed_by`). The departure is dated from raw speed as usual,
  and the new engine/sail segment starts then.
- **Only a transition opens or reopens a passage** — or the crew casting off (§4.3). An entry closed by hand while the
  boat is still moving is not reopened; the next real departure opens the next one.
- **Stale data.** A value counts as current while its timestamp keeps changing — measured by the plugin's own clock
  rather than by comparing timestamps to it, since a Raspberry Pi without a real-time clock can boot with the wrong
  date. Without current data, detection neither opens nor ends a passage.
- **Restarts.** While under way, the entry records its last movement about once a minute. If the plugin starts to find a
  passage open with no movement for longer than the tolerance — typically power switched off on arrival — the passage is
  closed at that last movement, with no arrival reading. A restart shorter than the tolerance carries on with the same
  passage; a longer one mid-passage splits it, which the manual merge (§3.1) repairs.

Known limitation: timestamps written to the logbook come from the host's clock, so a host whose clock is wrong records
wrong times. Keep the clock set from GPS (e.g. with the `signalk-set-system-time` plugin).

### 4.3 Manoeuvre shortcuts

- Approach adopted: **predefined + extensible list**.
- Base list to be defined precisely but should cover at minimum: tacking, gybing, reefing in/out, sail change (with
  selection of the sail hoisted), anchoring (anchored/weighed), mooring/casting off, watch change.
- Each shortcut logs a timestamped event + position in the current entry; the user can add an optional comment right
  after, or undo it.
- **Departure manoeuvres open the passage.** Casting off or weighing anchor with no passage open opens one at that
  moment — the crew knows it is leaving before the boat moves. The passage starts stopped: detection carries it on when
  the vessel gets under way, and closes it at the cast-off if it has not moved within the tolerance
  (`stopClosureMinutes`). Undoing that manoeuvre before the vessel moves removes the passage.
- **Casting off soon after arriving** goes to the passage that just ended, when detection closed it less than the
  tolerance before: that passage is the one the departure will reopen (§4.2), and moving within the tolerance of the
  cast-off reopens it even if that is later than the tolerance after the arrival. If the vessel does not move, the
  passage stays closed with the manoeuvre on it; undoing the manoeuvre only removes the event.
- **Entries without an open passage.** Other manoeuvres and notes go to the last passage while the vessel is within 1 nm
  of its arrival, like automatic events (§4.6); otherwise they are refused, with a message asking to cast off first.
- A sail change records the sail hoisted: main, genoa, jib, staysail, spinnaker, gennaker, code 0, storm jib, or a name
  typed in.
- The user can add their own shortcuts (name, icon, category) in V2 if not a priority for the MVP.

### 4.4 Handwritten and keyboard annotations

- Keyboard entry: free-text field, timestamped, attached to the current entry (or to a specific event).
- Handwritten entry: canvas on the tablet PWA, stylus capture, full-screen while it is the active tab.
  - **Format adopted: vector** (sequence of strokes, each stroke being a list of timestamped points with pressure/width,
    plus the colour and tool it was drawn with). Allows lossless replay and resizing, and lightweight export. Image
    rendering (PNG) is still generated on demand for PDF/preview.
  - Implemented in the tablet PWA: pointer events at the device's full rate, pressure from a pen, a toolbar (fine pen,
    thick pen, highlighter, eraser, undo, colour), and palm rejection — once a pen has touched the canvas, fingers are
    ignored. Points are in canvas pixels with the canvas size stored alongside. The eraser removes only the points it
    actually touches, splitting a stroke in two rather than deleting all of it; undo restores the state before the last
    stroke or eraser gesture, whichever came last. A stroke's colour and width (and `tool: "highlighter"` for its
    transparency) travel with it end to end — drawn the same way in the webapp's timeline and the PDF, not just on the
    tablet.
- Both annotation types appear in the entry's timeline, timestamped and geolocated.

### 4.5 Backup / continuity in case of abandoning ship

Two complementary mechanisms adopted for V1:

1. **Automatic export to USB drive** (PDF, CSV, JSON, GPX) — **configurable** write frequency (e.g. every X minutes, or
   on each entry closure). Requires a USB drive to be permanently plugged into the Signal K host.
   - The copy holds **one file per format per passage**, named `2026-09-13_0612Z_La-Rochelle_Les-Sables-d-Olonne.json`
     so that sorting by name sorts by departure, in a `chiplog/` subdirectory. Each export writes only new or changed
     passages — a USB drive is slow and wears — and removes the files of passages deleted, merged or renamed. Written
     automatically every `usbExportIntervalMinutes` (15 by default; 0 turns it off) and at each arrival
     (`usbExportOnArrival`, on by default), and on demand from the webapp. A missing drive is logged once, shown in the
     plugin status and on the export page, and the copy resumes when it is back.
   - The PDF follows a **traditional logbook facsimile** layout, delivered in V1.1:
     - A4 landscape, a page per day (continued on further pages when full), in ship's time: the webapp's download uses
       the browser's time zone and language, the USB copy the plugin's `logbookTimeZone` (the server's by default) and
       `logbookLanguage`. The time zone and its UTC offset are printed on every page.
     - Columns: time, position, course (or heading), speed over ground, wind (true, else apparent), barometer, depth,
       engine or sail, remarks. Departure and arrival lines carry their instrument snapshot, place, distance, duration
       and engine/sail times; a passage crossing midnight is announced at the top of the next day; each day ends with
       its distance and engine/sail times.
     - Remarks say what the webapp says (manoeuvres with the sail, notes, alarms, autopilot, weather, corrections), from
       the same modules; handwritten notes are drawn from their strokes.
     - Generated without dependency: the standard PDF Helvetica fonts, whose WinAnsi encoding covers English and French.
2. **Automatic publication to a remote server** — target undefined for V1, designed as a **generic extension point**
   (user-configurable webhook/API), with no fixed integration to a particular service.

### 4.5.1 Instrument snapshots

The logbook lines the facsimile PDF renders — and the CSV export already lists — come from instrument snapshots
(`observations`; see [DATA_MODEL.md](DATA_MODEL.md) for the readings recorded). During a passage one is taken:

- **at departure**, when detection opens the entry — and again when a quick departure reopens it (§4.2), dated from that
  departure;
- **on each clock boundary** of `observationIntervalMinutes` — on the hour by default, as on a paper log — as long as
  the entry is open;
- **at arrival**, dated from the actual end of the passage (dated from raw speed, so a little before the tick that
  closes the entry) — except when the passage is closed at start-up, typically after a power cut, since conditions then
  say nothing about that arrival. A passage reopened by a quick departure keeps that reading, followed by its stopover;
- **with each manoeuvre, note or sketch** the crew logs as it happens, so the reef appears with the wind that called for
  it and a note with the conditions when it was written. One logged with an explicit past time — replayed from the
  tablet's offline queue — gets no snapshot: current readings say nothing about a moment already gone by.

A snapshot already in a periodic slot, such as one taken for a manoeuvre, stands in for the periodic one.

As a passage opens, the boat's state is noted on the passage itself (`log_entries`), as a skipper does before casting
off — once, not with the readings along the way: every tank that publishes a level or volume (`tanks.<type>.<id>`), and
every battery (`electrical.batteries.<id>`: state of charge, voltage, current, temperature). Detection notes it when it
opens the passage; for a passage the crew opens by casting off on the tablet, it is noted as that manoeuvre is logged —
live only, like snapshots. The passage page shows it in a **Boat status** card alongside the engine hours. A tank level
is kept like a counter, whatever its age, since many senders only publish when it moves; battery readings must be
current within 15 minutes. The PDF prints it in a block of its own, next to the tide forecast (§4.5.2); the CSV does not
carry it yet — the JSON export does.

Engine hours are recorded for every engine that publishes an hour counter (`propulsion.<id>.runTime`), so a twin-engine
boat logs both. The passage page and the PDF show each engine's counter at departure and at arrival — the latest reading
for a passage in progress — and the hours run in between; the CSV has a column per engine. Sensors are followed on every
detection cycle, not only when a snapshot is due, so a sensor that died during the hour is recognised as such.

### 4.5.2 Tide forecast

When a passage opens, the plugin fetches the predicted water height near the departure position for the next 24 hours,
and shows it on the passage page: the departure's place name, the high/low tide times and heights, and the height curve.

As implemented (`lib/tide-forecaster.js`):

- **Source.** [Open-Meteo Marine](https://open-meteo.com/en/docs/marine-weather-api) (`sea_level_height_msl`), free and
  keyless under CC BY 4.0 — no per-vessel account or cost, like the Nominatim geocoding service. `tidesEnabled` turns it
  off; `tideUrl` points at a self-hosted Open-Meteo instance instead of the public one, mirroring `geocodingUrl`.
- **Relative to mean sea level, not a chart datum.** `sea_level_height_msl` is referenced to global MSL; nautical tide
  tables (SHOM and similar) reference "hauteur d'eau" to the lowest astronomical tide instead, which can differ by
  several metres and is not something a day of readings can derive. The API and the webapp say so plainly
  (`datum: "msl"`, a note under the chart) rather than presenting a height that looks charted but is not. Times of high
  and low tide are unaffected — a vertical offset does not move them.
- **One fetch per passage, at departure**, not a continuous subscription: the position and the 24 h window are fixed at
  that moment. Requested and stored in one call — no separate lookup for extremes; a high or low is a local peak or
  trough in the stored hourly curve, found when displayed rather than by asking the service twice.
- **Offline is normal, as for geocoding**: a failed request is retried after 5 minutes, doubling up to an hour, for as
  long as the departure is still recent enough for a fetch to mean anything (3 hours); past that, or once the service
  answers with nothing usable for the position (an inland lake, a river far from tidal water), no forecast is recorded
  and none is asked for again for that passage.
- **Hourly resolution**, so a high or low tide time is accurate to within about half an hour — adequate for a logbook
  reference, not for a lock or a bar crossing planned to the minute.
- **Shared fetch engine** with the weather forecast (§4.5.3): `lib/departure-forecast.js` holds the pending-entry
  selection, retry schedule, give-up age and 24 h window for both, and `lib/background-schedule.js` runs each as its own
  chain of timeouts.
- **Fetched as the passage opens**: detection wakes both chains as soon as it sees a new open passage, whatever they
  were waiting for — the minute between idle checks, or a retry delay. The retry delay starts again from 5 minutes for
  each passage, and once nothing is left to fetch, rather than carrying over from an earlier one given up on.
- **PDF**: the extremes found in the fetched curve, one line per high or low, in a block beside the boat's status (tanks
  and batteries, §4.5.1) — the two side by side, above the day's table, below the weather block. No curve: the PDF has
  no room for it.

### 4.5.3 Marine weather forecast

When a passage opens, the plugin also fetches the marine weather forecast near the departure position for the next 24
hours, as a skipper notes the bulletin before casting off, and shows it on the passage page and in the PDF.

As implemented (`lib/weather-forecaster.js`, on the same engine and schedule as the tide — one fetch per passage at
departure, retried while offline for up to 3 hours after departure, then given up):

- **Source.** Open-Meteo, free and keyless under CC BY 4.0, in two requests: the
  [Forecast API](https://open-meteo.com/en/docs) (`weatherUrl`) for the atmosphere, and the Marine API — the same
  service as the tide (`tideUrl`, titled "Marine service" in the settings) — for the sea. `weatherEnabled` turns the
  whole forecast off, independently of the tide.
- **Content**, hourly: wind speed, direction and gusts at 10 m; sky (WMO weather code), precipitation, cloud cover,
  visibility, pressure at sea level, air temperature; significant wave height, period and direction; swell height,
  period and direction; sea surface temperature; surface current speed and direction. Stored in SI units like everything
  else, converted from the units each answer declares rather than those asked for (the Marine API gives the current in
  km/h whatever `wind_speed_unit` says).
- **Directions keep the usual conventions**: wind, waves and swell are where they come _from_, the current where it
  flows _towards_ — as in Signal K. The passage page says so.
- **The sea is a complement.** Far from the sea (a lake, a river) or when only the Marine request fails, the forecast is
  kept with the atmosphere alone; the passage page leaves out the columns it has nothing for. Only a Forecast request
  that fails for lack of network, rate limiting or a server error is retried; when neither service has anything, an
  empty forecast is recorded and not asked for again.
- **Display: a row every 3 hours**, like a coastal bulletin — eight rows for the 24 h. A row shows its first hour's
  readings, with the strongest gust, the rain summed and the most significant sky over its three hours, so a squall
  between two rows is not lost. Wind is shown as a Beaufort force as well as in knots; a thunderstorm or a force 7 or
  more stands out.
- **PDF**: the same eight steps, as a block of its own spanning the full page width above the day's table of events and
  observations — not one of its rows — titled with the place the forecast was fetched near (the departure place, known
  or pending). The passage page's title carries the same place.

### 4.6 Automatically logged Signal K events

In addition to engine/sail and manual manoeuvres, the log automatically captures:

- **critical SK notifications** (`alarm`/`emergency` levels: MOB, engine alarm, anchor watch triggered, etc.);
- **autopilot state changes** (engaged/disengaged);
- **configurable weather threshold crossings** (e.g. wind > X knots), to automatically trace the conditions that
  prompted a manoeuvre.

As implemented (`lib/event-watcher.js`, checked every second):

- **Notifications.** Any Signal K notification reaching `alarm` or `emergency` is critical, whatever its path — no list
  of paths to maintain, and an alarm from a plugin nobody anticipated is still logged. The log records it when raised
  (with an instrument snapshot), on escalation, and when it clears or disappears. `warn` and `alert` are not logged.
  After a restart, the log itself says what was already recorded: an alarm still open is not repeated, and one that
  cleared meanwhile is closed. Unlike the other automatic lines, an alarm can be deleted from the webapp: deleting
  either the raise or the clearing takes its pair with it, so a false alarm leaves no orphan line (an escalation is not
  a pair and is unaffected).
- **Autopilot.** Engagement, disengagement, and mode changes while engaged, from `steering.autopilot.engaged` and
  `.mode` (the server's Autopilot API) or, for older autopilot plugins, `steering.autopilot.state` (`standby` meaning
  disengaged), each with an instrument snapshot. The target heading or wind angle goes with it. Only during a passage:
  an autopilot tried at the dock is not logbook material. Autopilot alarms arrive as notifications.
- **Wind thresholds.** True wind speed averaged over two minutes, so a gust does not count, logged when it rises above
  each configured threshold (`windSpeedThresholds`, 20 and 30 kn by default) and when it falls back below it, with
  hysteresis (2 kn or 10 %, whichever is larger). The first reading after start-up only sets where the wind stands: a
  gale already blowing is a condition, not a crossing.
- **Barometric drop.** A fall of `pressureDropThreshold` (4 hPa by default, 0 to disable) over three hours, logged once,
  and again only after the fall has eased to half that. The three hours of history are held in memory, so the check
  needs three hours after a restart.
- **Heading changes**, toggled by `headingChangeEnabled` (on by default). A change of at least `headingChangeThreshold`
  (30° by default) from the last logged heading, held within `headingChangeTolerance` (10°) of its own average for at
  least `headingChangeHoldSeconds` (60 s), is logged with that average as the new heading; below `headingChangeMinSpeed`
  (2 kn) course over ground is too noisy to start or continue building one. A change confirmed less than
  `headingChangeCooldownMinutes` (5 min) after the last one logged still moves the reference heading forward, so the
  next change is measured from it, but is not itself written to the log. True heading, or magnetic corrected by
  `navigation.magneticVariation` without it.

**Which passage an event belongs to.** The open one. Between passages, alarms and weather events go to the last passage
if the vessel is still within a nautical mile of where it ended: an anchor dragging overnight belongs to the passage
that brought the boat to that anchorage, and appears after its arrival. Further away, with no passage to hold them, they
are not logged.

### 4.7 Reading Signal K data

- Subscription to relevant paths (position, speed, heading, wind, propulsion, navigation state) via the SK server's
  standard subscription mechanism.
- The plugin must tolerate the absence of certain data (e.g. no wind sensor) without blocking the creation/operation of
  an entry.

### 4.8 Place names (departure / arrival)

When creating and closing an entry, Chiplog attempts to associate a **place name** with the departure position and the
arrival position (only these two points — no naming along the track):

1. **Local lookup first**: the plugin checks whether the position falls within the radius of an already-known place
   (created automatically or manually corrected during a previous passage). If so, its name is reused directly, with no
   network call.
2. **Otherwise, online reverse geocoding** (e.g. Nominatim/OpenStreetMap) if a connection is available: the returned
   name is proposed as a default value, editable before confirmation.
3. **If neither works** (no known place nearby, no connection): a name generated from the coordinates is used by default
   (e.g. "46.1234N 1.5678W"), pending manual correction.

**Matching radius**: a single global configurable parameter in the plugin settings (e.g. 200 m by default), applied to
all registered places — no per-place setting in V1.

**Remembering corrections**: as soon as the user edits the proposed name (whether it came from online geocoding or the
coordinate-generated name), the correction is stored as a **known place** (name + position) and will automatically be
reused for any future departure/arrival position falling within the configured radius — with no further call to the
online service. It also renames that place on any entry already logged that reused it and is timestamped later than the
one being corrected, so the log does not go on showing a name now known to be wrong; an entry timestamped earlier keeps
the name it recorded.

**As implemented** (`lib/place-names.js`):

- **Steps 1 and 3 happen at once, step 2 later.** Detection cannot wait on the network — usually absent at sea — so a
  departure or arrival gets a known place's name immediately or, failing that, a name from its coordinates flagged as
  _pending_. A background queue then looks pending names up online, newest passage first.
- **The service** is any Nominatim-compatible endpoint (`geocodingUrl`), the public OpenStreetMap instance by default.
  `geocodingEnabled` turns lookups off for privacy; pending names then keep their coordinates until corrected, and are
  looked up if it is turned back on. Its usage policy is respected: an identifying `User-Agent`, at most one request
  every 2 seconds, and a handful of requests per passage.
- **Offline is normal.** A failed request keeps the name pending and retries after 5 minutes, doubling up to an hour, so
  names fill in once the boat is back in range.
- **Choosing the name.** Near a marina Nominatim answers with the quay's road, and at sea with a bare administrative
  boundary; neither is a logbook place name. The name is the settlement with its district when there is one — "La
  Rochelle (Les Minimes)" — or a marina's or harbour's own name when that is what was found. No settlement at all is a
  final answer: the coordinates stay, and the position is not asked about again.
- **The places table is the cache.** Each geocoded name becomes a place with `source: geocoding`, so the next departure
  or arrival within the radius is named from it with no request — and a crew correction of that name (`source: manual`)
  wins from then on.
- **A lookup never overrides the crew.** A result is written only if the name is still pending _for the position that
  was looked up_: a name typed or removed, or a position corrected, while the request was out stays as the crew left it.
- **The country comes with the place** (§4.14). A geocoded name is stored with the country Nominatim reports for it, as
  an ISO 3166-1 alpha-2 code. A place with none — added by hand, or saved before countries were recorded — is asked
  about in the background once the pending names are done, at country level, and marked as checked whether or not there
  was an answer, so open water is not asked about forever. A country belongs to the place, not to each passage: unlike a
  name it is not copied onto the entry, and deleting a place takes it away from the passages that used it.
- **Attribution.** Names from the public instance are OpenStreetMap data (© OpenStreetMap contributors, ODbL); a UI
  displaying them must say so.

### 4.9 Tablet entry and the boat's network

- **Offline queue.** An entry the server cannot take — no Wi-Fi, server or plugin down, access not granted yet — is kept
  on the tablet with the time it was made, corrected by the server's clock, and sent in order once the server answers
  again. Each carries an identifier, so one that reached the server before the connection dropped is not logged twice.
  Its position is the track's at that time. An entry the server refuses on replay (e.g. no passage to attach it to) is
  set aside and shown, to discard.
- **Access.** With Signal K security on, logging needs read/write access. The tablet uses Signal K's device access
  requests: it asks once, an administrator approves it in the Signal K admin, and the tablet keeps the token. Signing in
  with a user account also works.
- **Installing and starting offline** use a service worker, which browsers only allow over HTTPS (or on localhost). Over
  plain HTTP — the usual boat set-up — the app works and queues entries, but needs the server to load. Signal K's own
  SSL setting provides HTTPS.
- The list of manoeuvre shortcuts is remembered on the tablet, so an app started offline has its buttons.

### 4.10 Retrospective analysis

Reconstructs passages Chiplog never saw live — installed after the fact, or stopped for a while — from a history the
boat already keeps. Two sources, picked in the configuration (`retrospectiveHistorySource`):

- **The Signal K History API** (`lib/history-api.js`), reading whichever provider the server has registered —
  signalk-to-influxdb2, QuestDB, TimescaleDB. It asks for Signal K paths and gets Signal K values back, so it needs no
  database credentials and knows no storage schema. The better choice on a new installation.
- **InfluxDB 1.x read directly** (`lib/influx-history.js`), from a database
  [signalk-to-influxdb](https://github.com/tkurki/signalk-to-influxdb) wrote (a recommended companion plugin, not a
  dependency). Kept as the default so installations already set up this way go on working untouched.

Everything below holds for both: only fetching differs, and what the two share — holding a window in memory, answering
it back as `app.getSelfPath` would have, working out when the vessel was moving — lives in `lib/history-series.js`, so a
reconstruction is the same passage whichever source it came from.

- **Same pipeline as live, not a re-implementation.** `lib/replay.js` drives the exact detection, propulsion,
  observation, track recording and event watching modules used every 15 seconds live (§4.2, §4.5.1), but by a virtual
  clock stepping through the requested past range as fast as the database allows, fed by historical values instead of
  the server's current ones. A passage it produces is one Chiplog would have logged had it been running at the time —
  the same thresholds, the same freshness rules, no separate "historical" logic to keep in sync.
- **Only where the vessel moved.** A light first pass (`"scanning"` in `GET /replay`) reads the whole range as one mean
  speed over ground per minute, plus `navigation.state` whatever its source, and keeps the stretches where the vessel
  may have been under way: a minute whose mean speed reaches half the fallback under-way speed (deliberately generous —
  replaying too much only costs time), or an under-way `navigation.state`, until the next state from any source or until
  it would have gone stale (20 min). Each stretch is widened by 30 minutes before (detection dates a departure from up
  to 20 minutes of raw speeds) and by the stop-closure delay plus 25 minutes after (a waiting cast-off passage's closure
  and its late margin, autostate's lag); overlapping ones merge into a window. Only windows are loaded and replayed
  (`"replaying"`), each as if the plugin had been started at its beginning; a passage still open when its window ends is
  followed six hours further at a time until it closes. Weeks in port therefore cost next to nothing — the approach
  [signalk-sailing-logbook](https://github.com/johansolve/signalk-sailing-logbook) takes, without its separate detector.
  Stepping every second through the whole range, loading every raw reading, made a month take the best part of an hour
  and more memory than a Raspberry Pi has.
- **At the track interval, not every second.** A window's history is loaded as the last value of each
  `trackIntervalSeconds` bucket (bounded to 1–60 s), dated at the bucket's end so the replay never sees a reading before
  it was published, and track sampling and event watching step at that interval (detection still ticks every 15 s). The
  extra track points live recording adds on turns and speed changes between two intervals are lost; manoeuvre precision
  is not what a reconstruction is for.
- **Commits once per slice.** The replay runs ten simulated minutes per database transaction (`withTransaction` calls
  made inside it join it), rather than committing — and syncing an SD card — for every detection tick and track point. A
  slice is synchronous, so live code never runs inside one.
- **Reports what has actually been committed, not just how far along the clock is.** `lib/replay-job.js` recomputes the
  running total (`{ passages, distance, engineDuration, sailDuration, trackPoints, events }`) after every slice, in
  `GET /replay`'s `progress.summary`, and attaches the same totals to `lastError` on a failure — an InfluxDB query
  timing out partway through a long range leaves the passages already committed on record either way (only the slice in
  flight is lost), so the webapp shows what was saved instead of a bare error with no way to tell.
- **Bounded requests, whichever source.** The motion scan asks for a week at a time; a window's history is fetched two
  hours at a time, with a short pause between requests, then answered from memory as fast as the replay loop asks, and
  dropped once the window is done — a boat's history often shares its Raspberry Pi with Signal K itself, and a
  fixed-size request keeps each answer small and gives the database room to recover between them. Reading a window is
  what a replay does thousands of times over, so the store answers a path by binary search rather than by scanning.
  `lib/influx-history.js` additionally knows signalk-to-influxdb's schema: one measurement per Signal K path, tagged
  with context (self) and source, `navigation.state` resolved the same way the server itself would (§4.2). The History
  API reader asks for `last` over each bucket, and for the scan's speed the `max` of each minute — a mean would average
  a minute of motion away and lose the departure with it. It asks for `navigation.position` in a request of its own: the
  InfluxDB 2 provider collates positions separately and refuses a result set of a different length.
- **Filtered to one vessel context** — the server's own by default, overridable (`influxSelfContext`) for running the
  replay from a different Signal K server than the one that wrote the history, e.g. development against a production
  database. Before fetching anything, the actual context values the history holds are checked against it —
  `SHOW TAG VALUES` for InfluxDB 1.x, `getContexts` for the History API: none matching fails with what was found instead
  of a replay that runs to completion and reconstructs nothing, silently.
- **Every query is bounded, 30 s by default (`influxQueryTimeoutSeconds`).** Node's `fetch` has no timeout of its own,
  so an unreachable or overloaded database would otherwise hang far longer than that for an error no clearer once it
  arrived — a bare "fetch failed" instead of the actual connection problem. The History API takes neither a timeout nor
  an abort signal, so its reader races every call against both: without that, a provider that never answers would hang
  the run with nothing to show for it, and cancelling would only take effect at the end of the chunk in flight.
- **A query that times out is retried up to 3 times, 5 seconds apart**, rather than failing the whole run on what is
  often just a Raspberry Pi momentarily busy sharing its history with Signal K itself. The timeout covers the whole
  round trip, reading the response body included, not just getting the connection to answer — a chunk's JSON can be slow
  to stream even once InfluxDB has accepted the request, and that counts the same as never answering at all. Each
  attempt gets the full timeout again, not whatever was left of a shared one. `GET /replay`'s `progress.retry` names the
  attempt under way while it waits, so the webapp can show it instead of the run looking stalled; giving up after the
  last retry surfaces the same message in `lastError` as before. Only a timeout is retried — a connection refused, an
  HTTP error or a malformed response fails outright, since trying again would not change the answer.
- **One reconstruction at a time**, run in the background from the webapp: `POST /replay` starts it and returns
  immediately, `GET /replay` reports progress (including which phase is in flight), `POST /replay/cancel` stops one in
  flight, fetching or replaying (`lib/replay-job.js`).
- **Refuses a range that overlaps a passage already on record**, rather than risking a duplicate or a conflicting one —
  reconstruction only ever adds passages, never merges into or edits an existing one.
- **Refuses to run while a passage is under way**, whatever the requested range: the replay drives the same detector,
  track recorder and event watcher as live detection, against the same database, so the two touching the open passage's
  row at once would corrupt it rather than merely disagree. The same hazard runs the other way while a replay is in
  progress — it holds its own reconstructed passage `active` in `log_entries` for however long the past window takes to
  close — so live detection, track sampling and event watching pause for the run's duration rather than mistake that row
  for the current passage and close it early or splice live data into it.
- **Known gaps, by what a typical InfluxDB history holds:**
  - Weather thresholds (§4.5) crossed while the vessel lay still outside any window — strong wind or a falling barometer
    at anchor after arrival — are not logged, and each window starts with the barometer's three-hour reference empty, as
    after a plugin restart.
  - Signal K notifications (alarms) usually are not archived as a time series the way a numeric reading is, so
    critical-notification events are not reconstructed.
  - True wind angle is derived from true wind direction and heading rather than read as its own path, since it needs no
    sensor of its own — the same as live.
  - The server's source priorities cannot be replayed: the history holds one row per source, not the value the server
    resolved, so a path published by several sources is replayed as whichever row came last — the server's own behaviour
    when no priority is configured (§4.2). A boat that set a priority to settle `navigation.state` will therefore see
    live detection and a reconstruction disagree.

### 4.11 Crew list

- **A global, editable roster** of crew members (name + optional role/function, both free text, e.g. "skipper", "crew"),
  extended and corrected without an admin login — the same reasoning as place-name corrections (§4.8): a crew member at
  the helm has to be able to fix or add a name.
- **Each passage records who is aboard**, picked from the roster from a dialog reachable from the tablet's main screen;
  the main screen itself shows a compact, non-editable list to save space.
- **Carried over.** A new passage — opened automatically or by casting off — starts with the same crew as the passage
  immediately before it, still adjustable from the dialog.
- **Visible read-only** on the consultation webapp's passage page and in the PDF logbook's departure line, alongside the
  place name.
- **Recorded as it stood at the time.** Correcting or deleting a roster member does not change what a past passage
  already recorded — the same denormalisation principle as a place name (§4.8, [DATA_MODEL.md](DATA_MODEL.md)).

### 4.12 Passage animation and video export

- **A page of its own, over a date range** (`#/animation`), reached from the main menu, plus a link from a passage page
  that arrives with that passage's days already filled in. **The range is kept in the address**
  (`#/animation?from=…&to=…`, updated in place as it is picked, without a history entry), so reloading the page or
  sharing the link lands on the same dates; playback is not, since every hash change scrolls the page to the top. A
  range is sized before anything is downloaded — the number of passages, the distance and the elapsed time come from
  `GET /entries/stats` — and the tracks are only fetched when the reader asks for them, a few at a time.
- **Every passage in the range, strung together.** Each passage is a _leg_; the time the boat spent in port is **not**
  played, so three days at a pontoon cost nothing. A leg is followed by a beat on its arrival — 0.3 s at x1, 0.5 s when
  the crew stopped for the night, so the boat never stands still for no reason — and, when the next passage leaves from
  somewhere else, an eased camera move into its framing, during which the boat is not drawn: it would be skating across
  the chart. When it leaves from where the last one arrived (within a nautical mile) there is nowhere to fly to, so
  there is **no camera move and the boat never leaves the frame**: the one beat of rest carries the boat and the camera
  the few yards to the next leg's first position, turning the boat to its heading and easing the zoom to that leg's own,
  so the leg starts without a jump. The boat is not sailing then — the clock and the trip meter stand still.
- **The film opens and closes on the whole navigation.** It starts with the camera framing every leg at once, fitted to
  the frame, and takes **2 s** (at x1) to come down onto the first position and to the passage's own zoom, where the
  sailing begins; when the last leg is done it takes another **2 s** to pull back out to the whole navigation, with
  every track drawn. The zoom is what moves evenly, and the centre is carried along so the place being zoomed towards
  stays in view as under a pinch instead of sliding across the frame. Nothing has been sailed during the opening, so no
  track is drawn then, and **the boat is not drawn during either move**: it appears where the sailing begins and goes
  once it is over. Either move is left out when the passage is already framed as wide as the whole navigation (a single
  short hop), since it would only be a pause.
- **A zoom per passage.** The camera follows the boat at a working scale — a reference box about 32 km across, fitted to
  82 % of the frame. A passage smaller than that is shown at the working scale rather than magnified, so a hop across a
  harbour does not dive to street level. A passage larger than it may pull the camera back towards framing the whole
  track, but by **at most one zoom level**: the camera is centred on the boat and not on the track, so backing off far
  enough to fit a whole crossing would leave the boat crawling across empty water. The approach comes from
  `signalk-sailing-logbook`, reimplemented independently and with that limit added.
- **Driven by time, not by points.** Track points are not evenly spaced (§4.1), so position and readings are
  interpolated at an arbitrary instant — linearly, and by the short way round the circle for angles. The slider is over
  the animation's own time, labelled with the real date and hour, since a range spans days.
- **One hour of sailing per second of animation** at x1, with x0.5, x1, x2 and x4. The timeline is built once in those
  seconds and the multiplier only decides how fast they are consumed, so changing speed mid-playback moves nothing.
- **A bubble on the chart** shows the boat's speed, the distance covered since the animation began — counted from the
  track with the same haversine the server uses, so it converges on the entry's own distance — and the date and time.
  The same figures sit under the map as text, for readers a canvas gives nothing.
- **Its own renderer, not Leaflet.** The animation projects, fetches its tiles and draws on a canvas. That is what lets
  the preview and the video come out of one code path, at any shape and resolution, and lets an export wait for each
  frame's tiles instead of filming whatever had arrived. Tiles are fetched with `fetch` then `createImageBitmap`, which
  yields a bitmap with no origin and so cannot taint the canvas.
- **Framed on the export's dimensions, always.** The zoom depends on the frame's pixel size, so the preview draws the
  chosen format's frame and scales it down; only the tile resolution follows the screen. Picking a format therefore
  changes what the preview shows, and what it shows is what gets encoded.
- **Everything in the browser.** No new API route, and nothing rendered or encoded on the Signal K server: the export
  uses WebCodecs for H.264 and a vendored Mediabunny for the container, loaded only when a video is actually exported.
  Five shapes — Mobile 9:16 (1080×1920), Portrait 3:4 (1080×1440), Square 1:1 (1080×1080), Landscape 4:3 (1440×1080) and
  Widescreen 16:9 (1920×1080) — at 30 fps. Without WebCodecs the export is hidden and the animation still plays.
- **Tiles arrive as the film needs them.** Each frame's map is loaded just before that frame is drawn, and the frames
  after it are asked for without waiting, so the downloads run while the encoder works — an export is never refused for
  being too long, it simply takes longer. The preview asks for the map a couple of animation seconds ahead of the boat,
  so the camera does not outrun it. Four requests at a time, and one cache shared between the preview and the export. A
  404 is final — a missing seamark tile is normal — while a busy server (429, any 5xx) or a dropped connection is tried
  again, since treating those as final would leave permanent holes no amount of scrubbing back would fill. Offline, the
  tracks are drawn on a blank sea, the same promise the Leaflet map already makes.
- **The map credit is burnt into every frame**, since the images leave the page.
- **A 3D view of the same film.** A switch on the page changes the renderer and nothing else: same date range, same
  player, same five formats, same MP4 export, the file name gaining `-3d`. **It frames the sea exactly as the map view
  does**: the camera has the map camera's target and zoom — the ground under the boat is at the same scale, worked out
  from the passage's zoom and the frame's height — and **north stays at the top**, whichever way the boat heads. It is
  simply tilted, 50° down, to look at the boat, which is a model drawn larger than life so it holds the same share of
  the frame at every zoom, in three sizes — large, medium and small, the smallest half the largest. Three camera
  settings: closer (half the distance), like the map (the default) and wider (twice). The ground is the same
  OpenStreetMap and OpenSeaMap tiles, from the same cache, as textures on the sea, faded into it by fog; offline it is a
  plain sea and the track, as in the map view. The track is a ribbon of constant thickness on screen, finishing exactly
  at the boat rather than at the last recorded point.
- **A frame is still a pure function of the film.** The camera is the map camera's, so between legs it flies as the map
  does, with half the tile resolution while it does. Nothing reads a clock or a previous frame. The boat is posed from
  readings **smoothed over the leg**, **but not across a turn**: its heading and the wind angle (on the circle) are
  averaged over about an hour of sailing around the instant, bell-shaped, counting only the readings that point within
  about 25° of the direction the boat has now (found from a three-minute average and settled by repeating the average
  around its own result). Wobbles of a few degrees are all alike and are averaged away, so at playback speed the boat
  does not shiver; the far side of a tack or a headland is not alike, is left out, and the boat turns when the track
  does, not before and not late, and is never dragged through the wind. Speed and wind strength get the plain average.
  Both windows are lengths of film, so it smooths as much at x4 as at x0.5. Its position is not smoothed. Heel, pitch
  and sail trim are not in the track and are derived: heel from the apparent and true wind (none without a wind reading,
  at most 22°, greatest on the wind and fading to nothing downwind), the sails let out as the wind comes aft and set on
  the side away from it, and a ride over waves — a pitch of a few degrees, a lighter roll either side of the heel and a
  slight rise and fall, from two swells whose periods do not divide each other so it never quite repeats, bigger the
  faster the boat goes and the windier it is, none at rest — made up, since the track knows nothing of the sea, as a
  function of film time so an export comes out the same however long it took. There is no simulated water level: the
  boat is drawn in a pass of its own after the map, with a fresh depth buffer, so the map can never hide any part of the
  hull however it heels, pitches or rises — the boat is always whole. The default boat is generated in code — no asset
  to ship or credit — and the reader may load a `.glb` of their own (bow towards +z, y up, scaled so its longest
  horizontal extent is one boat length, its lowest point a twentieth of that below the waterline), kept in that
  browser's IndexedDB and never sent to the logbook. **Its sails move like the default boat's** when their nodes are
  named for them — `Mainsail` (or `Main`, `Sail_Main`, `GrandVoile`, `GV`) and `Jib` (or `Genoa`, `Headsail`,
  `Foresail`, `Sail_Jib`, `Foc`, `Génois`), ignoring case, punctuation and a trailing copy number (`boat-parts.mjs`).
  Each is turned about the vertical axis through the origin of its node, added to the rotation it has at rest, by the
  wind-driven sail angle — the full angle for the mainsail, 0.8 of it for the headsail; only the outermost node of
  nested sails turns. The cloth is rigid (no billow), and nothing else in the model is animated. After loading, the page
  says which sails it recognised, so a misspelt name is not a silent failure. README, _Your own boat in the 3D
  animation_, is the authors' guide.
- **3D is loaded on demand and optional.** The engine is three.js, bundled at install time (`scripts/vendor.js`,
  esbuild) into one minified module of the few parts used and imported only when the 3D view is first asked for or
  exported. It needs WebGL 2; without it, or if the context is lost or fails to start, the page says so and returns to
  the map view.

### 4.13 Landmark bearings (amers)

Coordinates say where the boat was; they do not say what the crew could see. Every position the journal shows — each
reading, each event, the departure and the arrival — is therefore also given the traditional way, as a distance and a
bearing **from a landmark**: "2,0 M NE (053°) — Phare du Cap-Ferret" means the boat was two miles north-east of that
lighthouse. It is printed under the coordinates, in a lighter grey, on the passage page and in the PDF logbook; the
coordinates themselves stay as they are.

- **Landmarks come from OpenStreetMap**, through an Overpass endpoint (`overpassUrl`), and only the features a position
  is traditionally read against: lighthouses and major lights, capes, named seamark landmarks (towers, masts,
  monuments), minor lights, isolated-danger and safe-water beacons, harbours and marinas. The lateral and cardinal marks
  of a channel are deliberately left out — "6 c" or "L1" tells the reader nothing — as is anything unnamed.
- **Fetched by area, once, and kept.** The world is cut into half-degree cells; a cell is fetched with a margin as wide
  as the furthest an amer is quoted from, so every position inside it has all its landmarks. A passage is pending until
  every cell it sailed through has been fetched, newest passage first; an open passage stays pending, since it keeps
  moving into new cells. Offline is normal at sea, so a failed request is retried after 5 minutes, doubling up to an
  hour, and Overpass answering trouble in the body (HTTP 200 with a `remark`, or an HTML page) counts as a failure.
- **The bearing is worked out at read time**, never stored: a past passage fills in on its own as soon as its area is
  known, and nothing about a landmark belongs to the logbook's record.
- **Which amer a position is read against**: the one closest _relative to its own range_, so a lighthouse three miles
  off wins over a marina half a mile away. Each kind carries a range — 15 nm for a lighthouse, 8 for a landmark, 6 for a
  cape, 4 for a minor light, 3 for a harbour, 2 for a beacon — and a light's own nominal range narrows it when
  OpenStreetMap gives one. Nothing in range means no line at all: the open sea keeps its coordinates alone. Within 30 m,
  the name alone is shown — a bearing from the harbour you are moored in is noise.
- **The distance** reads in metres under a cable (rounded to 10 m) and in miles beyond, and the compass point is given
  to sixteenths (N, NNE, NE…) next to the bearing in degrees.
- **`landmarksEnabled` turns the whole thing off**, for privacy or to keep the boat off the network; the coordinates are
  then shown alone. Names are OpenStreetMap data (© OpenStreetMap contributors, ODbL) and the webapp says so.

### 4.14 Statistics

A page of its own (`#/statistics`, "Statistics" in the main menu) sums the logbook up over a period: `GET /statistics`.

- **The period** is a range of days, both included — the passages are matched on their start time, like the log, the
  export and the animation — with shortcuts for _all time_, _this month_, _last month_, _the last 12 months_, and this
  year and last year, labelled by their number. Beside them, a single range picker shows the period and opens a calendar
  to pick it with two clicks, the first and the last day, in whichever order, with the range shown as a band under the
  pointer before the second click; it moves by month and by year, and Escape or a click outside abandons a range
  half-picked. Picking a shortcut fills the picker, and picking a range there switches the highlighted shortcut off.
  Local days, so the page and the log agree on where a night falls. The calendar is our own, not a library: the webapp
  has no build step and never loads from a CDN, and it starts its weeks on Monday. It is the one control every date
  range of the webapp is picked with — the animation (§4.12), the export (§4.5) and the retrospective analysis (§4.10)
  too, replacing a pair of date fields, so a reversed range cannot be entered. Where any date is allowed (everywhere but
  the retrospective, which needs both ends) the calendar has an _Any date_ button to clear the range.
- **The figures**: number of passages, the dates of the first and of the last, total distance, total time under way
  (each passage's elapsed time, stops within it included), top speed and strongest wind. Speeds are the highest reading
  in the passage's track and instrument snapshots; the wind is true wind, or apparent where a passage never had a true
  one, and says so.
- **Longest passage without a stop**, by distance, with the time it took. A passage is cut wherever it stopped over — a
  lock or a lunch anchorage kept within one entry, or the stop a merge folded away (§3.1) — and each stretch is measured
  on its own from the track, so a 60 nm passage with a night in the middle counts as its two halves. A passage that
  never stopped is one stretch, with its own distance and times.
- **Countries visited**, as flags with their names in the page's language: the countries of the departures and arrivals
  in the period, in order of first visit (§4.8 says where a place's country comes from). A flag emoji is drawn as its
  two letters on a platform without flag fonts, which is why the name stays beside it. Passages reaching places whose
  country is unknown simply do not add one.
- **Top 5 passages** by duration, distance, average speed (distance over elapsed time), top speed and strongest wind,
  each linking to its passage page. A passage with no reading for a figure — no wind sensor — is left out of that
  ranking.
- **A passage in progress counts as it stands**, up to now, in every figure and ranking, as in the summary above the log
  (§3.2).

### 4.15 Importing passages from PostgSail

Brings a logbook kept with [PostgSail](https://github.com/xbgmsharp/postgsail) into Chiplog:
`scripts/import-postgsail.js` reads PostgSail's GeoJSON export of one trip or several and sends each trip to
`POST /entries` — through the API, not the database, so the logbook can be on the boat's Signal K server while the file
is on another machine.

- **A trip is a passage.** PostgSail's export is a list of positions, about one a minute; the first position of each
  trip carries its `trip` (name, distance, duration). A trip starts at each of those, and ends with the position before
  the next. A trip with a single position is left out.
- **What comes across.** The trip's start and end (its first and last position), the track with the speed, course,
  heading and wind of each position, the places from the trip name (`"<departure> → <arrival>"` — a trip renamed since
  has none, and its places are named from their position, pending geocoding), the engine and sail periods from each
  position's `status` (`motoring` is engine, `sailing` is sail, `moored` is not under way), and instrument snapshots
  taken as live: at departure, at arrival and on the clock every hour by default (`--observation-interval`), with air
  and water temperature, and depth and pressure where PostgSail has them, and the fuel level of the first position as
  the tank noted at departure (`tanklevel` is the fuel tank), and its voltage and state of charge as the house battery.
- **Places.** A name is tied to the known place within the matching radius, else to one of the same name within 500 m —
  an anchorage is not left at the same spot twice — else made a place of its own.
- **Units.** PostgSail gives speeds and wind speeds in knots, angles in degrees and temperatures in kelvin; the script
  converts to Signal K's units. A pressure under 2000 is taken as hectopascals, and converted to pascals.
- **Not imported:** notes, and the distance PostgSail computed — Chiplog sums it over the track, as for any passage,
  which lands within a few percent.
- **Safe to repeat.** The API refuses a passage that overlaps one on record (`409 entry_overlaps`); the script counts it
  as already there and goes on, so a run interrupted by the network is finished by running it again. Any other failure
  stops the run, since the next passage would most likely fail the same way.
- **Administrator only**, like deleting a passage: a token given with `--token`, or `--user` and `--password` to sign
  in.
- **Imported passages are final.** They are closed by neither detection nor the crew, so a departure soon after one
  never reopens it (§4.2). Their landmarks are fetched like any other passage's (§4.13); their tide and weather
  forecasts (§4.5.2, §4.5.3) are not, the departure being long past.

## 5. Data model and API

The data model has been refined into a precise schema: the authoritative DDL lives in
[`lib/database.js`](../lib/database.js), with the conventions and rationale documented in
[DATA_MODEL.md](DATA_MODEL.md). Entities: `log_entries`, `track_points`, `observations`, `propulsion_segments`,
`events`, `places`, `manoeuvre_types`, `crew_members`, `log_entry_crew`, `tide_forecasts`, `weather_forecasts`,
`landmarks`, `landmark_areas`.

Two points worth carrying back into this document:

- Dense track geometry (`track_points`) and sparse instrument snapshots (`observations`) are separate tables: the first
  feeds the map and GPX export (§4.1), the second provides the hourly condition lines the facsimile PDF renders (§4.5).
- No per-event author field in V1 (cf. §3.4) — a per-passage crew _list_ is recorded instead (§4.11). The exported GPX
  file is derived from track points, not stored as such.

The plugin's REST API is specified in [API.md](API.md).

## 6. MVP scope (proposal)

1. Automatic start/stop detection (signalk-autostate if present, internal fallback otherwise) and entry creation/closure
   with configurable threshold, with manual concatenation of two entries possible.
2. Automatic engine/sail detection with manual correction.
3. GPS track (combined sampling) + GPX export + basic map display in the webapp.
4. Timestamped keyboard annotations.
5. Manoeuvre shortcuts (basic predefined list).
6. Automatic SK events: critical notifications, autopilot, configurable weather thresholds.
7. Departure/arrival place names (online geocoding + known places, manual correction remembered).
8. Manual + automatic configurable USB export (JSON/CSV/GPX from V1; facsimile PDF in V1.1).
9. Day-grouped view in the consultation webapp.

Brought forward from V2: handwritten annotations, in the tablet PWA (§4.4).

Deferred to V2: full shortcut customization, publication to a remote server, dedicated mobile companion app, crew
profiles/permissions (per-event authorship and skipper/crew access rights — the crew _list_ itself, §4.11, shipped in
V1), advanced map (offline tiles, etc.).

_(This MVP breakdown is a proposal — to be validated with you before committing to it.)_

## 7. Decisions settled during scoping

| Topic                                              | Decision                                                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Storage                                            | SQLite (single database: entries, events, track, annotations)                                                                                                                                                                                                                                                                      |
| SQLite driver                                      | Node's built-in `node:sqlite` — no native compilation, which matters on Raspberry Pi. Raises the floor to Node >= 22.13                                                                                                                                                                                                            |
| Runtime dependencies                               | One: `@js-temporal/polyfill`, which the Signal K History API types its time range with (§4.10). Node ships `Temporal` unflagged only from Node 26, and signalk-server itself asks for Node >= 22, so the floor is not raised to shed it; it goes when `@signalk/server-api` stops needing it                                       |
| Handwritten annotation format                      | Vector (timestamped strokes/points + pressure, canvas size); implemented in V1 in the tablet PWA                                                                                                                                                                                                                                   |
| Author / crew list                                 | No per-event author in V1; a per-passage crew list is, picked from an editable global roster, carried over from the preceding passage (§4.11). Per-event authorship deferred to V2 if confirmed                                                                                                                                    |
| signalk-autostate dependency                       | Optional, with internal fallback (SOG threshold) if absent                                                                                                                                                                                                                                                                         |
| Engine/sail sources                                | `propulsion.*.revolutions`, then `propulsion.*.state`, then `navigation.state`, then a configurable default (`sail`); segments only cover time under way (§4.2)                                                                                                                                                                    |
| Critical notifications                             | Any notification in `alarm` or `emergency`, whatever its path (§4.6)                                                                                                                                                                                                                                                               |
| Weather thresholds                                 | True wind averaged over 2 min against configurable speeds (20 and 30 kn); barometric fall of 4 hPa over 3 h (§4.6)                                                                                                                                                                                                                 |
| Events between passages                            | Attached to the last passage while within 1 nm of its arrival; otherwise not logged (§4.6)                                                                                                                                                                                                                                         |
| Webapp stack                                       | Preact + htm as one vendored ES module, no build step, no CDN (a boat is usually offline); Leaflet for the map. The tablet PWA shares it                                                                                                                                                                                           |
| Entry with no passage open                         | Cast off / anchor up opens a passage, or goes to the one detection closed less than the tolerance before; other entries go to the last passage within 1 nm of its arrival, else are refused (§4.3)                                                                                                                                 |
| Passage closure                                    | At once when the vessel stops; a departure within `stopClosureMinutes` (30 min) reopens it, the stop kept as a stopover. A crew close is final (§4.2)                                                                                                                                                                              |
| Tablet offline                                     | Entries queued on the tablet with their time and an idempotency key, replayed in order (§4.9)                                                                                                                                                                                                                                      |
| Tablet access                                      | Signal K device access request, token kept on the tablet; a user login works too (§4.9)                                                                                                                                                                                                                                            |
| Webapp languages                                   | English and French, chosen from the browser (`?lang=` overrides)                                                                                                                                                                                                                                                                   |
| Map tiles                                          | OpenStreetMap with the OpenSeaMap seamark overlay, online; offline the track is still drawn on a blank map. Offline charts are V2                                                                                                                                                                                                  |
| Instrument snapshots                               | At departure, hourly on the clock (configurable), at arrival and with each live manoeuvre, note or sketch (§4.5.1)                                                                                                                                                                                                                 |
| Tide forecast                                      | Open-Meteo Marine, free and keyless, fetched once at departure for the next 24 h; extremes found from the stored curve, not asked for separately; heights relative to mean sea level, disclosed as such rather than presented as a charted datum (§4.5.2)                                                                          |
| Marine weather forecast                            | Open-Meteo Forecast + Marine, free and keyless, fetched once at departure for the next 24 h, stored hourly; shown every 3 h, titled with the departure place, on the passage page and in a full-width PDF block above the day's table; the sea part optional (§4.5.3)                                                              |
| Speed fallback                                     | SOG averaged over 3 min; under way above a configurable speed (1 kn), stopped below half of it. Transitions dated from raw speed in both modes (§4.2)                                                                                                                                                                              |
| GPS track sampling                                 | Configurable fixed interval (15 s) + extra point on a 15° course or 1 kn speed change (§4.1)                                                                                                                                                                                                                                       |
| PDF export                                         | Traditional logbook facsimile, A4 landscape, a page per day in ship's time, English or French; home-made PDF writer with the standard fonts, no dependency (§4.5)                                                                                                                                                                  |
| USB copy                                           | One JSON, CSV and GPX file per passage, written when new or changed; every 15 min and at each arrival by default (§4.5)                                                                                                                                                                                                            |
| Automatic SK events (beyond engine/sail/manoeuvre) | Critical notifications, autopilot, configurable weather thresholds                                                                                                                                                                                                                                                                 |
| Multi-vessel                                       | One vessel per Signal K instance, no multi-profiles                                                                                                                                                                                                                                                                                |
| Remote server target                               | Undefined for V1; designed as a generic extension point (configurable webhook/API)                                                                                                                                                                                                                                                 |
| Automatic place names                              | Online geocoding (e.g. Nominatim/OSM) with fallback to already-known local places                                                                                                                                                                                                                                                  |
| Geocoding service                                  | Any Nominatim-compatible endpoint, public OpenStreetMap instance by default, can be disabled; looked up in the background, retried when offline (§4.8)                                                                                                                                                                             |
| Place matching radius                              | A single global configurable radius (no per-place setting in V1)                                                                                                                                                                                                                                                                   |
| Place not found (offline, first visit)             | Name generated from coordinates, manually correctable                                                                                                                                                                                                                                                                              |
| Passage animation                                  | A page over a date range, all its passages in sequence with the port time skipped; a renderer of our own on a canvas rather than Leaflet, a zoom per passage at a ~32 km working scale widened by at most one level, time-driven interpolation, 1 h of sailing per second at x1 (x0.5–x4), 30 fps, entirely in the browser (§4.12) |
| Statistics                                         | One page over a date range with period shortcuts; longest non-stop stretch measured between stopovers; countries taken from geocoded places, worked out in the background (§4.14)                                                                                                                                                  |
| Landmark bearings                                  | Every journal position also read against the nearest amer, from OpenStreetMap through Overpass, fetched by half-degree cell and kept; the bearing computed at read time, the amer chosen by distance relative to its kind's range; shown in grey under the coordinates on the passage page and in the PDF (§4.13)                  |
| Import from PostgSail                              | A script over the REST API (`POST /entries`, admin), a passage per trip, refused when it overlaps one on record so it can be run again; fuel level and house battery kept as the boat's state at departure (§4.15)                                                                                                                 |
| MP4 export                                         | WebCodecs H.264 plus a vendored Mediabunny (one self-contained ES module covering encoder and container, MPL-2.0, imported lazily); five shapes up to 1920×1080; `mp4-muxer` was set aside as deprecated and muxer-only; hidden when the browser has no WebCodecs (§4.12)                                                          |
| 3D animation view                                  | A switch between the map and a 3D view of the same film: three.js bundled at install time and loaded on demand, tiles as textures on a flat sea, a procedural sailboat or the reader's own `.glb`, heel and sail trim derived from the wind; needs WebGL 2 and falls back to the map (§4.12)                                       |

### Remaining minor points (non-blocking for starting)

- None at present.

## 8. Suggested next steps

1. ~~Define the precise SQLite schema (DDL) and the plugin's REST API.~~ Done — see [DATA_MODEL.md](DATA_MODEL.md) and
   [API.md](API.md).
2. ~~Implement the REST API defined in [API.md](API.md) on top of the schema.~~ Done, with tests. `getOpenApi()`
   remains.
3. ~~Stopped/underway and passage detection.~~ Done (§4.2), with track recording (§4.1), engine/sail segments,
   instrument snapshots (§4.5.1), automatic events (§4.6) and place names with online geocoding (§4.8). The plugin's
   data side is complete.
4. ~~Build the tablet entry PWA.~~ Done (§2, §4.3, §4.4, §4.9), handwriting included.
5. ~~Build the consultation webapp.~~ Done (§2). Not in it yet: a places page and manoeuvre-shortcut management.
6. ~~Scheduled USB export (§4.5), then the facsimile PDF (V1.1).~~ Done.

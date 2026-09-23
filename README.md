# Chiplog

An automated nautical logbook for [Signal K](https://signalk.org). Chiplog writes the logbook from the data already on
your boat's Signal K server — passages, track, engine and sail, instrument readings, alarms — and lets the crew add what
sensors cannot know from a tablet at the helm: manoeuvres, notes and handwriting.

- **One entry per passage**, opened when the boat leaves and closed as soon as it arrives, carrying on after short stops
  such as a lock or a lunch anchorage.
- **GPS track**, distance, time under engine and under sail.
- **Hourly instrument readings**, as on a paper log, plus readings at departure, arrival and each manoeuvre.
- **Automatic events**: alarms, autopilot changes, strong wind, falling barometer, held heading changes.
- **Departure and arrival names**, looked up online and corrected once for good.
- **Consultation webapp**: logbook by day, map, timeline, corrections, export.
- **Replay a range of passages** on the map — an hour of sailing per second — and save it as an MP4 for a phone, a
  square post or a widescreen, rendered entirely in your browser.
- **Tablet entry app**: big buttons for gloves and wet fingers, stylus handwriting, night mode, works through Wi-Fi
  dropouts.
- **Abandon-ship copy**: JSON, CSV and GPX, downloadable or written to a USB drive.

English and French, chosen from the browser's language.

## Contents

- [Requirements](#requirements-)
- [Installation](#installation-)
- [How the logbook is written](#how-the-logbook-is-written-)
- [The logbook webapp](#the-logbook-webapp-)
- [The tablet entry app](#the-tablet-entry-app-)
- [Configuration](#configuration-)
- [Signal K data used](#signal-k-data-used-)
- [Backups and abandon ship](#backups-and-abandon-ship-)
- [Retrospective analysis](#retrospective-analysis-)
- [Importing from PostgSail](#importing-from-postgsail-)
- [Privacy and online services](#privacy-and-online-services-)
- [Troubleshooting](#troubleshooting-)
- [Limitations](#limitations-)
- [Development](#development-)
- [License](#license-)

## Requirements ✅

- **Signal K server 2.x** running on **Node.js 22.13 or later**. Chiplog uses Node's built-in SQLite module, so there is
  nothing to compile — it installs the same way on a Raspberry Pi.
- **A position and speed over ground** on the Signal K bus (GPS). Everything else is optional and used when present.
- **Recommended:** [signalk-autostate](https://github.com/meri-imperiumi/signalk-autostate), which publishes
  `navigation.state` (moored, anchored, sailing, motoring). Without it, Chiplog decides from speed alone and says so in
  the apps.
- **Recommended:** a correct system clock, e.g. with `signalk-set-system-time`. The logbook is dated from the server's
  clock.
- **Optional:** a USB drive left plugged into the server, for the abandon-ship copy.
- **Optional:** an internet connection, for map tiles and place names. The logbook itself never needs one.

## Installation 📦

Install **Chiplog** from the Signal K App Store (**Apps & Plugins → Store**), or from the command line:

```bash
cd ~/.signalk
npm install signalk-chiplog
```

Then restart the Signal K server, and in the Signal K admin:

1. Go to **Apps & Plugins → Configuration**, open **Chiplog**, tick **Enabled** and save. The defaults suit most boats;
   see [Configuration](#configuration-).
2. Open **Webapps**: **Chiplog** is listed there. Its two pages are also reachable directly:
   - the logbook: `http://<your-server>:3000/signalk-chiplog/`
   - the tablet entry app: `http://<your-server>:3000/signalk-chiplog/entry/`

The logbook is stored in a single SQLite file, `~/.signalk/plugin-config-data/signalk-chiplog/chiplog.sqlite`.

## How the logbook is written 📖

### Passages

A **passage** is one logbook entry: from leaving a berth or anchorage to arriving at the next one.

- **Departure.** A passage opens when the boat gets under way. It is dated from the moment the boat actually left — not
  the few minutes later when the decision was confirmed — and placed where it was last still.
- **Arrival.** A passage closes as soon as the boat stops, dated and placed where it actually stopped: the arrival is
  named and copied to the USB drive straight away.
- **Short stops.** Leaving again within the tolerance (30 minutes by default) of that arrival reopens the same passage
  rather than starting a new one. The stop stays on its timeline as its own line, naming the place, followed by a
  departure line when the boat sets off again. A passage you closed yourself from the webapp is never reopened.
- **Casting off** from the tablet opens the passage right away, before the boat moves (see
  [Departures](#departures-open-the-passage)). Soon after an arrival, it goes to the passage that just ended instead,
  which carries on once the boat moves.
- **Power cuts and restarts.** If the server comes back after the boat has been still for longer than the tolerance, the
  passage is closed at its last movement. A short restart carries on with the same passage.
- **Under way or stopped** comes from `navigation.state` when something publishes it — signalk-autostate, typically.
  Otherwise Chiplog averages speed over ground over 3 minutes: under way above 1 knot, stopped below half a knot. This
  keeps a boat swinging at anchor from starting passages.

A passage that was split in two — a stop just longer than the tolerance, for instance — can be merged back from the
logbook webapp. The stop the merge folds away is kept on the timeline as its own line, naming the place, since it would
otherwise leave no trace once the merge takes the later passage's arrival as its own.

### Track and distance

While under way, a track point is recorded every 15 seconds, plus extra points on a turn of 15° or more or a speed
change of 1 knot, so tacks show on the map without bloating straight lines. The distance is the length of the track.

### Engine or sail

Each passage is split into engine and sail periods covering the time under way. Chiplog decides from, in order:

1. `propulsion.*.revolutions` — any engine turning means engine;
2. `propulsion.*.state` (`started` / `stopped`);
3. `navigation.state` (`motoring` / `sailing`);
4. the configured default, **sail**.

A wrong period can be corrected in the webapp. A correction to the period in progress holds until the engine data
actually changes. Each actual switch is also logged as a line in the passage's timeline.

### Instrument readings

Readings are taken at departure, **every hour on the hour** during the passage (configurable), at arrival, and with each
manoeuvre, note or sketch logged live, so a reef appears with the wind that called for it and a note with the conditions
when it was written. Each reading holds whatever is available among position, speed and course over ground, heading,
speed through water, true and apparent wind, depth, barometer, air and water temperature, the log and the hour counter
of each engine — both engines of a twin-engine boat. A sensor that has gone silent is left blank rather than repeating
an old value.

### Automatic events

Added to the timeline without anyone touching anything:

- **Alarms** — any Signal K notification reaching `alarm` or `emergency` (man overboard, engine alarm, anchor watch…),
  and when it clears.
- **Autopilot** — engaged, disengaged, mode changes.
- **Wind** — true wind, averaged over 2 minutes, rising above 20 and 30 knots and falling back below them
  (configurable).
- **Barometer** — a fall of 4 hPa or more over 3 hours (configurable).
- **Heading changes** — a turn of 30° or more, held steady for a minute, above 2 knots (configurable, and can be turned
  off).

An alarm at anchor between two passages goes to the passage that ended there, as long as the boat is within 1 nautical
mile of that arrival.

### Tide forecast

When a passage opens, Chiplog fetches the predicted water height near the departure for the next 24 hours (configurable
service, on by default) and shows it on the passage page: the departure's place, the high and low tide times and
heights, and the height curve. Fetched once, at departure — not kept up to date afterwards. Offline is handled the same
way as geocoding: retried for a while, then given up on quietly if the boat stays out of reach, or if the position
simply has no tide (an inland lake). Hourly data, so times are accurate to within about half an hour — enough for a
logbook reference, not for timing a lock or a bar crossing to the minute.

**Heights are relative to mean sea level, not a charted "hauteur d'eau".** The free tide service used has no notion of
chart datum (the lowest-astronomical-tide reference SHOM and other official tide tables use), so a reading here can be
several metres off what a nautical chart or an official tide table would say for the same moment — the app says so under
the chart. Tide _times_ are unaffected by this: a vertical offset does not move when high or low water falls.

### Marine weather forecast

When a passage opens, Chiplog also fetches the marine weather forecast near the departure for the next 24 hours (on by
default, can be turned off) and shows it, titled with the departure place, as a table every 3 hours: sky and rain, wind
(Beaufort force, direction, speed and gusts), waves and swell (height, period, direction), pressure, visibility, air and
sea temperature, and current. A thunderstorm or a force 7 or more stands out in red. Each row gives the strongest gust
and the rain over its three hours. The PDF logbook lists the same forecast, titled the same way, in its own full-width
block above the day's table of events and observations.

Arrows point where the wind, the sea and the current are going; the compass point next to them is where wind, waves and
swell come _from_, but where the current flows _to_, as sailors usually read them. Like the tide, it is fetched once at
departure and not updated afterwards; far from the sea, only the atmospheric part is shown.

### Place names

Departures and arrivals are named automatically:

1. **Known places first.** Within 200 m (configurable) of a place already named, that name is used.
2. **Otherwise online**, from OpenStreetMap's Nominatim service. Until it answers — at sea, out of reach of a network —
   the place shows its coordinates (e.g. `46.1466N 1.1686W`) as a provisional name, and the lookup is retried later.
3. **Corrections are remembered.** Renaming a departure or arrival in the webapp also renames that place for every later
   passage starting or ending nearby. Past passages keep the name they recorded.

### Landmarks (amers)

Every position in the log is also given the way a paper logbook gives one — as a distance and a bearing **from a
landmark**, under the coordinates, in a lighter grey:

```text
46°08.88′N 001°12.90′W
2,3 M ENE (065°) — Phare de Chauveau
```

- **The landmarks come from OpenStreetMap**, fetched area by area through Overpass and kept: lighthouses and major
  lights, capes, named towers and other seamark landmarks, minor lights, isolated-danger and safe-water beacons,
  harbours and marinas. The numbered marks of a channel are left out — "6 c" says nothing in a logbook.
- **The nearest useful one wins**, not simply the nearest: each kind carries a range (15 nm for a lighthouse, 3 for a
  harbour…), narrowed by the light's own range when known, and the landmark closest relative to its range is the one
  quoted. Offshore, beyond them all, the coordinates stay alone.
- **Past passages fill in by themselves** once their area has been fetched — the bearing is worked out when the page or
  the PDF is drawn, never stored.
- Turn **Read each journal line against the nearest landmark** off to keep the boat off Overpass entirely.

## The logbook webapp 💻

Open **Chiplog** from the Signal K webapps, or `/signalk-chiplog/`. Reading needs no more than read-only access.

- **Status bar** — under way under sail or engine, stopped, or waiting for data, with a link to the passage in progress.
  A warning shows when detection works from speed alone because signalk-autostate is missing.
- **Logbook** — a summary above the list (number of passages, total distance, total time, across every passage logged,
  not just what is loaded), then passages grouped by day, newest first, with times, departure and arrival, distance,
  duration and an engine/sail bar. A passage across midnight appears on both days. Provisional place names are shown as
  such.
- **Passage page** — links at the top to the previous and the next passage (or **Alt+←** and **Alt+→**), then a summary
  (distance, duration, average speed, the highest speed and wind seen, and the crew aboard), map of the track
  (OpenStreetMap with OpenSeaMap seamarks, which can be hidden) with a small boat marker at the selected point, a
  scrubber under the map to step back and forth through its history (defaulting to the latest point, so it shows the
  current position on a passage in progress) with a band of that point's time, SOG, COG, STW, TWS, TWD, TWA and AWA, the
  marine weather forecast every 3 hours from departure, the tide forecast near the departure (place, high/low times and
  heights, height curve) when one was fetched, the engine and sail periods, the boat's status (each engine's hour
  counter at departure and arrival and the hours run, and the tank levels and battery charge, voltage and current noted
  at departure), and the log: every reading and event in order, including handwritten notes. A passage in progress
  refreshes every minute. Each line's comment can be edited (read/write access); a manoeuvre or note the crew logged
  themselves can also be deleted — automatic lines (alarms, autopilot, weather, corrections) can only be annotated.
  Under each position, in grey, its bearing and distance from the nearest landmark.
- **Corrections** (read/write access):
  - rename the departure, or the arrival once the passage is closed — a passage in progress has none yet to rename;
  - switch an engine period to sail or back;
  - close a passage in progress, e.g. to confirm an arrival;
  - merge with the previous or next passage;
  - delete a passage (admin).
- **Statistics** — the logbook summed up over a period: a shortcut (all time, this month, last month, the last 12
  months, this year, last year) or a range picked in a calendar with two clicks, the first and the last day. It gives
  the number of passages, the dates of the first and the last, total distance, time under way, top speed and strongest
  wind, the longest passage without a stop (a passage with a stopover counts as its stretches between stops) with its
  distance and time, the flags of the countries visited, and the top 5 passages by duration, distance, average speed,
  top speed and wind. Countries come from the place names, so they need geocoding enabled and the boat online now and
  then; places named before this existed fill in by themselves.
- **Animation** — pick a period (kept in the page's address, so a reload or a shared link keeps it) and every passage in
  it replays on the map, one after another, the port time skipped. The film opens on the whole navigation and zooms down
  to the first position in two seconds, and pulls back out to the whole navigation at the end. The map follows the boat
  at a scale chosen for each passage — a short hop kept readable rather than magnified, a long crossing allowed a wider
  view but never so wide the boat crawls across empty water — while a bubble shows the speed, the distance covered since
  the start and the date. Play, pause and a slider over the animation's own time, at ×0,5, ×1, ×2 or ×4. **Export MP4**
  saves it as a video in one of five shapes (Mobile 9:16, Portrait 3:4, Square 1:1, Landscape 4:3, Widescreen 16:9).
  Everything happens in the browser: nothing is rendered or encoded on the Signal K server, and the map tiles are the
  only thing downloaded. **View → 3D** shows the same film, at the map's own scale and with north still at the top, as a
  camera tilted down onto a 3D sailboat that heels and trims its sails to the wind and rides the waves, with the map
  laid flat under it; frame it closer or wider than the map and pick the boat's size if you like, and load your own boat
  as a `.glb` file — sails included — if you would rather see it (see
  [Your own boat](#your-own-boat-in-the-3d-animation-)). The MP4 export then films the 3D view.
- **Export** — download the whole logbook or a date range as a PDF logbook to print, JSON, CSV or GPX, and write the
  abandon-ship copy to the USB drive now (admin). The PDF is written in the webapp's language and the device's time
  zone.
- **Retrospective** (admin) — reconstruct past passages for a date range from an InfluxDB history (see
  [Retrospective analysis](#retrospective-analysis-)).

Every date range in the webapp — Statistics, Animation, Export and Retrospective — is picked the same way: one button
showing the period, and a calendar under it where two clicks, the first and the last day, make the range. Statistics has
shortcuts beside it; where any date is allowed, the calendar has an _Any date_ button to clear the range.

**Helm entry** in the top bar opens the tablet entry app.

### Your own boat in the 3D animation ⛵

The 3D view draws a generic sailboat. To see yours instead, use **Boat → Use my own boat…** under the animation and pick
a `.glb` file. The model is kept in **that browser only** (it is never sent to the logbook or the Signal K server), so
it has to be loaded again on another device; **Use the default boat** puts the generic one back.

**The file**

|               |                                                                                                                                   |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Format        | Binary glTF 2.0 (`.glb`), one self-contained file — textures embedded                                                             |
| Size          | 30 MB at most (a few MB is plenty: the boat is small on the film)                                                                 |
| Not supported | Draco, Meshopt or KTX2 compression. Animations, cameras and lights inside the file are ignored — the view lights the scene itself |
| Materials     | Ordinary glTF materials. Make the sails **double-sided**, or one face vanishes as they swing                                      |

**Orientation, size and waterline**

- **Y is up and the bow points towards +Z** — the glTF convention. Nothing else says which end is the front, so a boat
  that sails backwards needs a half turn about the vertical axis before it is exported.
- **Any unit.** The model is scaled so that its longest horizontal extent — length, or width if that is larger,
  including a boom or a bowsprit — is one boat length, and centred in plan. A stray helper object far from the boat (a
  ground plane, a light) enlarges that box and shrinks the boat: delete them before exporting.
- **The lowest point of the model is taken as the bottom of the keel** and placed a twentieth of the boat's length under
  the waterline, everything else above. The sea is drawn behind the boat and never cuts into it, so the hull is always
  whole.
- **The whole boat turns, heels, pitches and rides the waves** with no work on your part. Its size on screen is set by
  the _Boat size_ buttons, not by the model.

**Sails that move to the wind**

Name the sail nodes and the view trims them like the default boat's: let out as the wind comes aft, and on the side away
from it.

| Sail     | Names recognised                                                    | Origin of the node                   | Turns by            |
| -------- | ------------------------------------------------------------------- | ------------------------------------ | ------------------- |
| Mainsail | `Mainsail`, `Main`, `Sail_Main`, `GrandVoile`, `GV`                 | On the mast, at the foot of the sail | The full sail angle |
| Headsail | `Jib`, `Genoa`, `Headsail`, `Foresail`, `Sail_Jib`, `Foc`, `Génois` | On the forestay, at the tack         | 0.8 of it           |

Case, spaces, punctuation and the number a modelling tool adds to a copy (`Mainsail.001`) do not matter.

- **The sail is rotated about the vertical axis through the origin of its node.** Put that origin where the sail should
  pivot — the mast, or the bow fitting for a jib — not at the middle of the cloth, or it will swing sideways.
- **Model it at rest on the centreline**, the boom pointing aft (−Z). The view adds the trim angle to whatever rotation
  the node already has.
- **The angle** is about half the apparent wind angle, at least 4° and at most 88°, smoothed like the boat's heading.
  The wind on the starboard side puts the sail to port, and the other way round. Where the track has no wind reading the
  sails stay on the centreline.
- **Put the boom, the sail and its fittings inside the sail node** so they turn together. Only the outermost node with a
  recognised name is turned; anything nested in it goes along.
- **The cloth is rigid.** It does not billow, and a camber does not swap sides with the tack: model it flat or
  symmetrical.
- **Nothing else is animated** — no flag, rudder or propeller.

**From Blender**

1. Model the boat with its bow towards **−Y** and Z up — Blender's own front — so it comes out towards +Z with Y up.
2. Name the sail objects `Mainsail` and `Jib`.
3. For each sail, put the 3D cursor on the mast foot (or the tack) and use **Object ▸ Set Origin ▸ Origin to 3D
   Cursor**. Apply rotation and scale (**Ctrl+A**).
4. Set the sail material to double-sided (**Backface Culling** off).
5. **File ▸ Export ▸ glTF 2.0**, format **glTF Binary (.glb)**, **+Y Up** ticked, compression off; lights and cameras
   need not be included.
6. Load the file in the animation. The line under the boat says which sails were found — _Sails trimmed to the wind:
   mainsail, jib_ — or _No sail recognised_ if a name is off.

**When something is wrong**

| What you see                     | Why, and what to do                                                                                           |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| The boat sails backwards         | The bow points towards −Z. Turn the model 180° about the vertical axis and export again                       |
| The boat lies on its side        | Exported with Z up. Export with **+Y Up**                                                                     |
| The boat is tiny                 | Something far from it is in the file — a ground plane, a light. Remove it                                     |
| _No sail recognised_             | The nodes are not named as in the table, or a wrapper node above them has a sail name and hides them          |
| The sails do not move            | The track has no wind readings (there is no apparent wind angle), or the sail nodes are called something else |
| A sail swings about an odd point | Its origin is not on the mast or the tack                                                                     |
| One face of a sail disappears    | The material is single-sided                                                                                  |
| _That file could not be read_    | It is not a `.glb`, or it uses Draco, Meshopt or KTX2 compression                                             |
| The model is gone next time      | The browser's site data was cleared, or it is another browser or device. Load it again                        |

## The tablet entry app 📱

Open `/signalk-chiplog/entry/` on the tablet, or follow **Helm entry** from the logbook. For an app-like, full-screen
launcher, use the browser's **Add to Home Screen** (Safari: Share → Add to Home Screen; Chrome: menu → Add to Home
screen / Install app).

### Crew

A compact, read-only list at the top of the screen shows who is aboard the current passage. The pencil next to the title
opens a dialog to tick names on or off from the crew list, and to add a new name (with an optional role, e.g. "skipper")
— typing one both logs it aboard and adds it to the list for next time, no admin login needed. Every name in that
dialog, including one just added, carries its own pencil to correct it and a trash icon to remove it from the list for
good; a removal asks to confirm first, and past passages that recorded the name keep it. A new passage starts with the
same crew as the one before it, ready to adjust rather than re-enter from scratch.

### Logging a manoeuvre

Tap the manoeuvre: tack, gybe, reef in, shake out reef, sail change, anchor down, anchor up, moor, cast off, watch
change. One tap logs it with the time, the position and an instrument reading.

- **Sail change** asks which sail went up: mainsail, genoa, jib, staysail, spinnaker, gennaker, code 0, storm jib, or
  any name you type.
- A banner then confirms it for 10 seconds, with two big buttons:
  - **Undo**, for a mistaken tap;
  - **Add a comment**, e.g. "25 kn, second reef".

### Departures open the passage

With no passage open, **Cast off** and **Anchor up** are highlighted. Tapping one opens the passage at that moment, and
the header shows "Ready to leave since…" until the boat moves. Chiplog then carries on with that same passage. If the
boat does not leave within the tolerance (30 minutes by default), the passage closes at the cast-off; **Undo** right
after the tap removes it altogether. Within the tolerance of an arrival, the tap goes to the passage that just ended
instead of opening one: that passage carries on when the boat moves.

Other entries made with no passage open go to the last passage if the boat is still within 1 nm of where it ended — a
note once moored belongs to the passage that brought you there. Anywhere else, the app asks you to cast off first.

### Notes and handwriting

- **Note** — type and tap **Log it**.
- **Handwriting** — takes over the whole screen, with a toolbar above the pad: fine pen, thick pen, highlighter, eraser,
  undo, and a choice of colour (kept to the theme's colour in night mode, to spare night vision). Pen pressure also sets
  the line width. The eraser removes only what it actually touches, splitting a stroke rather than deleting all of it;
  undo steps back through strokes and erasing alike. Once a stylus has touched the pad, fingers are ignored, so a palm
  resting on the screen does not draw. Add a comment and tap **Log it** to send.

Handwritten notes appear as drawn — colour, pen or highlighter included — in the logbook's timeline and in the PDF
export, not just on the tablet.

### Latest entries

Below, the latest entries of the current passage (or of the last one) are listed with their time. Each can take a
comment, and your own entries can be deleted; a note's text can be edited.

### Night mode

**Night** switches to red on black, to keep night vision. The choice is remembered on the tablet.

### When the Wi-Fi drops

Keep logging. The header shows **Not connected** and how many entries are waiting. Each entry is kept on the tablet with
the time it was made, and sent in order as soon as the server answers again, with the position the track recorded at
that time. An entry sent just before the connection dropped is never logged twice.

If the server refuses a waiting entry when it comes back — typically nothing to attach it to — it is shown in red in the
latest entries, to discard.

**Starting the app with no connection** needs HTTPS (see
[Troubleshooting](#the-tablet-app-does-not-start-without-a-connection)). Over plain HTTP the app still keeps entries
through a dropout, as long as it was loaded beforehand.

### With Signal K security enabled

Logging needs read/write access. The first time, the app shows **This tablet needs access**:

1. Tap **Request access for this tablet**.
2. In the Signal K admin, open **Security → Access Requests**, and approve **Chiplog tablet** with **read/write**
   permission. Choose a token expiry of **NEVER** so the tablet is not locked out at sea.
3. Within a few seconds, the tablet is in. It keeps its token.

To revoke it, delete the device under **Security → Devices**: the tablet asks for access again. **Sign in instead** uses
a regular Signal K user account.

## Configuration 🔧

In the Signal K admin, **Apps & Plugins → Configuration → Chiplog**.

| Setting                                                          | Default                                       | What it does                                                                                                                                                                                                 |
| ---------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Stop duration within which a new departure continues the passage | 30 min                                        | A passage closes when the boat stops; leaving again sooner reopens it, the stop kept as a stopover.                                                                                                          |
| Under-way speed without navigation.state                         | 1 kn                                          | Used only without signalk-autostate: under way above it, stopped below half of it.                                                                                                                           |
| Propulsion assumed without engine data                           | sail                                          | When nothing says whether the engine is running. Set to engine on a motorboat.                                                                                                                               |
| Instrument snapshot interval                                     | 60 min                                        | Readings on this clock boundary during a passage.                                                                                                                                                            |
| Track point interval                                             | 15 s                                          | A track point at least this often while moving.                                                                                                                                                              |
| Place matching radius                                            | 200 m                                         | A departure or arrival this close to a known place takes its name.                                                                                                                                           |
| Name departures and arrivals with online geocoding               | on                                            | Turn off to never send positions online; places are then named after their coordinates until corrected.                                                                                                      |
| Geocoding service                                                | `https://nominatim.openstreetmap.org`         | Any Nominatim-compatible service, e.g. a self-hosted one.                                                                                                                                                    |
| Read each journal line against the nearest landmark              | on                                            | Fetches the landmarks of the areas sailed through from OpenStreetMap, so each position is also given as a bearing and distance from one. Turn off to keep the coordinates alone.                             |
| Landmark service (Overpass API)                                  | `https://overpass-api.de/api/interpreter`     | Any Overpass-compatible service, e.g. a self-hosted one.                                                                                                                                                     |
| Fetch the tide forecast at departure                             | on                                            | Turn off to never send the departure position online; the passage page then shows no tide.                                                                                                                   |
| Marine service                                                   | `https://marine-api.open-meteo.com/v1/marine` | Any Open-Meteo Marine-compatible service, e.g. a self-hosted one. Serves the tide, and the sea state and current of the weather forecast.                                                                    |
| Fetch the marine weather forecast at departure                   | on                                            | Turn off to never send the departure position to the weather services; the passage page and the PDF then show no forecast.                                                                                   |
| Weather service                                                  | `https://api.open-meteo.com/v1/forecast`      | Any Open-Meteo-compatible forecast service, e.g. a self-hosted one.                                                                                                                                          |
| USB export directory                                             | —                                             | Where the abandon-ship copy is written, e.g. `/media/usb`. Empty turns the USB copy off.                                                                                                                     |
| Automatic USB copy interval                                      | 15 min                                        | How often the USB copy is brought up to date. 0 turns the periodic copy off.                                                                                                                                 |
| Copy to the USB drive at each arrival                            | on                                            | Brings the USB copy up to date as soon as a passage ends.                                                                                                                                                    |
| Logbook language (PDF)                                           | en                                            | Language of the PDF logbooks on the USB drive (English or French).                                                                                                                                           |
| Ship's time zone (PDF)                                           | the server's                                  | Time zone of the PDF logbooks on the USB drive, e.g. `Europe/Paris`.                                                                                                                                         |
| Wind speed thresholds                                            | 20, 30 kn                                     | Logged when the 2-minute average true wind crosses them.                                                                                                                                                     |
| Barometric drop warning                                          | 4 hPa / 3 h                                   | 0 turns it off.                                                                                                                                                                                              |
| Log heading changes                                              | on                                            | Turn off to leave heading changes out of the log.                                                                                                                                                            |
| Heading change threshold                                         | 30°                                           | A change must be at least this large to be logged.                                                                                                                                                           |
| Heading change tolerance                                         | 10°                                           | How much the new heading may wander while holding and still count as steady.                                                                                                                                 |
| Heading change hold time                                         | 60 s                                          | How long the new heading must hold before it is logged.                                                                                                                                                      |
| Heading change minimum speed                                     | 2 kn                                          | Below this speed over ground, the course is too noisy to log a change.                                                                                                                                       |
| Heading change cooldown                                          | 5 min                                         | A new change is logged only once the last one is at least this old.                                                                                                                                          |
| History source (retrospective analysis)                          | InfluxDB 1.x                                  | Select Signal K History API to read the server's own history provider, such as signalk-to-influxdb2 — no database connection needed. InfluxDB 1.x stays the default so existing installations are untouched. |
| InfluxDB host (retrospective analysis)                           | —                                             | Shown only for the InfluxDB 1.x legacy source. Local or remote host of the database signalk-to-influxdb writes to. Empty turns the retrospective analysis page off.                                          |
| InfluxDB port                                                    | 8086                                          |                                                                                                                                                                                                              |
| InfluxDB database                                                | —                                             |                                                                                                                                                                                                              |
| InfluxDB username / password                                     | —                                             | Leave empty if the database needs none.                                                                                                                                                                      |
| InfluxDB protocol                                                | http                                          | `http` or `https`.                                                                                                                                                                                           |
| Retrospective query timeout                                      | 30 s                                          | Each retrospective query gives up and reports an error past this, instead of hanging against an unreachable or overloaded history. Applies to either source.                                                 |
| Vessel context (retrospective analysis)                          | this server's own                             | Only needed running the replay from a different Signal K server than the one that wrote the history, e.g. development pointed at a production database. Applies to either source.                            |

## Signal K data used 🔌

None of these is required except position and speed over ground; each feature uses what the boat has.

| Purpose                   | Signal K paths                                                                                                                                                                                                                                                                                                                     |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Passages, track, distance | `navigation.position`, `navigation.speedOverGround`, `navigation.courseOverGroundTrue`, `navigation.state`                                                                                                                                                                                                                         |
| Engine or sail            | `propulsion.*.revolutions`, `propulsion.*.state`, `navigation.state`                                                                                                                                                                                                                                                               |
| Readings                  | `navigation.headingTrue` (or `headingMagnetic` + `magneticVariation`), `navigation.speedThroughWater`, `environment.wind.*`, `environment.depth.belowSurface` (or `belowTransducer`), `environment.outside.pressure`, `environment.outside.temperature`, `environment.water.temperature`, `navigation.log`, `propulsion.*.runTime` |
| Boat status               | `tanks.*.*.currentLevel`, `.currentVolume`, `.capacity`, `.name`, `electrical.batteries.*.voltage`, `.current`, `.capacity.stateOfCharge`, `.temperature`, `.name`                                                                                                                                                                 |
| Events                    | `notifications.*`, `steering.autopilot.state`, `.mode`, `.engaged`, `.target`, `environment.wind.speedTrue`, `environment.outside.pressure`, `navigation.headingTrue` (or `headingMagnetic` + `magneticVariation`)                                                                                                                 |

## Backups and abandon ship 🛟

- **Download** — Export page → PDF (a paper-style logbook: a page per day with time, position, course, speed, wind,
  barometer, depth, engine or sail and remarks, handwritten notes and the crew aboard each passage included), JSON (the
  complete record, including tracks and handwriting), CSV (logbook lines in nautical units, for a spreadsheet) or GPX
  (tracks).
- **USB drive** — leave a USB drive plugged into the server and set the USB export directory. Chiplog then keeps a copy
  on it by itself: every 15 minutes and as soon as a passage ends (both configurable). **Write to the USB drive now** on
  the Export page makes a copy immediately. The copy fills a `chiplog/` folder on the drive with one PDF, JSON, CSV and
  GPX file per passage, named so that sorting by name sorts by date — e.g.
  `2026-09-13_0612Z_La-Rochelle_Les-Sables-d-Olonne.csv` (times in UTC; a passage in progress ends in `underway`).
  - Each export writes only passages that are new or changed since the last one, and removes the files of passages
    deleted, merged or renamed. Other files in the folder are left alone.
  - Each file is flushed to the drive before it appears, so pulling the drive out never leaves a half-written file.
  - The Export page shows the schedule, the last copy, the next one, and the last failure if any.
- **The database** — `chiplog.sqlite` in the plugin's data folder can be copied while the plugin is stopped.

## Retrospective analysis 🕓

Already have a history of the boat's Signal K data before Chiplog was installed, or from a period the plugin was
stopped? The **Retrospective** page (admin access) reconstructs those passages from it, using the exact same detection
Chiplog runs live — the same thresholds, so a reconstructed passage is one Chiplog would have logged had it been running
at the time.

- Choose a history source in **Apps & Plugins → Configuration**:
  - **Signal K History API** (recommended) reads the server's active history provider, such as
    [signalk-to-influxdb2](https://github.com/tkurki/signalk-to-influxdb2), without database credentials or storage
    schema assumptions.
  - **InfluxDB 1.x (legacy)** requires [signalk-to-influxdb](https://github.com/tkurki/signalk-to-influxdb) to have
    written the boat's data into an InfluxDB 1.x database — local or on another machine — set with host, port, database,
    and a username/password if it needs one.
- Pick a **from** and **to** date on the Retrospective page and start it. It runs in the background — the page shows its
  progress — and can be cancelled at any point; a first quick pass finds when the boat moved, and only those stretches
  are then fetched and reconstructed, so weeks in port take next to no time. Once done, the page sums up what it added:
  passages, distance, time under engine and sail, track points and events; what was already reconstructed up to that
  point stays on record.
- **Refuses to run while a passage is under way**, whatever the date range asked for — it would be reconstructing
  history through the same detection that is simultaneously tracking the live passage.
- **Refuses a range that overlaps a passage already logged**, to avoid a duplicate or a conflicting one. Reconstruction
  only ever adds passages; it does not edit or merge into an existing one.
- **What is not reconstructed**: Signal K alarms and emergencies (`sk_alarm` events), since a typical InfluxDB history
  does not archive notifications the way it does a numeric reading; strong-wind and falling-barometer events while the
  boat lay still between passages; and the extra track points recorded live on turns and speed changes — a reconstructed
  track has one point per **Track point interval**. Everything else read from a continuously published path — position,
  speed, wind, engine, autopilot, depth, barometer — is reconstructed the same as live.

## Importing from PostgSail 📥

Kept your logbook with [PostgSail](https://github.com/xbgmsharp/postgsail) until now? Its GeoJSON export — one trip or
several — comes into Chiplog with the script `scripts/import-postgsail.js`, run from a checkout of this repository (Node
22.13 or later, nothing to install). It talks to the plugin's REST API, so the logbook can be on the boat's Signal K
server while you run it from your own computer.

```bash
node scripts/import-postgsail.js PostgSail_Trip.geojson --url http://boat.local:3000 --token <token>
```

- **Administrator access.** Give the token of an administrator with `--token` (or `CHIPLOG_TOKEN`), or sign in with
  `--user` and `--password` (or `CHIPLOG_PASSWORD`); a server without Signal K security needs neither.
- **Each trip becomes a passage**, with its track, wind and speed, the engine and sail periods read from PostgSail's
  _sailing_ and _motoring_ status, the places from the trip name, and instrument snapshots every hour on the clock
  (`--observation-interval <minutes>`, `0` for none).
- **Safe to run again.** A passage that overlaps one already in the logbook is skipped, so a run cut short is finished
  by running the same command; nothing is duplicated. `--dry-run` lists what the file holds without sending anything.
- **Boat state at departure.** PostgSail's tank level is taken as the fuel tank, and its voltage and state of charge as
  the house battery, noted like Chiplog does live.
- **Not imported:** PostgSail's own distance — Chiplog sums the track, as for every passage, which lands within a few
  percent of it.
- Place names come as PostgSail has them. Passages near a place Chiplog already knows are named the same; the countries
  and landmarks are then looked up in the background, like for any passage. Tide and weather forecasts are not fetched
  for passages this old.

## Privacy and online services 🔒

- **Place names.** With geocoding on, the position of each departure and arrival that matches no known place is sent to
  the geocoding service — OpenStreetMap's public Nominatim by default. Nothing else is sent, and nothing at all when it
  is off.
- **Countries.** With geocoding on, a place whose country is not known yet has its position sent to the geocoding
  service once, to ask which country it is in. Nothing at all when it is off.
- **Landmarks.** With them on, the area a passage sailed through — a half-degree box, not its track — is sent to the
  Overpass service, OpenStreetMap's public instance by default, once per area ever. Nothing at all when it is off.
- **Tide forecast.** With it on, the departure position of each passage is sent to the tide service — the public
  Open-Meteo by default — once, at departure. Nothing at all when it is off.
- **Weather forecast.** With it on, the departure position of each passage is sent to the weather service and to the
  marine service — both the public Open-Meteo by default — once, at departure. Nothing at all when it is off.
- **Maps.** The logbook webapp loads map tiles from OpenStreetMap and OpenSeaMap while the device viewing it is online.
  Offline, the track is still drawn, on a blank background.
- **Retrospective analysis.** Running one queries the InfluxDB database set in the plugin configuration — the boat's
  own, local or remote, never a third party — for the Signal K history in the requested range.
- **Nothing else** leaves the boat. There is no account, analytics or cloud service.

Map data and place names © OpenStreetMap contributors (ODbL); seamarks © OpenSeaMap; tide and weather data ©
[Open-Meteo.com](https://open-meteo.com/) (CC BY 4.0).

## Troubleshooting 🐛

### "Chiplog is not running"

The plugin is disabled or failed to start. Enable it under **Apps & Plugins → Configuration**, and check **Server →
Server Logs** if it does not start.

### "Detected from speed alone"

Chiplog works, but departures and arrivals are decided from speed only. The message says why:

- **"install signalk-autostate"** — nothing publishes `navigation.state`. Install and enable signalk-autostate.
- **"until signalk-autostate makes its first decision"** — normal for a minute or two after the server starts.
- **"has not been updated since…"** — the source named stopped publishing. signalk-autostate republishes every 10
  minutes while it receives position and speed: check that the GPS data reaches the server, and that the plugin is
  enabled.
- **"is “default” (from nmea0183.AI)"** — the source Signal K resolved `navigation.state` to publishes a navigational
  status Chiplog does not use, typically the boat's own AIS transponder. Chiplog follows whichever source the server
  picks, so the fix is on the server: check that signalk-autostate is enabled, and give it priority over the transponder
  in Signal K's source priorities.

### Passages are not opening

Check that `navigation.position` and `navigation.speedOverGround` are updating under **Data → Browser** in the Signal K
admin. Without current data, Chiplog neither opens nor closes passages, and the status shows **Waiting for data**.

### "Your Signal K account is not allowed to do this"

Security is on and you are not signed in, or your account is read-only. Corrections need read/write access; deleting
passages and writing to the USB drive need an admin.

### The tablet says the server does not accept device access requests

Turn on **Allow New Device Registration** under **Security → Settings** in the Signal K admin, or use **Sign in
instead**.

### "No passage to log this in"

No passage is open and the boat is not near the last arrival. Tap **Cast off** or **Anchor up** first.

### The tablet app does not start without a connection

Browsers only allow an app to start offline and to be installed over HTTPS. Turn on SSL under **Server → Settings** in
the Signal K admin, restart, and open the app with `https://` on the SSL port. Over plain HTTP, the app still keeps
entries through Wi-Fi dropouts once it is loaded.

### "The last copy failed" on the Export page

The USB drive is not mounted at the configured directory, or cannot be written. The failure is also written once to the
Signal K server log and shown in the plugin status. Plug the drive back in — and check it is mounted at the same place —
and the next automatic copy catches up with everything that changed meanwhile.

### Wrong dates in the logbook

The server's clock is wrong — common on a Raspberry Pi without a real-time clock. Set it from GPS with
`signalk-set-system-time`.

### Handwriting strokes are dropped or turn into typed text

On an iPad, this is Apple's **Scribble** intercepting the Apple Pencil before the page sees it — a known iPadOS/Safari
limitation with no web-page-level fix (Scribble runs beneath the browser). If it happens often, turn Scribble off under
**Settings → Apple Pencil → Scribble**; a tablet dedicated to Chiplog does not need it.

### A retrospective analysis finishes but reconstructs nothing

Signal K tags historical data with the vessel it came from; a replay only reads data tagged for its own vessel. This
shows up running the replay from a different Signal K server than the one that wrote the history — a development
instance pointed at a production database, typically — since each server has its own vessel identity by default. The
replay's error names the vessel contexts it actually found in the database; set the matching one as **InfluxDB vessel
context** in the plugin configuration.

### A retrospective analysis takes minutes then fails with no clear reason

The InfluxDB server did not answer — unreachable, overloaded, a firewall or a VPN not connected. Each query now gives up
after **Retrospective query timeout** (30 seconds by default) with the connection problem it ran into, rather than
hanging until some far longer, less informative failure; check that the server named in the plugin configuration is
reachable from wherever Signal K runs, and that it is not overloaded — or raise the timeout if it is simply slow to
answer a six-hour chunk.

### A retrospective analysis over several days makes the InfluxDB server unresponsive

The replay first reads one mean speed per minute, a week at a time, then fetches only the stretches where the boat
moved, six hours at a time and already reduced to one value per track interval, with a short pause between requests,
specifically so this does not happen — a boat's InfluxDB often shares a resource-constrained host (a Raspberry Pi) with
Signal K itself, and one query spanning weeks across every path at once can overwhelm it. If it still struggles on a
very small or busy host, run the reconstruction over shorter date ranges instead of the whole history at once.

### Reconstructed passages keep their provisional place names for a while

A replay wakes the geocoding lookup as soon as it finishes, but the lookup itself still needs internet access to succeed
— the passage page shows the raw coordinates until it does. If the boat (or the Signal K server running the replay) has
no internet access at the time, naming is retried on the same backoff as any other departure or arrival, up to an hour
between attempts; nothing is lost, it just takes longer to resolve.

## Limitations 🚧

- **Not yet:** a places page, and editing manoeuvre shortcuts from the webapps.
- **Offline charts** are not provided; the animation draws the tracks on a blank sea when there is no connection.
- **The MP4 export needs a browser with WebCodecs** — Chrome, Edge, Safari 17 or Firefox 130 and later. Without it the
  animation still plays on screen, and the export button is simply not offered.
- **The 3D view needs WebGL 2.** Without it the switch is greyed out and the map view is used. Heel, pitch and sail trim
  are estimated from the wind — the logbook records none of them — and a boat model you load stays in that browser only,
  so it has to be loaded again on another device.
- **A long animation takes a while to export**: every frame waits for its map before it is drawn, so the video is the
  same whatever the connection was doing, but a long range means a lot of tiles. Turning the seamarks off halves them.
- **One vessel per Signal K server**, and no per-crew-member authorship.

## Development 🧑‍💻

```bash
npm install          # also copies the browser libraries into public/vendor/
npm test
npm run lint
npm run demo:seed -- /tmp/chiplog-demo   # a demo logbook to try the webapps with
npm run import:postgsail -- <trips.geojson> --url <server>   # see Importing from PostgSail
```

The functional specification is in [docs/SPEC.md](docs/SPEC.md), the data model in
[docs/DATA_MODEL.md](docs/DATA_MODEL.md), and the REST API in [docs/API.md](docs/API.md). [CLAUDE.md](CLAUDE.md)
describes the code layout and conventions.

`docs/screenshots/` holds the images the Signal K App Store shows for this plugin (`signalk.screenshots` in
`package.json`), taken against a demo logbook (`npm run demo:seed`) with a real browser, e.g.
`google-chrome --headless --window-size=1280,800 --screenshot=docs/screenshots/01-logbook.png http://localhost:3000/signalk-chiplog/?lang=en`.
Retake them after a visible UI change.

## License 📄

MIT — see [LICENSE](LICENSE). Changes are listed in [CHANGELOG.md](CHANGELOG.md).

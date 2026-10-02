# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Language convention

All project artifacts — code, comments, documentation, commit messages — are written in **English**. Conversations with
the repository owner are held in **French**.

## Commands

```bash
npm test                                           # node --test, every test/*.test.{js,mjs}
node --test test/entries.test.js                   # one file
node --test --test-name-pattern="merge" test/      # tests whose name matches
npm run lint          # eslint .
npm run lint:fix      # eslint . --fix
npm run format        # prettier --write .
npm run format:check  # prettier --check .
node scripts/vendor.js  # refresh public/vendor/ (also run by `prepare` on npm install)
npm run demo:seed -- <data dir>  # four demo passages around La Rochelle, dated relative to now
npm run import:postgsail -- <trips.geojson> --url <server> [--token <token>]  # PostgSail GeoJSON export, through the API
```

`scripts/seed-demo.js` writes straight into `<data dir>/chiplog.sqlite` (for a Signal K install:
`~/.signalk/plugin-config-data/signalk-chiplog`, with the plugin stopped) and refuses a logbook that already holds
passages. It covers what the webapp shows — a midnight-spanning passage, a pending place name, every event type, an
active passage — so extend it alongside new UI features; `test/seed-demo.test.js` checks that coverage.

Tests use Node's built-in `node:test` — no framework dependency, matching the `node:sqlite` choice. `test/helpers.js`
starts the plugin behind a real Express 4 app (the version signalk-server uses) with a router that mimics the server's
`asPluginRouter`, recording the access level of each route. Tests seed data by writing SQL directly; the only API route
that creates entries is `POST /entries`, the import.

A husky `pre-commit` hook runs `lint-staged`, which applies `eslint --fix` and `prettier --write` to staged files.
Commits therefore reformat staged code automatically.

## Project state

The plugin's data side is in place: it opens and closes logbook entries from live Signal K data and records their track,
distance, engine/sail segments, instrument snapshots and automatic events (alarms, autopilot, weather thresholds), names
departures and arrivals (known places, then online geocoding), and serves it all through the REST API. The consultation
webapp and the tablet entry PWA exist (below). The PDF logbook is in place too. The documents to read before
implementing anything:

- [docs/SPEC.md](docs/SPEC.md) — functional spec. §7 is a table of settled decisions that supersedes any assumption
  drawn from the feature list.
- [docs/DATA_MODEL.md](docs/DATA_MODEL.md) — schema conventions (SI units, ISO 8601 UTC, naming) and the reasoning
  behind the non-obvious tables. The authoritative DDL is in `lib/database.js`.
- [docs/API.md](docs/API.md) — the REST API contract, which the implementation and tests follow. Update it with any
  behaviour change.

## Code layout

`lib/api.js` is the only HTTP-aware module: it parses and validates requests (`lib/validation.js`), calls the resource
modules, and maps errors to responses. The resource modules (`entries`, `events`, `places`, `propulsion`,
`manoeuvre-types`, `track`, `landmarks`, `statistics`, `export`) take a `db` and plain values, run SQL, return
`camelCase` objects, and throw `ApiError` (`lib/errors.js`) for not-found and conflict cases. Unit conversion to
nautical units happens only in `lib/formats.js`, for human-facing exports.

`lib/passage-import.js` adds a finished passage recorded elsewhere (`POST /entries`, SPEC §4.15): one transaction,
refused when it overlaps a passage on record. `scripts/import-postgsail.js` is its client for PostgSail GeoJSON exports
— a plain Node script that reaches the logbook only through the API, so it works against a remote server; keep it that
way. `test/passage-import.test.js` covers both.

`lib/detection.js` is the passage state machine; SPEC §4.2 describes its behaviour. `index.js` runs its `tick()` every
15 seconds and reports the outcome as the plugin status. Within that tick and transaction, `lib/propulsion-detector.js`
reconciles engine/sail segments and `lib/observation-recorder.js` takes instrument snapshots after the passage is
updated, so segment boundaries reuse the departure, stop and resume times detection worked out — keep them in the same
tick rather than giving propulsion its own timer. `test/boat.js` is the simulator both are tested with.

`lib/event-watcher.js` checks notifications, autopilot and weather every second, on its own timer — alarms can be brief
— with its own freshness tracker. It keeps what it has already logged in memory but seeds that from the `events` table
on first sight, which is what stops restarts from repeating or losing alarms; preserve that when changing it.
`lib/track-recorder.js` samples position every second (SPEC §4.1) and only ever **writes** to the active entry once
detection has it moving, holding points in memory until then; the two share nothing but the database, and detection's
20-minute dating window (`MAX_REFINEMENT_AGE_MS`) bounds how long the recorder holds points. The detector reads Signal K
through `getSelfPath` and takes an injectable clock, so `test/detection.test.js` drives it tick by tick through
simulated passages rather than real time. It keeps nothing about entries in memory — it rereads the active entry every
tick — so API edits (close, merge) are seen immediately. What it does keep in memory (speed samples, freshness, the
previous motion) is lost on restart by design; anything needed across a restart is persisted on the entry.

`lib/usb-scheduler.js` keeps the USB copy (`lib/export.js` `writeUsbExport`) current: `index.js` calls its `tick()`
every 30 s and hands it each detection outcome, an arrival being the active entry going away or changing. Every copy,
the manual one from the API included, goes through its `run()`, which serialises writes — keep it that way rather than
calling `writeUsbExport` directly. Tests inject `write` and a clock.

`lib/logbook-pdf.js` lays out the facsimile PDF and `lib/pdf/` writes it — a small writer with the standard Helvetica
fonts (WinAnsi encoding, metrics in `helvetica.js`), no dependency. Its wording and units come from the webapp's pure
modules (`public/js/i18n.mjs`, `format.mjs`, `log-lines.mjs`, `landmarks.mjs`), loaded with `import()` from CommonJS:
keep those modules free of browser APIs and vendor imports. Characters outside WinAnsi print as `?` unless
`lib/pdf/winansi.js` maps them. `test/pdf-helpers.js` reads the text of a generated PDF back for assertions; to look at
pages, render them to PNG (macOS: PDFKit via a short Swift script).

`lib/place-names.js`, `lib/tide-forecaster.js`, `lib/weather-forecaster.js`, `lib/landmark-finder.js`,
`lib/passage-map.js` (map tiles) and `lib/smtp.js` (the mail relay) are the only network access. Detection names places
synchronously (known place, or coordinates marked pending); `index.js` runs the online lookups as a chain of
`setTimeout`s, each `resolveNext()` saying when the next is due. `lib/tide-forecaster.js` and
`lib/weather-forecaster.js` follow the same shape — `resolveNext()` on the shared engine `lib/departure-forecast.js`,
each run by its own `lib/background-schedule.js` chain, which `index.js` nudges when detection reports a newly opened
passage — to fetch the tide and weather forecasts near a passage's departure (SPEC §4.5.2, §4.5.3), one entry at a time,
giving up (recording an empty result rather than retrying forever) once the departure is too long past for the fetch
window to still mean anything. Tests inject `fetch` and never reach the network — `test/helpers.js` also starts the
plugin with `geocodingEnabled: false`, `landmarksEnabled: false`, `tidesEnabled: false`, `weatherEnabled: false` and
`summaryMailEnabled: false`; keep it that way.

`lib/landmark-finder.js` fills the gazetteer of amers (SPEC §4.13) from Overpass on the same `resolveNext()` shape, one
half-degree cell per request, with `lib/landmarks.js` deciding which cell is wanted (`nextPendingArea`, driven by
`log_entries.landmarks_pending`) and storing the answer. Overpass reports a busy server _in the body_ with HTTP 200 — an
HTML page, or a `remark` beside empty elements — so both count as retryable failures; keep that. Nothing about a bearing
is stored: `public/js/landmarks.mjs` works it out at read time for the webapp and the PDF alike, which is what makes
past passages fill in once their area is fetched.

`lib/summary-mailer.js` emails a summary of each passage once it is definitively closed (SPEC §4.16), on the same
`resolveNext()` shape run by its own `lib/background-schedule.js` chain. A passage is due one when it has stayed closed
longer than `stopClosureMinutes` and has no row in `passage_summary_mails`; the row, written whatever the outcome, is
what stops a second mail, and detection deletes it when a departure reopens the passage. Its parts are each usable on
their own and tested on their own: `lib/passage-summary.js` (the wording and figures, from the webapp's pure modules as
the PDF's are), `lib/passage-map.js` (the track drawn over tiles), `lib/png.js` (reading and writing the PNG, over
`node:zlib`), `lib/mail.js` (addresses and the MIME tree) and `lib/smtp.js` (the client). None of them is reached by a
test over the network: the mailer takes an injectable `fetch` and `createClient`, and `test/smtp.test.js` runs a real
SMTP server on a local port.

`index.js` owns the plugin lifecycle and hands the API a `getContext()` that throws `503` when the database is closed.
This matters because the server calls `registerWithRouter` once — before `start()`, even while the plugin is disabled —
and never removes the routes.

`node:sqlite` has no transaction helper; use `withTransaction` from `lib/database.js` for any multi-statement write. A
call made inside another joins the outer transaction (only the outermost commits or rolls back) — the retrospective
replay relies on it to commit once per slice; never hold one open across an `await`, since live code shares the
connection.

When a design decision is made or changed in conversation, update `docs/SPEC.md` to match; the spec is meant to stay the
single source of truth rather than drift behind the code.

[CHANGELOG.md](CHANGELOG.md) follows Keep a Changelog: add user-visible changes under `[Unreleased]` as they are made,
and move them under a version heading when releasing (with the `package.json` version and a `vX.Y.Z` tag). Pushing that
tag runs [.github/workflows/publish.yml](.github/workflows/publish.yml), which tests, publishes the package to npm (OIDC
trusted publishing, no token to manage) and creates the matching GitHub release, titled with the `signalk.displayName`
from `package.json` and its notes taken verbatim from that version's CHANGELOG section — nothing to run by hand beyond
the tag push.

[README.md](README.md) is the user documentation — installation, what the logbook records, both apps, settings,
troubleshooting. Update it with any user-visible change: a new setting, a changed default, a new screen or behaviour.
Menu names it quotes are those of the Signal K 2.x admin.

## Signal K plugin contract

`index.js` exports `function (app)` returning a plugin object with `id`, `name`, `description`, `schema` (JSON Schema
describing user-facing config rendered by the Signal K admin UI), `start(options)` and `stop()`. The
`signalk-node-server-plugin` keyword in `package.json` is what makes the Signal K server discover the plugin — do not
remove it.

## Planned architecture (per docs/SPEC.md)

Decisions already settled that shape implementation work:

- **Storage**: one SQLite database in the plugin's data folder, holding log entries, events, GPS track points, places,
  and annotations. GPX is generated on demand from track points, never stored as a file. Accessed via Node's built-in
  `node:sqlite` (hence `engines.node >= 22.13`) — deliberately not a native module, since those are painful to install
  on Raspberry Pi.
- **Two UI surfaces**: a standard Signal K webapp (consultation, configuration, export) and a separate installable PWA
  for tablet/stylus field entry.
- **`signalk-autostate` is an optional dependency**: when present, stopped/underway state comes from `navigation.state`;
  when absent, an internal SOG-threshold fallback takes over and the UI must signal degraded mode. Both paths need to
  work. autostate lags real movement by several minutes, which is why transitions are dated from raw speed whichever
  mode decided.
- **One vessel per Signal K instance** — no multi-vessel or multi-profile concepts in the data model.
- **Handwritten annotations are stored as vector strokes** (timestamped points with pressure), not raster, captured by
  the tablet PWA.
- **Log entry granularity**: a start → underway → stop cycle, with a configurable stop-duration threshold tolerating
  short stops (lock waits, lunch anchorages) within a single entry.

## Database migrations

`lib/database.js` holds a `MIGRATIONS` array applied in order, with the array index tracked in SQLite's `user_version`.
Migrations are **append-only**: once an entry has been released, editing or reordering it would leave existing boat
installations on a schema that no longer matches the code. Add a new entry instead. An entry is normally a SQL string
run in a transaction; it may instead be a function `(db, version)` — the only way to change a CHECK constraint (SQLite
can't ALTER one, so the table is rebuilt) or to toggle a pragma like `foreign_keys`, which has no effect inside a
transaction. A function migration sets `user_version` itself.

## Webapp

`public/` is the consultation webapp; the `signalk-webapp` keyword makes Signal K serve it at `/signalk-chiplog/`. It
has **no build step**: native ES modules (`.mjs`, served as JavaScript) and Preact + htm from a single vendored file,
`public/vendor/preact-htm.mjs`. Consequences to keep in mind:

- No bare imports (`import 'preact'`) and no import maps — only relative paths. Third-party browser code comes from
  `scripts/vendor.js`, which copies it out of `node_modules`; `public/vendor/` is git-ignored but published through the
  `files` field in `package.json`. Never load anything from a CDN: the boat is usually offline.
- Pure logic lives in modules that import nothing from `vendor/` (`format.mjs`, `days.mjs`, `i18n.mjs`,
  `view-memory.mjs`), so `test/webapp-*.test.mjs` can import them under Node. Components are verified in a real browser
  against a real Signal K server, not with a DOM test framework.
- Every user-facing string goes in **both** dictionaries of `public/js/i18n.mjs`; a test fails on a missing key or a
  mismatched `{placeholder}`.
- The animation's 3D view brings **three.js**, and it cannot be copied like the rest: its add-ons import the bare
  specifier `'three'`. `scripts/vendor.js` bundles `scripts/three-entry.mjs` with esbuild into one minified
  `public/vendor/three.min.mjs`, which only `public/js/animation/renderer3d.mjs` and `boat-model.mjs` import — and only
  `renderer3d.mjs` is ever `import()`ed, lazily, by the page. Add a name to the entry when those modules start using it
  (`test/webapp-animation-3d-support.test.mjs` fails otherwise). A 3D frame must stay a pure function of the film's
  state and time, like a 2D one: nothing may read a clock, or an export would differ from the preview.
- User text is only ever rendered through htm, which escapes it. Leaflet renders string tooltips as HTML, so pass it DOM
  nodes for anything the crew typed (see `TrackMap.mjs`).
- Prettier leaves `html` templates alone in `public/` (`embeddedLanguageFormatting: off`): htm drops whitespace that
  contains a newline, so reflowing a template changes what is displayed. Build text such as `start – end` as one string.
- The API returns SI units; conversion for display happens only in `format.mjs`.
- Going back to a view lands where the reader left it: `public/js/view-memory.mjs` holds, per view, what it wants to
  find again. `useRoute` in `context.mjs` saves the outgoing view's scroll on a hash change and scrolls to the top only
  for a view with nothing remembered; `LogView.mjs` is the one that remembers — the passages it had loaded and the
  scroll — and re-renders from them before restoring the scroll in a layout effect, which is what keeps the page from
  jumping. A view that never calls `remember` is never restored, so adding one is opting in.

## Tablet entry PWA

`public/entry/` is the field-entry app, served at `/signalk-chiplog/entry/` by the same webapp mount and built the same
way (no build step, shared `public/js/` modules, both dictionaries). It posts to `POST /events`, which picks the passage
server-side — see docs/API.md and SPEC §4.3.

- The logic is in modules free of vendor imports and tested under Node (`test/entry-modules.test.mjs`): `journal.mjs`
  (send now, else queue; undo and comment follow an entry whether queued or logged), `outbox.mjs` (ordered replay;
  transient failures keep an entry, refusals set it aside), `clock.mjs` (server clock from the `Date` header),
  `strokes.mjs`, `access.mjs` (Signal K device access requests). Components only wire them to the page.
- Every entry carries a `clientRef`, and queued entries carry the time they were made. Keep both when adding an entry
  type: the server relies on them to avoid duplicates and to date and place replayed entries.
- `sw.js` precaches the app shell; a test fails if a module `main.mjs` imports (directly or not) is missing from its
  `SHELL` list. Service workers need HTTPS or localhost, so the app must keep working without one. The Browser pane
  cannot register service workers at all — verify offline start-up in a real Chrome.
- `crypto.randomUUID` is unavailable over plain HTTP, the usual boat set-up: use `randomId()` from `public/js/ids.mjs`.
- `public/js/api.mjs` sends the device token (`public/js/auth.mjs`) when one is stored, for both apps.

## Code style

Prettier: single quotes, semicolons, `printWidth` 100, no trailing commas. Markdown files get their own override —
`printWidth` 120 with `proseWrap: "always"`, so prose is hard-wrapped to 120 columns; a table row or a single long link
or inline-code span is left alone since wrapping one would break it. ESLint uses flat config (`eslint.config.js`) with
`js.configs.recommended`, CommonJS source type, Node globals, and `eslint-config-prettier` last so formatting rules
never conflict. `no-unused-vars` is a warning and ignores function arguments — unused `options`/`app` parameters in
Signal K callbacks are expected.

## Markdown & Documentation Guidelines

- Always use standard Markdown formatting with explicit syntax highlighting for code blocks.
- Keep README files highly scannable: use clean tables, bullet points starting with bold text, and visual anchors
  (emojis).
- Ensure a blank line exists before and after every header, list, and code block to avoid rendering bugs on GitHub.

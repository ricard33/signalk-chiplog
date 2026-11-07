# Shared scenarios

Scenarios of a boat's data and its crew's actions, played on the plugin's logbook engine. They are shared with the
companion apps, such as one that keeps the logbook itself on boats without a Signal K server and ports these rules: the
app copies the scenarios and their results from a given version of the plugin and plays them on its own engine. A rule
changed here and not there, or the other way round, then shows in a test rather than at sea.

- `<name>.json`: a scenario, written by hand.
- `<name>.result.json`: what the logbook engine made of it, written by `npm run scenarios`
  (`scripts/record-scenarios.js`), never by hand. `test/scenarios.test.js` checks it is still current: after changing a
  rule on purpose, record again and review the diff of the results with the change.
- `player.js`: plays a scenario the way `test/boat.js` drives a simulated vessel — a fake clock, Signal K values
  published, then on every 15 s tick the track recorder, the event watcher and the detector, in that order.

## A scenario

```json
{
  "description": "What it shows, one sentence.",
  "settings": { "stopClosureMinutes": 30 },
  "start": "2026-09-13T08:00:00.000Z",
  "position": { "lat": 46.1466, "lon": -1.1686 },
  "clockOffsetMinutes": 0,
  "places": [{ "name": "Les Minimes", "lat": 46.1466, "lon": -1.1686 }],
  "steps": [
    { "sail": 5, "values": { "navigation.speedOverGround": 2.572, "propulsion.main.revolutions": 0 } },
    { "sail": 5, "sources": { "navigation.state": { "signalk-autostate.XX": "moored" } } },
    { "crew": { "type": "manoeuvre", "subtype": "tack" } },
    { "close": true },
    { "correct": "engine" },
    { "crewMembers": ["Alex", "Sam"] },
    { "restart": 180 },
    { "nameArrival": "Le Bourg" },
    { "addPlace": "Île de Ré" }
  ]
}
```

- `settings` override the plugin's defaults (detection, propulsion, observations, track, events), by their names in the
  plugin configuration. `start` and `position` default to the values above; `clockOffsetMinutes` shifts the Signal K
  timestamps away from the clock.
- `sail` advances by whole 15 s ticks and publishes, on each, its `values` — Signal K paths and SI units — and its
  `sources`, one path from several sources, the last one winning as on the server. A value is a constant, a list of one
  value per minute (the last one held), or `{ "cycle": [...] }`, one value per tick in turn. A speed over ground also
  moves the boat due north and publishes its position. Paths left out are not refreshed, so they fall silent.
- `crew` logs an entry of the crew now, as `POST /api/events` does, reading included; `close` closes the open passage as
  the crew does; `correct` sets the type of the open passage's latest engine or sail period; `crewMembers` adds people
  to the open passage's crew; `restart` stops the plugin and starts it again that many minutes later; `nameArrival`
  names the open passage's arrival; `addPlace` adds a known place where the boat is.

## A result

The state after each step (mode, motion, propulsion, open passage), then the logbook: passages, track (count of points,
first and last), engine and sail periods, events and observations. Passages are referred to by their order; ids and
creation times are left out, and numbers are rounded (6 decimals, distances 1, average revolutions 2), so that the last
bits of two languages' floating-point maths do not count.

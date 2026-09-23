const { MAX_AGE_MS, UNDERWAY_STATES } = require('./detection');

// What both history backends (lib/influx-history.js, lib/history-api.js) need
// once the values are fetched: holding them in memory and answering them back
// the way `app.getSelfPath` would have at a historical instant. Only fetching
// differs between the two -- keeping the rest here is what stops them drifting
// apart, since a replayed passage must be the same whichever source it came
// from.

function iso(ms) {
  return new Date(ms).toISOString();
}

// The last entry at or before `atMs` in a series sorted by time, or
// `undefined` if the series has nothing yet at that point -- what
// `app.getSelfPath` would have answered live at that historical instant.
// Binary search: the replay loop asks this for every path at every step, so a
// linear scan over a window's worth of readings costs far more than the fetch.
function lastAtOrBefore(series, atMs) {
  let lo = 0;
  let hi = series.length - 1;
  let result = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (series[mid].time <= atMs) {
      result = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return result === -1 ? undefined : series[result];
}

// The values of a window, by path and -- for the paths a backend reports per
// source -- by source within it. `add` takes values in any order; `sort` must
// be called once a window is loaded, before reading.
function createSeriesStore() {
  // path -> [{ time, node }], ascending by time; `node` is what readSelfPath
  // answers, built once here rather than on every read.
  const series = new Map();
  // path -> source -> [{ time, node }], for the paths added with a source.
  const multiSource = new Map();

  function listOf(map, key) {
    if (!map.has(key)) {
      map.set(key, []);
    }
    return map.get(key);
  }

  return {
    // `source` given puts the value in a per-source series, which readSelfPath
    // then answers with `values`/`$source` like the server itself.
    add(path, time, value, source) {
      if (value === null || value === undefined || !Number.isFinite(time)) {
        return;
      }
      const node = { value, timestamp: iso(time) };
      if (source === undefined) {
        listOf(series, path).push({ time, node });
        return;
      }
      if (!multiSource.has(path)) {
        multiSource.set(path, new Map());
      }
      listOf(multiSource.get(path), source).push({ time, node });
    },

    sort() {
      const byTime = (a, b) => a.time - b.time;
      for (const list of series.values()) {
        list.sort(byTime);
      }
      for (const bySource of multiSource.values()) {
        for (const list of bySource.values()) {
          list.sort(byTime);
        }
      }
    },

    // Matches `app.getSelfPath(path)` at that historical instant: `undefined`
    // with nothing yet, otherwise `{ value, timestamp }` -- or, for a path
    // added per source, also `values`/`$source` like the server itself, which
    // resolves it to the source that published last (SPEC 4.2).
    readSelfPath(path, atMs) {
      const bySource = multiSource.get(path);
      if (bySource) {
        let latest = null;
        const values = {};
        for (const [source, list] of bySource) {
          const found = lastAtOrBefore(list, atMs);
          if (found) {
            values[source] = found.node;
            if (!latest || found.time > latest.time) {
              latest = { ...found, source };
            }
          }
        }
        return latest ? { ...latest.node, $source: latest.source, values } : undefined;
      }
      return lastAtOrBefore(series.get(path) ?? [], atMs)?.node;
    },

    clear() {
      series.clear();
      multiSource.clear();
    }
  };
}

// The stretches an under-way navigation.state covers, for a motion scan:
// each state counts until the next one -- whichever source published either,
// since the server resolves the path to the value received last (SPEC 4.2) --
// or until it would have gone stale, whichever comes first. `rows` are
// `{ time, value }` in any order, `bucketMs` the scan's bucket when they were
// read bucketed.
function underwayIntervals(
  rows,
  { fromMs, bucketMs = 0, maxAge = MAX_AGE_MS['navigation.state'] }
) {
  const states = [...rows].sort((a, b) => a.time - b.time);
  const intervals = [];
  states.forEach((row, index) => {
    if (!UNDERWAY_STATES.has(row.value)) {
      return;
    }
    const next = states[index + 1];
    const until = Math.min(next ? next.time : Infinity, row.time + bucketMs + maxAge);
    const from = Math.max(row.time, fromMs);
    if (until > from) {
      intervals.push({ from, to: until });
    }
  });
  return intervals;
}

module.exports = { createSeriesStore, lastAtOrBefore, underwayIntervals, iso };

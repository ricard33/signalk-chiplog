// Pure tide-curve helpers: no vendor imports, so plain Node can test them.

// The local highs and lows in an hourly curve. Hourly resolution, so a time
// is only accurate to within about half an hour; a high or low exactly at
// either end of the fetched window is not detected, having no neighbour on
// that side to compare against.
export function tideExtremes(points) {
  const extremes = [];
  for (let i = 1; i < points.length - 1; i += 1) {
    const { height } = points[i];
    if (height > points[i - 1].height && height > points[i + 1].height) {
      extremes.push({ type: 'high', time: points[i].time, height });
    } else if (height < points[i - 1].height && height < points[i + 1].height) {
      extremes.push({ type: 'low', time: points[i].time, height });
    }
  }
  return extremes;
}

// The hour scale under the curve: the samples whose local hour is a multiple of
// `step`, labelled by `label` (the formatter's `time`, so the zone and the
// 24-hour clock are the reader's). Samples are used as they are rather than
// recomputed from the clock, so a zone that is not on a whole hour still lines
// up with the curve.
export function hourTicks(points, label, step = 3) {
  return points
    .map((point) => ({ time: point.time, label: label(point.time) }))
    .filter((tick) => Number(tick.label.slice(0, 2)) % step === 0);
}

// A smoothed SVG path through the points, quadratic Bezier segments via
// midpoints -- simple, and hourly samples are dense enough that it reads as
// a real tide curve rather than a jagged line.
export function smoothPath(coords) {
  if (coords.length === 0) {
    return '';
  }
  if (coords.length < 3) {
    return coords.map((c, i) => `${i === 0 ? 'M' : 'L'} ${c.x} ${c.y}`).join(' ');
  }
  let d = `M ${coords[0].x} ${coords[0].y}`;
  for (let i = 1; i < coords.length - 2; i += 1) {
    const midX = (coords[i].x + coords[i + 1].x) / 2;
    const midY = (coords[i].y + coords[i + 1].y) / 2;
    d += ` Q ${coords[i].x} ${coords[i].y} ${midX} ${midY}`;
  }
  const last = coords.at(-1);
  const secondLast = coords.at(-2);
  d += ` Q ${secondLast.x} ${secondLast.y} ${last.x} ${last.y}`;
  return d;
}

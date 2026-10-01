import { html, useEffect, useRef, useState } from '../../vendor/preact-htm.mjs';
import { apiUrl, fetchAll, get, request } from '../api.mjs';
import { useLocale, usePolling } from '../context.mjs';
import { animationHash, dayKey } from '../days.mjs';
import { batteryName, engineHours, engineName, tankName } from '../log-lines.mjs';
import { elapsedSeconds, ErrorNotice, Loading, PlaceName, passageTitle } from './common.mjs';
import { CrewCard } from './CrewCard.mjs';
import { PropulsionStrip } from './PropulsionStrip.mjs';
import { TideCard } from './TideCard.mjs';
import { Timeline } from './Timeline.mjs';
import { TrackMap } from './TrackMap.mjs';
import { TrackScrubber } from './TrackScrubber.mjs';
import { WeatherCard } from './WeatherCard.mjs';
import { stepDirection } from '../shortcuts.mjs';
import { trackPoints } from '../track.mjs';

const ACTIVE_REFRESH_MS = 60 * 1000;

// The animation is a page of its own, over a date range; a passage links to it
// with its own days already filled in.
function animationLink(entry, format) {
  return animationHash(format.dayKey(entry.startTime), format.dayKey(entry.endTime ?? Date.now()));
}

async function findPrevious(entry) {
  const page = await get(`/entries?to=${encodeURIComponent(entry.startTime)}&limit=1`);
  return page.items[0] ?? null;
}

// Entries come newest first, so the next passage is the last of those after.
async function findNext(entry) {
  const from = encodeURIComponent(new Date(Date.parse(entry.startTime) + 1).toISOString());
  const { total } = await get(`/entries?from=${from}&limit=1`);
  if (total === 0) {
    return null;
  }
  const page = await get(`/entries?from=${from}&limit=1&offset=${total - 1}`);
  return page.items[0] ?? null;
}

// No forecast is a normal outcome (not yet fetched, or none for the
// position), not an error the page should show.
async function loadForecast(id, kind) {
  try {
    return await get(`/entries/${id}/${kind}`);
  } catch (err) {
    if (err.code === `${kind}_not_found`) {
      return null;
    }
    throw err;
  }
}

async function loadPassage(id) {
  const [entry, track, segments, events, observations, landmarks, manoeuvreTypes, tide, weather] =
    await Promise.all([
      get(`/entries/${id}`),
      get(`/entries/${id}/track`),
      fetchAll(`/entries/${id}/propulsion`),
      fetchAll(`/entries/${id}/events`),
      fetchAll(`/entries/${id}/observations`),
      fetchAll(`/entries/${id}/landmarks`),
      fetchAll('/manoeuvre-types'),
      loadForecast(id, 'tide'),
      loadForecast(id, 'weather')
    ]);
  const [previous, next] = await Promise.all([findPrevious(entry), findNext(entry)]);
  return {
    entry,
    track,
    segments,
    events,
    observations,
    landmarks,
    manoeuvreLabels: Object.fromEntries(manoeuvreTypes.map((type) => [type.key, type.label])),
    tide,
    weather,
    previous,
    next
  };
}

// One table of the boat's state: a row per engine, tank or battery, its
// reading at departure, and optionally at arrival (or the latest, for a
// passage in progress) and what changed in between.
function StateTable({ caption, subject, rows, active, withEnd, change }) {
  const { t } = useLocale();
  if (rows.length === 0) {
    return null;
  }
  return html`
    <table class="state-table">
      <caption>
        ${caption}
      </caption>
      <thead>
        <tr>
          <th scope="col">${subject}</th>
          <th scope="col">${t('passage.engineHoursStart')}</th>
          ${withEnd && html`<th scope="col">${active ? t('passage.engineHoursLatest') : t('passage.engineHoursEnd')}</th>`}
          ${change && html`<th scope="col">${change}</th>`}
        </tr>
      </thead>
      <tbody>
        ${rows.map(
          (row) => html`<tr key=${row.key}>
            <th scope="row">${row.name}</th>
            <td>${row.start}</td>
            ${withEnd && html`<td>${row.end}</td>`}
            ${change && html`<td>${row.change}</td>`}
          </tr>`
        )}
      </tbody>
    </table>
  `;
}

// What a paper log notes before casting off: engine hours -- with the same at
// arrival -- and the tanks and batteries noted as the passage opened.
function BoatState({ entry, observations, active }) {
  const { t, format } = useLocale();
  const engines = engineHours(observations).map((engine) => ({
    key: engine.engine,
    name: engineName(engine.engine, t),
    start: format.hours(engine.start),
    end: format.hours(engine.end),
    change: format.hours(engine.run)
  }));
  const tanks = entry.startTanks ?? [];
  const batteries = entry.startBatteries ?? [];
  const tank = (reading) =>
    [format.percent(reading.level), format.volume(reading.volume)].filter(Boolean).join(' · ');
  const battery = (reading) =>
    [
      format.percent(reading.stateOfCharge),
      format.voltage(reading.voltage),
      format.current(reading.current)
    ]
      .filter(Boolean)
      .join(' · ');
  if (engines.length + tanks.length + batteries.length === 0) {
    return null;
  }
  return html`
    <section class="card">
      <h2>${t('passage.boatState')}</h2>
      <${StateTable}
        caption=${t('passage.engineHours')}
        subject=${t('passage.engineHoursEngine')}
        rows=${engines}
        active=${active}
        withEnd
        change=${t('passage.engineHoursRun')}
      />
      <${StateTable}
        caption=${t('passage.tanks')}
        subject=${t('passage.tank')}
        rows=${tanks.map((item) => ({
          key: `${item.type}.${item.id}`,
          name: tankName(item, t, tanks),
          start: tank(item)
        }))}
      />
      <${StateTable}
        caption=${t('passage.batteries')}
        subject=${t('passage.battery')}
        rows=${batteries.map((item) => ({
          key: item.id,
          name: batteryName(item, t),
          start: battery(item)
        }))}
      />
    </section>
  `;
}

function NameField({ label, name, pending, busy, onSave }) {
  const { t } = useLocale();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name ?? '');
  const input = useRef(null);

  useEffect(() => {
    if (!editing) {
      setDraft(name ?? '');
    }
  }, [name, editing]);

  // The Edit button disappears when clicked, which would leave focus nowhere.
  useEffect(() => {
    if (editing) {
      input.current?.focus();
      input.current?.select();
    }
  }, [editing]);

  const submit = (event) => {
    event.preventDefault();
    const trimmed = draft.trim();
    setEditing(false);
    onSave(trimmed === '' ? null : trimmed);
  };

  return html`
    <div class="name-field">
      <span class="name-label">${label}</span>
      ${
        editing
          ? html`<form class="name-form" onSubmit=${submit}>
              <input
                ref=${input}
                value=${draft}
                maxlength="200"
                aria-label=${label}
                onInput=${(event) => setDraft(event.currentTarget.value)}
              />
              <button type="submit" disabled=${busy}>${t('common.save')}</button>
              <button type="button" class="link-button" onClick=${() => setEditing(false)}>
                ${t('common.cancel')}
              </button>
            </form>`
          : html`<${PlaceName} name=${name} pending=${pending} />
              <button
                type="button"
                class="link-button"
                disabled=${busy}
                onClick=${() => setEditing(true)}
              >
                ${t('common.edit')}
              </button>`
      }
    </div>
  `;
}

// A neighbouring passage, or its place kept as a dimmed label at the log's end.
// `shortcut` is the key that does the same, told in the tooltip.
function StepLink({ id, label, shortcut, keyName }) {
  return id === null
    ? html`<span class="muted" aria-disabled="true">${label}</span>`
    : html`<a href=${`#/passages/${id}`} title=${shortcut} aria-keyshortcuts=${keyName}>${label}</a>`;
}

export function PassageView({ id }) {
  const { t, format } = useLocale();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);
  // null follows the latest point as new ones arrive; scrubbing pins it.
  const [selectedIndex, setSelectedIndex] = useState(null);
  const active = data?.entry.state === 'active';
  // Only the neighbours of the passage on screen, not of the one just left.
  const shown = data?.entry.id === id ? data.entry : null;
  const previousId = shown?.previousEntryId ?? null;
  const nextId = shown?.nextEntryId ?? null;

  // Alt+arrow steps through the log. The key is taken even at either end of it,
  // where it does nothing, rather than left to the browser's own Alt+left: back.
  useEffect(() => {
    const onKeyDown = (event) => {
      const direction = stepDirection(event);
      if (direction === null) {
        return;
      }
      event.preventDefault();
      const target = direction === 'previous' ? previousId : nextId;
      if (target !== null && !event.repeat) {
        location.hash = `#/passages/${target}`;
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [previousId, nextId]);

  // A different passage starts by following its latest point too, not
  // wherever the scrubber was left on the previous one.
  useEffect(() => setSelectedIndex(null), [id]);

  usePolling(
    (isCurrent) => {
      loadPassage(id)
        .then((next) => {
          if (isCurrent()) {
            setData(next);
            setError(null);
          }
        })
        .catch((err) => isCurrent() && setError(err));
    },
    active ? ACTIVE_REFRESH_MS : 0,
    [id, version, active]
  );

  if (error && (!data || error.code === 'entry_not_found')) {
    return html`
      <a class="back" href="#/">← ${t('passage.back')}</a>
      ${
        error.code === 'entry_not_found'
          ? html`<p class="notice">${t('passage.notFound')}</p>`
          : html`<${ErrorNotice} error=${error} onRetry=${() => setVersion((v) => v + 1)} />`
      }
    `;
  }
  if (!data || data.entry.id !== id) {
    return html`<${Loading} />`;
  }

  const { entry } = data;
  const reload = () => setVersion((v) => v + 1);
  const act = async (action) => {
    setBusy(true);
    setActionError(null);
    try {
      await action();
    } catch (err) {
      setActionError(err);
    } finally {
      setBusy(false);
    }
  };

  const rename = (side, name) =>
    act(async () => {
      await request('PATCH', `/entries/${id}`, { [`${side}PlaceName`]: name });
      reload();
    });
  const switchSegment = (segment) =>
    act(async () => {
      await request('PATCH', `/propulsion/${segment.id}`, {
        type: segment.type === 'engine' ? 'sail' : 'engine'
      });
      reload();
    });
  const close = () =>
    confirm(t('corrections.closeConfirm')) &&
    act(async () => {
      await request('POST', `/entries/${id}/close`);
      reload();
    });
  const merge = (other) =>
    confirm(t('corrections.mergeConfirm', { other: passageTitle(other, t) })) &&
    act(async () => {
      const survivor = await request('POST', `/entries/${id}/merge`, { withEntryId: other.id });
      if (survivor.id === id) {
        reload();
      } else {
        location.hash = `#/passages/${survivor.id}`;
      }
    });
  const remove = () =>
    confirm(t('corrections.deleteConfirm')) &&
    act(async () => {
      await request('DELETE', `/entries/${id}`);
      location.hash = '#/';
    });
  const editEvent = (event, patch) =>
    act(async () => {
      await request('PATCH', `/events/${event.id}`, patch);
      reload();
    });
  const deleteEvent = (event) =>
    confirm(
      t(event.type === 'sk_alarm' ? 'timeline.deleteAlarmConfirm' : 'timeline.deleteConfirm')
    ) &&
    act(async () => {
      await request('DELETE', `/events/${event.id}`);
      reload();
    });

  const sameDay =
    entry.endTime && dayKey(new Date(entry.startTime)) === dayKey(new Date(entry.endTime));
  const ending = entry.endTime
    ? sameDay
      ? format.time(entry.endTime)
      : `${format.shortDate(entry.endTime)} ${format.time(entry.endTime)}`
    : t('log.inProgress');
  const when = `${format.day(new Date(entry.startTime))}, ${format.time(entry.startTime)} – ${ending}`;
  const underway = entry.engineDuration + entry.sailDuration;
  const hasMap = Boolean(data.track.geometry || entry.startPosition);
  const points = trackPoints(data.track);
  const scrubIndex = Math.min(selectedIndex ?? points.length - 1, points.length - 1);
  const boat = points[scrubIndex] ?? null;

  return html`
    <div class="passage-nav">
      <a class="back" href="#/">← ${t('passage.back')}</a>
      <div class="passage-steps">
        <${StepLink}
          id=${entry.previousEntryId}
          label=${`← ${t('passage.previous')}`}
          shortcut="Alt+←"
          keyName="Alt+ArrowLeft"
        />
        <${StepLink}
          id=${entry.nextEntryId}
          label=${`${t('passage.next')} →`}
          shortcut="Alt+→"
          keyName="Alt+ArrowRight"
        />
      </div>
    </div>

    <header class="passage-header">
      <h1>
        <${PlaceName} name=${entry.startPlaceName} pending=${entry.startPlacePending} />
        <span aria-hidden="true"> → </span>
        ${
          entry.endTime
            ? html`<${PlaceName} name=${entry.endPlaceName} pending=${entry.endPlacePending} />`
            : '…'
        }
      </h1>
      <p class="passage-when">${when}</p>
      ${
        active &&
        html`<span class="badge">
          ${
            entry.stoppedSince
              ? t('passage.stoppedSince', { time: format.time(entry.stoppedSince) })
              : t('passage.inProgress')
          }
        </span>`
      }
    </header>

    <dl class="facts">
      <div>
        <dt>${t('passage.distance')}</dt>
        <dd>${format.distance(entry.distance)}</dd>
      </div>
      <div>
        <dt>${t('passage.duration')}</dt>
        <dd>${format.duration(elapsedSeconds(entry))}</dd>
      </div>
      <div>
        <dt>${t('passage.underway')}</dt>
        <dd>${format.duration(underway)}</dd>
      </div>
      <div>
        <dt>${t('passage.engine')}</dt>
        <dd class="fact-engine">${format.duration(entry.engineDuration)}</dd>
      </div>
      <div>
        <dt>${t('passage.sail')}</dt>
        <dd class="fact-sail">${format.duration(entry.sailDuration)}</dd>
      </div>
      ${
        underway > 0 &&
        html`<div>
          <dt>${t('passage.averageSpeed')}</dt>
          <dd>${format.speed(entry.distance / underway)}</dd>
        </div>`
      }
      ${
        entry.maxSpeed !== null &&
        html`<div>
          <dt>${t('passage.maxSpeed')}</dt>
          <dd>${format.speed(entry.maxSpeed)}</dd>
        </div>`
      }
      ${
        entry.maxWindSpeed !== null &&
        html`<div>
          <dt>${t('passage.maxWind')}</dt>
          <dd>
            ${
              entry.maxWindApparent
                ? `${format.speed(entry.maxWindSpeed)} ${t('timeline.apparent')}`
                : format.speed(entry.maxWindSpeed)
            }
          </dd>
        </div>`
      }
    </dl>

    <section class="card">
      <header class="card-header">
        <h2>${t('passage.track')}</h2>
        <div class="card-header-actions">
          ${
            points.length > 1 &&
            html`<a href=${animationLink(entry, format)}>${t('passage.animate')}</a>`
          }
          ${
            data.track.geometry &&
            html`<a href=${apiUrl(`/entries/${id}/track?format=gpx`)} download
              >${t('passage.downloadGpx')}</a
            >`
          }
        </div>
      </header>
      ${
        hasMap
          ? html`<${TrackMap} track=${data.track} entry=${entry} boat=${boat} />
              <${TrackScrubber}
                points=${points}
                index=${scrubIndex}
                onIndexChange=${setSelectedIndex}
              />`
          : html`<p class="muted">${t('passage.noTrack')}</p>`
      }
    </section>

    ${data.weather && html`<${WeatherCard} weather=${data.weather} placeName=${entry.startPlaceName} />`}

    <div class="card-row">
      ${data.tide && html`<${TideCard} tide=${data.tide} placeName=${entry.startPlaceName} />`}

      <section class="card">
        <h2>${t('passage.propulsion')}</h2>
        <${PropulsionStrip}
          segments=${data.segments}
          entry=${entry}
          busy=${busy}
          onSwitch=${switchSegment}
        />
      </section>

      <${BoatState} entry=${entry} observations=${data.observations} active=${active} />

      <${CrewCard} crew=${entry.crew} />
    </div>

    <section class="card">
      <h2>${t('passage.log')}</h2>
      <${Timeline}
        events=${data.events}
        observations=${data.observations}
        landmarks=${data.landmarks}
        bounds=${{ start: entry.startTime, end: entry.endTime }}
        manoeuvreLabels=${data.manoeuvreLabels}
        busy=${busy}
        onEditEvent=${editEvent}
        onDelete=${deleteEvent}
      />
    </section>

    <section class="card corrections">
      <h2>${t('corrections.title')}</h2>
      <${ErrorNotice} error=${actionError} />
      <p class="muted">${t('corrections.renameHint')}</p>
      <${NameField}
        label=${t('passage.departure')}
        name=${entry.startPlaceName}
        pending=${entry.startPlacePending}
        busy=${busy}
        onSave=${(name) => rename('start', name)}
      />
      ${
        !active &&
        html`<${NameField}
          label=${t('passage.arrival')}
          name=${entry.endPlaceName}
          pending=${entry.endPlacePending}
          busy=${busy}
          onSave=${(name) => rename('end', name)}
        />`
      }
      <div class="actions">
        ${
          active &&
          html`<button type="button" disabled=${busy} onClick=${close}>
            ${t('corrections.close')}
          </button>`
        }
        ${
          data.previous &&
          html`<button type="button" disabled=${busy} onClick=${() => merge(data.previous)}>
            ${t('corrections.mergePrevious')}
          </button>`
        }
        ${
          data.next &&
          !active &&
          html`<button type="button" disabled=${busy} onClick=${() => merge(data.next)}>
            ${t('corrections.mergeNext')}
          </button>`
        }
        <button type="button" class="danger" disabled=${busy} onClick=${remove}>
          ${t('corrections.delete')}
        </button>
      </div>
    </section>
  `;
}

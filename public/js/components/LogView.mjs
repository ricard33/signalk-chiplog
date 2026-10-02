import { html, useEffect, useLayoutEffect, useRef, useState } from '../../vendor/preact-htm.mjs';
import { get } from '../api.mjs';
import { useLocale, usePolling, viewMemory } from '../context.mjs';
import { groupByDay } from '../days.mjs';
import { elapsedSeconds, EngineSailBar, ErrorNotice, Loading, PlaceName } from './common.mjs';

const VIEW = 'log';
const PAGE_SIZE = 50;
// Roughly a screenful and a half: far enough that the top is out of reach, not
// so soon that the button sits over the first passages.
const TO_TOP_AFTER_PX = 1200;
const API_PAGE_LIMIT = 500;
const REFRESH_MS = 60 * 1000;

// Reloads everything loaded so far, so a refresh does not drop older pages.
async function loadEntries(count) {
  const items = [];
  let total = 0;
  while (items.length < count) {
    const limit = Math.min(API_PAGE_LIMIT, count - items.length);
    const page = await get(`/entries?limit=${limit}&offset=${items.length}`);
    total = page.total;
    items.push(...page.items);
    if (page.items.length === 0 || items.length >= total) {
      break;
    }
  }
  return { items, total };
}

// The logbook is long, and longer still with the older pages loaded: a way back
// to the top that is not a scroll. Focus follows the scroll to the title, or a
// reader on the keyboard would be left at the bottom of the page.
function BackToTop({ title }) {
  const { t } = useLocale();
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const onScroll = () => setShown(window.scrollY > TO_TOP_AFTER_PX);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  if (!shown) {
    return null;
  }

  const toTop = () => {
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    window.scrollTo({ top: 0, behavior: still ? 'auto' : 'smooth' });
    title.current?.focus({ preventScroll: true });
  };

  return html`
    <button
      type="button"
      class="to-top"
      aria-label=${t('log.toTop')}
      title=${t('log.toTop')}
      onClick=${toTop}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7" /></svg>
    </button>
  `;
}

// Totals across every passage ever logged, not just the pages loaded so far.
function LogStats({ stats }) {
  const { t, format } = useLocale();
  return html`
    <dl class="facts log-stats">
      <div>
        <dt>${t('log.statsCount')}</dt>
        <dd>${stats.count}</dd>
      </div>
      <div>
        <dt>${t('log.statsDistance')}</dt>
        <dd>${format.distance(stats.distance)}</dd>
      </div>
      <div>
        <dt>${t('log.statsDuration')}</dt>
        <dd>${format.duration(stats.duration)}</dd>
      </div>
    </dl>
  `;
}

function PassageCard({ entry, continuesFromPreviousDay, continuesNextDay }) {
  const { t, format } = useLocale();
  const at = (value, withDate) =>
    withDate ? `${format.shortDate(value)} ${format.time(value)}` : format.time(value);

  return html`
    <a
      class=${entry.state === 'active' ? 'passage-card passage-active' : 'passage-card'}
      href=${`#/passages/${entry.id}`}
    >
      <div class="passage-times">
        ${`${at(entry.startTime, continuesFromPreviousDay)} – ${
          entry.endTime ? at(entry.endTime, continuesNextDay) : t('log.inProgress')
        }`}
      </div>
      <div class="passage-places">
        <${PlaceName} name=${entry.startPlaceName} pending=${entry.startPlacePending} />
        <span aria-hidden="true"> → </span>
        ${
          entry.endTime
            ? html`<${PlaceName} name=${entry.endPlaceName} pending=${entry.endPlacePending} />`
            : html`<span class="place">…</span>`
        }
      </div>
      <div class="passage-facts">
        <span>${format.distance(entry.distance)}</span>
        <span>${format.duration(elapsedSeconds(entry))}</span>
      </div>
      <${EngineSailBar} engine=${entry.engineDuration} sail=${entry.sailDuration} />
      ${
        continuesFromPreviousDay &&
        html`<div class="passage-continues">${t('log.fromPreviousDay')}</div>`
      }
      ${continuesNextDay && html`<div class="passage-continues">${t('log.toNextDay')}</div>`}
    </a>
  `;
}

export function LogView() {
  const { t, format } = useLocale();
  // Coming back from a passage, the logbook is rendered straight from what it
  // was left showing -- the older pages included -- rather than from an empty
  // page while it reloads. It is then its old height, so the reader lands
  // exactly where they were instead of watching the page jump once the
  // passages arrive. The poll below refreshes it right away.
  const recalled = useRef(viewMemory.recall(VIEW));
  const title = useRef(null);
  const [log, setLog] = useState(() => recalled.current?.log ?? null);
  const [error, setError] = useState(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const wanted = useRef(recalled.current?.wanted ?? PAGE_SIZE);

  useLayoutEffect(() => {
    if (recalled.current?.scrollY) {
      window.scrollTo(0, recalled.current.scrollY);
    }
  }, []);

  const reload = (isCurrent = () => true) =>
    Promise.all([loadEntries(wanted.current), get('/entries/stats')])
      .then(([page, stats]) => {
        if (isCurrent()) {
          const loaded = { ...page, stats };
          setLog(loaded);
          viewMemory.remember(VIEW, { log: loaded, wanted: wanted.current });
          setError(null);
        }
      })
      .catch((err) => isCurrent() && setError(err));

  usePolling(reload, REFRESH_MS);

  const loadOlder = () => {
    wanted.current += PAGE_SIZE;
    setLoadingOlder(true);
    reload().finally(() => setLoadingOlder(false));
  };

  if (!log) {
    return error
      ? html`<${ErrorNotice} error=${error} onRetry=${() => reload()} />`
      : html`<${Loading} />`;
  }
  if (log.items.length === 0) {
    return html`
      <h1 class="page-title">${t('log.title')}</h1>
      <p class="empty">${t('log.empty')}</p>
    `;
  }

  return html`
    <h1 class="page-title" tabindex="-1" ref=${title}>${t('log.title')}</h1>
    <${ErrorNotice} error=${error} />
    <${LogStats} stats=${log.stats} />
    ${groupByDay(log.items).map(
      (day) => html`
        <section class="day" key=${day.key}>
          <header class="day-header">
            <h2>${format.day(day.date)}</h2>
            ${
              day.distance > 0 &&
              html`<span class="day-distance">
                ${t('log.dayDistance', { distance: format.distance(day.distance) })}
              </span>`
            }
          </header>
          <ul class="passage-list">
            ${day.items.map(
              (item) => html`<li key=${item.entry.id}><${PassageCard} ...${item} /></li>`
            )}
          </ul>
        </section>
      `
    )}
    ${
      log.items.length < log.total &&
      html`<button type="button" class="load-older" disabled=${loadingOlder} onClick=${loadOlder}>
        ${t('log.loadOlder')}
      </button>`
    }
    <${BackToTop} title=${title} />
  `;
}

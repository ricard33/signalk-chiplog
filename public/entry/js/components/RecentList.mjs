import { html, useState } from '../../../vendor/preact-htm.mjs';
import { fetchAll } from '../../../js/api.mjs';
import { useLocale, usePolling } from '../../../js/context.mjs';
import { EventRemark } from '../../../js/components/Timeline.mjs';
import { EDITABLE_EVENT_TYPES } from '../../../js/log-lines.mjs';
import { PencilIcon, TrashIcon } from './Icons.mjs';

const REFRESH_MS = 30 * 1000;
const SHOWN = 15;

function queuedLabel(body, t, manoeuvreLabels) {
  if (body.type === 'manoeuvre') {
    const key = `manoeuvre.${body.subtype}`;
    return t.has(key) ? t(key) : (manoeuvreLabels[body.subtype] ?? body.subtype);
  }
  return body.type === 'handwritten_annotation' ? t('event.handwritten') : body.comment;
}

function failureReason(error, t) {
  return error.code === 'no_passage' ? t('entry.noPassageError') : error.message;
}

export function RecentList({
  entryId,
  version,
  queue,
  manoeuvreLabels,
  onDelete,
  onDiscard,
  onComment
}) {
  const { t, format } = useLocale();
  const [events, setEvents] = useState([]);

  usePolling(
    (isCurrent) => {
      if (entryId === null) {
        setEvents([]);
        return;
      }
      fetchAll(`/entries/${entryId}/events`)
        .then((items) => isCurrent() && setEvents(items.slice(-SHOWN).reverse()))
        .catch(() => {
          // Kept as last seen; the header already tells when the server is away.
        });
    },
    REFRESH_MS,
    [entryId, version]
  );

  const posts = (items) => items.filter((item) => item.method === 'POST');
  const failed = posts(queue.failed);
  const pending = posts(queue.pending).reverse();
  const nothing = failed.length + pending.length + events.length === 0;

  return html`
    <section class="panel recent" aria-labelledby="recent-title">
      <h2 id="recent-title" class="panel-title">${t('entry.recent')}</h2>
      ${nothing && html`<p class="hint">${t('entry.recentEmpty')}</p>`}
      <ul class="recent-list">
        ${failed.map(
          (item) => html`<li key=${item.ref} class="recent-item recent-failed">
            <span class="recent-time">${format.time(item.body.time)}</span>
            <span class="recent-what">
              <strong>${queuedLabel(item.body, t, manoeuvreLabels)}</strong>
              <br />${t('entry.failed', { reason: failureReason(item.error, t) })}
            </span>
            <span class="recent-actions">
              <button type="button" class="tool-button" onClick=${() => onDiscard(item.ref)}>
                ${t('entry.discard')}
              </button>
            </span>
          </li>`
        )}
        ${pending.map(
          (item) => html`<li key=${item.ref} class="recent-item recent-pending">
            <span class="recent-time">${format.time(item.body.time)}</span>
            <span class="recent-what">
              <strong>${queuedLabel(item.body, t, manoeuvreLabels)}</strong>
              ${item.body.comment && item.body.type !== 'text_annotation' ? ` — ${item.body.comment}` : ''}
              <br /><span class="muted">${t('entry.pending')}</span>
            </span>
            <span class="recent-actions">
              <button type="button" class="tool-button" onClick=${() => onDiscard(item.ref)}>
                ${t('entry.discard')}
              </button>
            </span>
          </li>`
        )}
        ${events.map(
          (event) => html`<li key=${event.id} class=${`recent-item event-${event.type}`}>
            <span class="recent-time">${format.time(event.time)}</span>
            <span class="recent-what">
              <${EventRemark} event=${event} manoeuvreLabels=${manoeuvreLabels} />
            </span>
            <span class="recent-actions">
              <button
                type="button"
                class="tool-button icon-button"
                aria-label=${event.type === 'text_annotation' ? t('common.edit') : t('entry.comment')}
                title=${event.type === 'text_annotation' ? t('common.edit') : t('entry.comment')}
                onClick=${() => onComment(event)}
              >
                <${PencilIcon} />
              </button>
              ${
                event.source === 'manual' &&
                EDITABLE_EVENT_TYPES.includes(event.type) &&
                html`<button
                  type="button"
                  class="tool-button icon-button danger"
                  aria-label=${t('entry.delete')}
                  title=${t('entry.delete')}
                  onClick=${() => onDelete(event)}
                >
                  <${TrashIcon} />
                </button>`
              }
            </span>
          </li>`
        )}
      </ul>
    </section>
  `;
}

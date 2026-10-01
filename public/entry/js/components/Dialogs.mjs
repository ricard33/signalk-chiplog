import { html, useEffect, useRef, useState } from '../../../vendor/preact-htm.mjs';
import { useLocale } from '../../../js/context.mjs';
import { EDITABLE_EVENT_TYPES } from '../../../js/log-lines.mjs';
import { CheckIcon, ClockIcon, CloseIcon, UndoIcon } from './Icons.mjs';

// Correcting an entry just made, or one picked out of the recent list: its
// comment, and — for what the crew logged themselves — its time. Redating it
// makes the server read its position back from the track, so an entry written up
// after the fact still sits in the right place. `event` is the logged event, or
// the body of one still waiting in the outbox.
export function EventDialog({ title, event, bounds, onSave, onCancel }) {
  const { t, format } = useLocale();
  const [text, setText] = useState(event?.comment ?? '');
  const [when, setWhen] = useState(() => (event?.time ? format.dateTimeInput(event.time) : ''));
  const field = useRef(null);
  useEffect(() => field.current?.focus(), []);
  const retimeable = EDITABLE_EVENT_TYPES.includes(event?.type);

  const submit = (submitEvent) => {
    submitEvent.preventDefault();
    const comment = text.trim() === '' ? null : text.trim();
    const patch = comment === (event?.comment ?? null) ? {} : { comment };
    const time = retimeable && when !== '' ? format.fromDateTimeInput(when) : null;
    if (time !== null && time !== event?.time) {
      patch.time = time;
    }
    onSave(patch);
  };

  return html`
    <div class="sheet-backdrop" onClick=${(clickEvent) => clickEvent.target === clickEvent.currentTarget && onCancel()}>
      <form class="sheet" role="dialog" aria-modal="true" aria-labelledby="comment-title" onSubmit=${submit}>
        <h2 id="comment-title">${title}</h2>
        ${
          retimeable &&
          html`<label class="sheet-field">
            <span>${t('entry.eventTime')}</span>
            <input
              type="datetime-local"
              step="60"
              value=${when}
              min=${bounds?.start ? format.dateTimeInput(bounds.start) : undefined}
              max=${format.dateTimeInput(bounds?.end ?? Date.now())}
              onInput=${(inputEvent) => setWhen(inputEvent.currentTarget.value)}
            />
            <small class="muted">${t('entry.timeFromTrack')}</small>
          </label>`
        }
        <textarea
          ref=${field}
          rows="4"
          maxlength="10000"
          value=${text}
          aria-label=${t('entry.comment')}
          onInput=${(inputEvent) => setText(inputEvent.currentTarget.value)}
        ></textarea>
        <div class="sheet-row">
          <button type="button" class="big-button" onClick=${onCancel}>${t('common.cancel')}</button>
          <button type="submit" class="big-button primary">${t('common.save')}</button>
        </div>
      </form>
    </div>
  `;
}

// What was just logged. It confirms rather than asks: the mark and the wording
// say the entry is in, a countdown shows the banner will go on its own, and the
// two follow-ups are secondary next to it — undoing is the destructive one, and
// says what it undoes, since on its own "undo" reads as dismissing the banner.
export function Toast({ toast, timeoutMs, onUndo, onComment, onClose }) {
  const { t, format } = useLocale();
  if (!toast) {
    return null;
  }
  const close = html`<button
    type="button"
    class="tool-button icon-button toast-close"
    aria-label=${t('common.close')}
    onClick=${onClose}
  >
    <${CloseIcon} />
  </button>`;

  if (toast.kind === 'error') {
    return html`
      <div class="toast toast-error" role="alert">
        <span class="toast-text">${toast.message}</span>
        ${close}
      </div>
    `;
  }
  if (toast.kind === 'undone') {
    return html`
      <div
        key=${toast}
        class="toast"
        role="status"
        style=${`--toast-ms: ${timeoutMs}ms`}
      >
        <span class="toast-text">${t('entry.undone')}</span>
        ${close}
        <span class="toast-countdown" aria-hidden="true"></span>
      </div>
    `;
  }
  const detail = toast.queued
    ? t('entry.loggedQueued')
    : `${t('entry.logged', { time: format.time(toast.time) })}${toast.openedEntry ? ` · ${t('entry.openedPassage')}` : ''}`;
  return html`
    <div
      key=${toast}
      class=${toast.queued ? 'toast toast-queued' : 'toast toast-logged'}
      role="status"
      style=${`--toast-ms: ${timeoutMs}ms`}
    >
      <span class="toast-mark">${toast.queued ? html`<${ClockIcon} />` : html`<${CheckIcon} />`}</span>
      <span class="toast-text"><strong>${toast.what}</strong><br />${detail}</span>
      <span class="toast-actions">
        <button type="button" class="tool-button" onClick=${onComment}>
          ${t('entry.addComment')}
        </button>
        <button type="button" class="tool-button danger" onClick=${onUndo}>
          <${UndoIcon} />${t('entry.undo')}
        </button>
      </span>
      ${close}
      <span class="toast-countdown" aria-hidden="true"></span>
    </div>
  `;
}

import { html, useEffect, useRef, useState } from '../../../vendor/preact-htm.mjs';
import { useLocale } from '../../../js/context.mjs';
import { EDITABLE_EVENT_TYPES } from '../../../js/log-lines.mjs';

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

// What was just logged, with the two things one wants right after: undo a
// mistaken tap, or add a word about it.
export function Toast({ toast, onUndo, onComment, onClose }) {
  const { t, format } = useLocale();
  if (!toast) {
    return null;
  }
  if (toast.kind === 'error') {
    return html`
      <div class="toast toast-error" role="alert">
        <span class="toast-text">${toast.message}</span>
        <button type="button" class="tool-button" onClick=${onClose}>×</button>
      </div>
    `;
  }
  if (toast.kind === 'undone') {
    return html`<div class="toast" role="status"><span class="toast-text">${t('entry.undone')}</span></div>`;
  }
  const detail = toast.queued
    ? t('entry.loggedQueued')
    : `${t('entry.logged', { time: format.time(toast.time) })}${toast.openedEntry ? ` · ${t('entry.openedPassage')}` : ''}`;
  return html`
    <div class=${toast.queued ? 'toast toast-queued' : 'toast'} role="status">
      <span class="toast-text"><strong>${toast.what}</strong><br />${detail}</span>
      <button type="button" class="big-button" onClick=${onComment}>${t('entry.addComment')}</button>
      <button type="button" class="big-button" onClick=${onUndo}>${t('entry.undo')}</button>
    </div>
  `;
}

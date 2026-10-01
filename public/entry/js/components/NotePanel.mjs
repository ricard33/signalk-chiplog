import { html, useState } from '../../../vendor/preact-htm.mjs';
import { useLocale } from '../../../js/context.mjs';

// A free-text note. Its time is left empty for the usual case — the server dates
// it, and takes an instrument snapshot with it — and filled in when the note is
// being written up after the fact, where the position comes from the track.
export function NotePanel({ busy, bounds, onLog }) {
  const { t, format } = useLocale();
  const [text, setText] = useState('');
  const [when, setWhen] = useState('');

  const submit = async (event) => {
    event.preventDefault();
    const comment = text.trim();
    if (!comment) {
      return;
    }
    const time = when === '' ? null : format.fromDateTimeInput(when);
    const body = time === null ? { comment } : { comment, time };
    if (await onLog({ type: 'text_annotation', ...body }, t('entry.note'))) {
      setText('');
      setWhen('');
    }
  };

  return html`
    <form class="note-form" onSubmit=${submit}>
      <textarea
        value=${text}
        rows="5"
        maxlength="10000"
        placeholder=${t('entry.notePlaceholder')}
        aria-label=${t('entry.note')}
        onInput=${(event) => setText(event.currentTarget.value)}
      ></textarea>
      <label class="note-time">
        <span>${t('entry.noteTime')}</span>
        <input
          type="datetime-local"
          step="60"
          value=${when}
          min=${bounds?.start ? format.dateTimeInput(bounds.start) : undefined}
          max=${format.dateTimeInput(bounds?.end ?? Date.now())}
          onInput=${(event) => setWhen(event.currentTarget.value)}
        />
      </label>
      <button type="submit" class="big-button primary" disabled=${busy || !text.trim()}>
        ${t('entry.send')}
      </button>
    </form>
  `;
}

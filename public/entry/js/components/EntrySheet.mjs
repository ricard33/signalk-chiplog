import { html, useState } from '../../../vendor/preact-htm.mjs';
import { useLocale } from '../../../js/context.mjs';
import { CloseIcon } from './Icons.mjs';
import { NotePanel } from './NotePanel.mjs';
import { SketchPanel } from './SketchPanel.mjs';

// The form to add an entry by hand, over the whole screen: a note typed, or the page to write
// on with the stylus. It closes once the entry is logged.
export function EntrySheet({ busy, bounds, night, onLog, onClose }) {
  const { t } = useLocale();
  const [tab, setTab] = useState('note');
  const log = async (body, what) => {
    const logged = await onLog(body, what);
    if (logged) {
      onClose();
    }
    return logged;
  };
  return html`
    <section class="panel writer fullscreen" role="dialog" aria-modal="true" aria-labelledby="writer-title">
      <div class="writer-header">
        <button
          type="button"
          class="tool-button icon-button"
          aria-label=${t('common.cancel')}
          title=${t('common.cancel')}
          onClick=${onClose}
        >
          <${CloseIcon} />
        </button>
        <h2 id="writer-title">${t('entry.newEntry')}</h2>
      </div>
      <div class="tabs" role="tablist">
        ${['note', 'sketch'].map(
          (name) => html`<button
            type="button"
            role="tab"
            key=${name}
            class="tab"
            aria-selected=${tab === name ? 'true' : 'false'}
            onClick=${() => setTab(name)}
          >
            ${t(`entry.${name}`)}
          </button>`
        )}
      </div>
      <div class="tab-panel" hidden=${tab !== 'note'}>
        <${NotePanel} busy=${busy} bounds=${bounds} onLog=${log} />
      </div>
      <div class="tab-panel" hidden=${tab !== 'sketch'}>
        <${SketchPanel} busy=${busy} onLog=${log} night=${night} />
      </div>
    </section>
  `;
}

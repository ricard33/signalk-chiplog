import { html, useState } from '../../../vendor/preact-htm.mjs';
import { request } from '../../../js/api.mjs';
import { useLocale } from '../../../js/context.mjs';
import { randomId } from '../../../js/ids.mjs';
import { confirmAction } from '../confirm.mjs';
import { manoeuvreLabel } from './ManoeuvrePad.mjs';
import { manoeuvreIcon, PencilIcon, TrashIcon } from './Icons.mjs';

const STEP = 10;

// The list of shortcuts, to reorder, turn on or off, and, for those the crew added, rename or
// delete. Sails have their own button, so the sail change is not listed. `onEdit` runs a change
// on the server, then reads the list again.
export function ShortcutsSheet({ types, onEdit, onClose }) {
  const { t } = useLocale();
  const [name, setName] = useState('');
  const shown = types.filter((type) => type.key !== 'sail_change');
  const label = (type) => manoeuvreLabel(type, t);
  const patch = (type, body) =>
    onEdit(() => request('PATCH', `/manoeuvre-types/${type.key}`, body));

  const move = (type, by) =>
    onEdit(async () => {
      const keys = shown.map((item) => item.key);
      const from = keys.indexOf(type.key);
      const to = from + by;
      if (to < 0 || to >= keys.length) {
        return;
      }
      keys.splice(to, 0, keys.splice(from, 1)[0]);
      // Renumbered whole: two shortcuts may share an order.
      for (const [index, key] of keys.entries()) {
        const order = (index + 1) * STEP;
        if (types.find((item) => item.key === key).sortOrder !== order) {
          await request('PATCH', `/manoeuvre-types/${key}`, { sortOrder: order });
        }
      }
    });

  const rename = (type) => {
    const next = window.prompt(t('entry.shortcutRename', { name: label(type) }), type.label);
    if (next && next.trim() && next.trim() !== type.label) {
      patch(type, { label: next.trim().slice(0, 100) });
    }
  };

  const remove = async (type) => {
    if (await confirmAction(t('entry.shortcutDeleteConfirm', { name: label(type) }), t)) {
      onEdit(() => request('DELETE', `/manoeuvre-types/${type.key}`));
    }
  };

  const add = (event) => {
    event.preventDefault();
    const text = name.trim();
    if (!text) {
      return;
    }
    setName('');
    onEdit(() =>
      request('POST', '/manoeuvre-types', {
        key: `custom_${randomId().replaceAll('-', '').slice(0, 8)}`,
        label: text.slice(0, 100)
      })
    );
  };

  return html`
    <div class="sheet-backdrop" onClick=${(event) => event.target === event.currentTarget && onClose()}>
      <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="shortcuts-title">
        <h2 id="shortcuts-title">${t('entry.shortcutsTitle')}</h2>
        <p class="hint">${t('entry.shortcutsHint')}</p>
        <ul class="shortcut-list">
          ${shown.map((type, index) => {
            const Icon = manoeuvreIcon(type.key);
            const text = label(type);
            return html`<li key=${type.key} class="shortcut-item">
              <span class="shortcut-name">
                <${Icon} />
                <span>${text}${type.builtin ? '' : html` <span class="muted">· ${t('entry.shortcutCustom')}</span>`}</span>
              </span>
              <span class="shortcut-actions">
                <button
                  type="button"
                  class="tool-button icon-button"
                  disabled=${index === 0}
                  aria-label=${t('entry.shortcutMoveUp', { name: text })}
                  onClick=${() => move(type, -1)}
                >
                  ↑
                </button>
                <button
                  type="button"
                  class="tool-button icon-button"
                  disabled=${index === shown.length - 1}
                  aria-label=${t('entry.shortcutMoveDown', { name: text })}
                  onClick=${() => move(type, 1)}
                >
                  ↓
                </button>
                ${
                  !type.builtin &&
                  html`<button
                      type="button"
                      class="tool-button icon-button"
                      aria-label=${t('entry.shortcutRename', { name: text })}
                      onClick=${() => rename(type)}
                    >
                      <${PencilIcon} />
                    </button>
                    <button
                      type="button"
                      class="tool-button icon-button danger"
                      aria-label=${t('entry.shortcutDelete', { name: text })}
                      onClick=${() => remove(type)}
                    >
                      <${TrashIcon} />
                    </button>`
                }
                <button
                  type="button"
                  class="tool-button"
                  aria-pressed=${type.enabled ? 'true' : 'false'}
                  aria-label=${t(type.enabled ? 'entry.shortcutShown' : 'entry.shortcutHidden', { name: text })}
                  onClick=${() => patch(type, { enabled: !type.enabled })}
                >
                  ${type.enabled ? '✓' : '–'}
                </button>
              </span>
            </li>`;
          })}
        </ul>
        <form class="sheet-row" onSubmit=${add}>
          <input
            value=${name}
            maxlength="100"
            placeholder=${t('entry.shortcutName')}
            aria-label=${t('entry.shortcutName')}
            onInput=${(event) => setName(event.currentTarget.value)}
          />
          <button type="submit" class="big-button" disabled=${!name.trim()}>${t('entry.shortcutAdd')}</button>
        </form>
        <button type="button" class="big-button primary" onClick=${onClose}>${t('common.close')}</button>
      </div>
    </div>
  `;
}

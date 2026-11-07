import { html, useState } from '../../../vendor/preact-htm.mjs';
import { useLocale } from '../../../js/context.mjs';
import { sailName, sailsText } from '../../../js/log-lines.mjs';

const DEPARTURES = new Set(['cast_off', 'anchor_up']);
export const SAILS = [
  'main',
  'genoa',
  'jib',
  'staysail',
  'spinnaker',
  'gennaker',
  'code0',
  'storm_jib'
];

export function manoeuvreLabel(type, t) {
  const key = `manoeuvre.${type.key}`;
  return t.has(key) ? t(key) : type.label;
}

// The sails to tick: those up now start ticked, so a sail comes down by
// unticking it. One entry logs the whole set.
function SailSheet({ initial, onDone, onClose }) {
  const { t } = useLocale();
  const [other, setOther] = useState('');
  const [offered, setOffered] = useState(() => [
    ...SAILS,
    ...initial.filter((sail) => !SAILS.includes(sail))
  ]);
  const [chosen, setChosen] = useState(initial);
  const toggle = (sail) =>
    setChosen((current) =>
      current.includes(sail) ? current.filter((s) => s !== sail) : [...current, sail]
    );
  const addOther = (event) => {
    event.preventDefault();
    const name = other.trim();
    if (name) {
      if (!offered.includes(name)) {
        setOffered([...offered, name]);
      }
      setChosen((current) => (current.includes(name) ? current : [...current, name]));
      setOther('');
    }
  };
  const changed =
    chosen.length !== initial.length || chosen.some((sail) => !initial.includes(sail));
  return html`
    <div class="sheet-backdrop" onClick=${(event) => event.target === event.currentTarget && onClose()}>
      <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sail-title">
        <h2 id="sail-title">${t('entry.chooseSail')}</h2>
        <p class="hint">${t('entry.sailsHint')}</p>
        <div class="sail-grid">
          ${offered.map(
            (sail) =>
              html`<button
                type="button"
                class=${chosen.includes(sail) ? 'big-button primary' : 'big-button'}
                key=${sail}
                aria-pressed=${chosen.includes(sail) ? 'true' : 'false'}
                onClick=${() => toggle(sail)}
              >
                ${sailName(sail, t)}
              </button>`
          )}
        </div>
        <form class="sheet-row" onSubmit=${addOther}>
          <input
            value=${other}
            maxlength="60"
            placeholder=${t('entry.otherSail')}
            aria-label=${t('entry.otherSail')}
            onInput=${(event) => setOther(event.currentTarget.value)}
          />
          <button type="submit" class="big-button" disabled=${!other.trim()}>${t('entry.addSail')}</button>
        </form>
        <div class="sheet-row">
          <button
            type="button"
            class="big-button primary"
            disabled=${!changed}
            onClick=${() => onDone(chosen)}
          >
            ${t('entry.send')}
          </button>
        </div>
        <button type="button" class="link-button" onClick=${onClose}>${t('common.cancel')}</button>
      </div>
    </div>
  `;
}

export function ManoeuvrePad({ types, noPassage, busy, onLog, loadSails }) {
  const { t } = useLocale();
  const [choosingSail, setChoosingSail] = useState(null);
  const [sailsUp, setSailsUp] = useState([]);
  const enabled = types.filter((type) => type.enabled);

  const press = (type) => {
    if (type.key === 'sail_change') {
      // What is up now, from the log; the sheet opens on the last known set
      // if the server cannot say.
      Promise.resolve(loadSails?.())
        .then(
          (sails) => setSailsUp(sails ?? sailsUp),
          () => {}
        )
        .finally(() => setChoosingSail(type));
      return;
    }
    onLog({ type: 'manoeuvre', subtype: type.key }, manoeuvreLabel(type, t));
  };

  return html`
    <section class="panel pad" aria-labelledby="pad-title">
      <h2 id="pad-title" class="panel-title">${t('entry.manoeuvres')}</h2>
      ${noPassage && html`<p class="hint">${t('entry.departHint')}</p>`}
      <div class="pad-grid">
        ${enabled.map((type) => {
          const highlighted = noPassage && DEPARTURES.has(type.key);
          return html`<button
            type="button"
            key=${type.key}
            class=${highlighted ? 'big-button primary' : 'big-button'}
            disabled=${busy}
            onClick=${() => press(type)}
          >
            ${manoeuvreLabel(type, t)}
          </button>`;
        })}
      </div>
      ${
        choosingSail &&
        html`<${SailSheet}
          initial=${sailsUp}
          onClose=${() => setChoosingSail(null)}
          onDone=${(sails) => {
            const type = choosingSail;
            setChoosingSail(null);
            setSailsUp(sails);
            // `sail` is the set in words, for readers that know one sail only.
            onLog(
              {
                type: 'manoeuvre',
                subtype: type.key,
                payload: { sail: sails.join(' + '), sails }
              },
              sails.length === 0
                ? `${manoeuvreLabel(type, t)} (${t('event.sailsDown')})`
                : `${manoeuvreLabel(type, t)} (${sailsText(sails, t)})`
            );
          }}
        />`
      }
    </section>
  `;
}

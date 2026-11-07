import { html, useState } from '../../../vendor/preact-htm.mjs';
import { useLocale } from '../../../js/context.mjs';
import { CloseIcon } from './Icons.mjs';
import {
  isEmptyObservation,
  observationPayload,
  observationText,
  parsePressure,
  SUBTYPE
} from '../observation.mjs';

const range = (count) => Array.from({ length: count }, (_, index) => index);

// One tap picks a value, a second tap leaves it out.
function Choices({ title, labels, value, onChange }) {
  return html`
    <fieldset class="choices">
      <legend>${title}</legend>
      <div class="choice-grid">
        ${labels.map(
          (label, index) =>
            html`<button
              type="button"
              key=${index}
              class=${value === index ? 'tool-button choice primary' : 'tool-button choice'}
              aria-pressed=${value === index ? 'true' : 'false'}
              onClick=${() => onChange(value === index ? null : index)}
            >
              ${label}
            </button>`
        )}
      </div>
    </fieldset>
  `;
}

// The weather observation form, over the whole screen: wind, sea, visibility, pressure and
// cloud cover, each optional. It closes once the reading is logged.
export function ObservationSheet({ busy, onLog, onClose }) {
  const { t } = useLocale();
  const [values, setValues] = useState({
    force: null,
    from: null,
    sea: null,
    visibility: null,
    pressure: '',
    cloud: null
  });
  const set = (name) => (value) => setValues((current) => ({ ...current, [name]: value }));
  const payload = observationPayload(values);
  const badPressure = values.pressure.trim() !== '' && parsePressure(values.pressure) === null;
  const seas = t('observation.seaStates').split(',');

  const submit = async (event) => {
    event.preventDefault();
    if (isEmptyObservation(payload)) {
      return;
    }
    const comment = `${t('observation.title')} · ${observationText(payload, t)}`;
    const logged = await onLog(
      { type: 'text_annotation', subtype: SUBTYPE, comment, payload },
      t('observation.form')
    );
    if (logged) {
      onClose();
    }
  };

  return html`
    <form class="panel writer fullscreen observation" role="dialog" aria-modal="true" aria-labelledby="observation-title" onSubmit=${submit}>
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
        <h2 id="observation-title">${t('observation.form')}</h2>
        <button
          type="submit"
          class="big-button primary observation-submit"
          disabled=${busy || isEmptyObservation(payload)}
        >
          ${t('entry.send')}
        </button>
      </div>
      <div class="observation-body">
        <${Choices}
          title=${t('observation.wind')}
          labels=${range(13).map(String)}
          value=${values.force}
          onChange=${set('force')}
        />
        <${Choices}
          title=${t('observation.windFrom')}
          labels=${t('observation.compassPoints').split(',')}
          value=${values.from}
          onChange=${set('from')}
        />
        <${Choices}
          title=${t('observation.sea')}
          labels=${seas.map((name, index) => `${index} · ${name}`)}
          value=${values.sea}
          onChange=${set('sea')}
        />
        <${Choices}
          title=${t('observation.visibility')}
          labels=${t('observation.visibilities').split(',')}
          value=${values.visibility}
          onChange=${set('visibility')}
        />
        <label class="sheet-field">
          <span>${t('observation.pressure')}</span>
          <input
            inputmode="decimal"
            value=${values.pressure}
            aria-invalid=${badPressure ? 'true' : 'false'}
            onInput=${(event) => set('pressure')(event.currentTarget.value)}
          />
          ${badPressure && html`<small class="danger">${t('observation.pressureRange')}</small>`}
        </label>
        <${Choices}
          title=${t('observation.cloud')}
          labels=${range(9).map(String)}
          value=${values.cloud}
          onChange=${set('cloud')}
        />
      </div>
    </form>
  `;
}

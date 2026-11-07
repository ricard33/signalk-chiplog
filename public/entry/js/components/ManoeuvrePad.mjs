import { html, useEffect, useState } from '../../../vendor/preact-htm.mjs';
import { useLocale } from '../../../js/context.mjs';
import { sailName, sailsText } from '../../../js/log-lines.mjs';
import { EngineIcon, manoeuvreIcon, SailIcon } from './Icons.mjs';

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

// One switch per engine, validated together: a single entry in the log, and the passage
// is under engine or under sail from then on.
function EngineSheet({ engines, onDone, onClose }) {
  const { t } = useLocale();
  const [running, setRunning] = useState(
    Object.fromEntries(engines.map(({ name, running: on }) => [name, on === true]))
  );
  const changed = engines.some(({ name, running: on }) => running[name] !== (on === true));
  return html`
    <div class="sheet-backdrop" onClick=${(event) => event.target === event.currentTarget && onClose()}>
      <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="engine-title">
        <h2 id="engine-title">${t('entry.engines')}</h2>
        <p class="hint">${t('entry.enginesHint')}</p>
        <div class="sail-grid">
          ${engines.map(
            ({ name }) =>
              html`<button
                type="button"
                class=${running[name] ? 'big-button primary' : 'big-button'}
                key=${name}
                aria-pressed=${running[name] ? 'true' : 'false'}
                onClick=${() => setRunning({ ...running, [name]: !running[name] })}
              >
                ${`${name} · ${t(running[name] ? 'entry.engineRunning' : 'entry.engineStopped')}`}
              </button>`
          )}
        </div>
        <div class="sheet-row">
          <button
            type="button"
            class="big-button primary"
            disabled=${!changed}
            onClick=${() => onDone(running)}
          >
            ${t('entry.send')}
          </button>
        </div>
        <button type="button" class="link-button" onClick=${onClose}>${t('common.cancel')}</button>
      </div>
    </div>
  `;
}

// The sail and engine buttons, on top of the entry screen: what is up and what runs, and a
// tap opens the list to change it, in one entry.
export function PropulsionBar({ busy, version, onLog, loadSails, engines, onSwitchEngines }) {
  const { t } = useLocale();
  const [choosingSail, setChoosingSail] = useState(false);
  const [sailsUp, setSailsUp] = useState([]);
  const [choosingEngines, setChoosingEngines] = useState(false);
  const sailChange = { key: 'sail_change', label: 'sail_change' };

  // What is up now, from the log of the passage: read again after every entry.
  useEffect(() => {
    let current = true;
    Promise.resolve(loadSails?.()).then(
      (sails) => current && sails && setSailsUp(sails),
      () => {}
    );
    return () => {
      current = false;
    };
  }, [version]);

  const running = (engines ?? []).filter((engine) => engine.running).map((engine) => engine.name);
  const buttons = [
    {
      key: 'sails',
      icon: SailIcon,
      title: t('entry.sails'),
      state: sailsUp.length > 0 ? sailsText(sailsUp, t) : t('event.sailsDown'),
      on: sailsUp.length > 0,
      press: () => setChoosingSail(true)
    },
    engines && {
      key: 'engines',
      icon: EngineIcon,
      title: t('entry.engines'),
      state: running.length > 0 ? running.join(' + ') : t('entry.engineStopped'),
      on: running.length > 0,
      press: () => setChoosingEngines(true)
    }
  ].filter(Boolean);

  return html`
    <div class="propulsion-bar">
      ${buttons.map(
        ({ key, icon: Icon, title, state, on, press }) =>
          html`<button
            type="button"
            key=${key}
            class=${on ? 'propulsion-button on' : 'propulsion-button'}
            disabled=${busy}
            onClick=${press}
          >
            <${Icon} />
            <span class="propulsion-text">
              <strong>${title}</strong>
              <span>${state}</span>
            </span>
          </button>`
      )}
      ${
        choosingEngines &&
        html`<${EngineSheet}
          engines=${engines}
          onClose=${() => setChoosingEngines(false)}
          onDone=${(chosen) => {
            setChoosingEngines(false);
            onSwitchEngines(chosen);
          }}
        />`
      }
      ${
        choosingSail &&
        html`<${SailSheet}
          initial=${sailsUp}
          onClose=${() => setChoosingSail(false)}
          onDone=${(sails) => {
            setChoosingSail(false);
            setSailsUp(sails);
            // `sail` is the set in words, for readers that know one sail only.
            onLog(
              {
                type: 'manoeuvre',
                subtype: sailChange.key,
                payload: { sail: sails.join(' + '), sails }
              },
              sails.length === 0
                ? `${manoeuvreLabel(sailChange, t)} (${t('event.sailsDown')})`
                : `${manoeuvreLabel(sailChange, t)} (${sailsText(sails, t)})`
            );
          }}
        />`
      }
    </div>
  `;
}

// The shortcuts: one tap logs the manoeuvre. Sails have their own button above, and before
// the departure only what starts the passage is offered.
export function ManoeuvrePad({ types, noPassage, busy, onLog }) {
  const { t } = useLocale();
  const enabled = types.filter(
    (type) => type.enabled && type.key !== 'sail_change' && (!noPassage || DEPARTURES.has(type.key))
  );
  return html`
    <section class="pad" aria-labelledby="pad-title">
      <h2 id="pad-title" class="panel-title">${t('entry.manoeuvres')}</h2>
      ${noPassage && html`<p class="hint">${t('entry.departHint')}</p>`}
      <div class="pad-grid">
        ${enabled.map((type) => {
          const Icon = manoeuvreIcon(type.key);
          return html`<button
            type="button"
            key=${type.key}
            class=${noPassage ? 'big-button primary pad-button' : 'big-button pad-button'}
            disabled=${busy}
            onClick=${() =>
              onLog({ type: 'manoeuvre', subtype: type.key }, manoeuvreLabel(type, t))}
          >
            <${Icon} />
            <span>${manoeuvreLabel(type, t)}</span>
          </button>`;
        })}
      </div>
    </section>
  `;
}

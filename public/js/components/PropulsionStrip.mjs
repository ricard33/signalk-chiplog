import { html, useState } from '../../vendor/preact-htm.mjs';
import { useLocale } from '../context.mjs';
import { IconButton } from './common.mjs';

export function PropulsionStrip({ segments, entry, busy, onSwitch, onDelete }) {
  const { t, format } = useLocale();
  const [open, setOpen] = useState(false);
  if (segments.length === 0) {
    return html`<p class="muted">${t('passage.noPropulsion')}</p>`;
  }

  const start = Date.parse(entry.startTime);
  const end = entry.endTime ? Date.parse(entry.endTime) : Date.now();
  const span = Math.max(end - start, 1);
  const percent = (time) => ((Math.min(Math.max(time, start), end) - start) / span) * 100;
  const segmentEnd = (segment) => (segment.endTime ? Date.parse(segment.endTime) : Date.now());

  const seconds = (type) =>
    segments
      .filter((segment) => segment.type === type)
      .reduce(
        (sum, segment) => sum + (segmentEnd(segment) - Date.parse(segment.startTime)) / 1000,
        0
      );
  const totals = { engine: seconds('engine'), sail: seconds('sail') };
  const total = Math.max(totals.engine + totals.sail, 1);
  const share = (type) =>
    t('passage.propulsionShare', {
      type: t(type === 'engine' ? 'passage.engine' : 'passage.sail'),
      duration: format.duration(totals[type]),
      percent: Math.round((totals[type] / total) * 100)
    });

  return html`
    <div class="strip" aria-hidden="true">
      ${segments.map((segment) => {
        const from = percent(Date.parse(segment.startTime));
        const width = Math.max(percent(segmentEnd(segment)) - from, 0.4);
        return html`<span
          key=${segment.id}
          class=${`strip-segment strip-${segment.type}`}
          style=${`left:${from}%;width:${width}%`}
        ></span>`;
      })}
    </div>
    <p class="strip-summary">
      <span class="segment-engine">${share('engine')}</span>
      <span class="segment-sail">${share('sail')}</span>
      <button type="button" class="link-button" onClick=${() => setOpen(!open)} aria-expanded=${open}>
        ${t(open ? 'passage.propulsionHide' : 'passage.propulsionShow')}
      </button>
    </p>
    ${
      open &&
      html`<ul class="segment-list">
      ${segments.map(
        (segment, index) => html`
          <li key=${segment.id}>
            <span class=${`segment-type segment-${segment.type}`}>
              ${t(segment.type === 'engine' ? 'passage.engine' : 'passage.sail')}
            </span>
            <span>
              ${`${format.time(segment.startTime)} – ${
                segment.endTime ? format.time(segment.endTime) : '…'
              }`}
            </span>
            <span>${format.duration((segmentEnd(segment) - Date.parse(segment.startTime)) / 1000)}</span>
            ${
              segment.averageRpm !== null &&
              html`<span>${t('passage.rpm', { rpm: Math.round(segment.averageRpm) })}</span>`
            }
            <button
              type="button"
              class="link-button"
              disabled=${busy}
              onClick=${() => onSwitch(segment)}
            >
              ${t('corrections.switchTo', {
                type: t(segment.type === 'engine' ? 'type.sail' : 'type.engine')
              })}
            </button>
            ${
              index > 0 &&
              html`<${IconButton}
                icon="delete"
                label=${t('common.delete')}
                danger
                disabled=${busy}
                onClick=${() => onDelete(segment)}
              />`
            }
          </li>
        `
      )}
    </ul>`
    }
  `;
}

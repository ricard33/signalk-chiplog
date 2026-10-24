import { html } from '../../../vendor/preact-htm.mjs';
import { useLocale } from '../../../js/context.mjs';
import { elapsedSeconds } from '../../../js/components/common.mjs';
import { fallbackMessage } from '../../../js/status.mjs';

function motionLabel(state, t) {
  if (!state) {
    return t('common.loading');
  }
  if (state.motion === 'underway') {
    if (state.propulsion === 'engine') {
      return t('status.underwayEngine');
    }
    return state.propulsion === 'sail' ? t('status.underwaySail') : t('status.underway');
  }
  return state.motion === 'stopped' ? t('status.stopped') : t('status.unknown');
}

// A passage opened by casting off stays stopped from its start until the
// vessel moves.
function passageLine(entry, t, format) {
  if (!entry) {
    return t('entry.noPassage');
  }
  if (entry.stoppedSince) {
    const waiting = entry.openedByEventId !== null && entry.stoppedSince === entry.startTime;
    return waiting
      ? t('entry.waitingToLeave', { time: format.time(entry.stoppedSince) })
      : t('passage.stoppedSince', { time: format.time(entry.stoppedSince) });
  }
  return t('entry.passageFrom', {
    place: entry.startPlaceName ?? t('place.unknown'),
    duration: format.duration(elapsedSeconds(entry))
  });
}

// While the server does not answer, the connection mark is a button that
// tries again at once, rather than at the next poll.
function ConnectionMark({ online, connecting, queued, onReconnect }) {
  const { t } = useLocale();
  const connection = online ? t('entry.online') : t('entry.offline');
  const label = queued > 0 ? `${connection} · ${t('entry.queued', { count: queued })}` : connection;
  if (online) {
    return html`<span class="connection connection-online">
      <span class="connection-dot" aria-hidden="true"></span>
      ${label}
    </span>`;
  }
  return html`
    <span class="connection connection-offline">
      <span class="connection-dot" aria-hidden="true"></span>
      ${label}
      <button type="button" class="tool-button" disabled=${connecting} onClick=${onReconnect}>
        ${connecting ? t('entry.reconnecting') : t('connection.reconnect')}
      </button>
    </span>
  `;
}

export function StatusHeader({
  state,
  entry,
  online,
  connecting,
  queued,
  night,
  onToggleNight,
  onReconnect
}) {
  const { t, format } = useLocale();
  return html`
    <header class="entry-header">
      <div class="entry-status">
        <strong class=${`entry-motion motion-${state?.motion ?? 'unknown'}`}>
          ${motionLabel(state, t)}
        </strong>
        <span class="entry-passage">${state ? passageLine(entry, t, format) : ''}</span>
        ${
          state?.detection === 'fallback' &&
          html`<span class="entry-fallback" title=${fallbackMessage(state.stateIssue, t, format)}>⚠</span>`
        }
      </div>
      <div class="entry-tools">
        <${ConnectionMark}
          online=${online}
          connecting=${connecting}
          queued=${queued}
          onReconnect=${onReconnect}
        />
        <button
          type="button"
          class="tool-button"
          aria-pressed=${night ? 'true' : 'false'}
          onClick=${onToggleNight}
        >
          ${t('entry.night')}
        </button>
        <a class="tool-button" data-standalone-link href="../">${t('entry.logbook')}</a>
      </div>
    </header>
  `;
}

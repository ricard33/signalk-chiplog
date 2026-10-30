import { html, useEffect, useMemo, useState } from '../../vendor/preact-htm.mjs';
import { connection } from '../api.mjs';
import { connectionProblem } from '../connection.mjs';
import { useConnection, useLocale } from '../context.mjs';

// Signing in happens in the Signal K admin, on a tab of its own so that this
// page keeps what it showed; coming back to it checks the link again.
export function SignInLink({ label }) {
  return html`<a href="/admin/#/login" target="_blank" rel="noopener">${label}</a>`;
}

const ICON_PATHS = {
  edit: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z',
  delete: 'M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 10v6M14 10v6'
};

// A button drawn as an icon, named for screen readers and as a tooltip.
export function IconButton({ icon, label, danger, disabled, onClick }) {
  return html`<button
    type="button"
    class=${`link-button icon-button${danger ? ' danger' : ''}`}
    disabled=${disabled}
    title=${label}
    aria-label=${label}
    onClick=${onClick}
  >
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d=${ICON_PATHS[icon]} />
    </svg>
  </button>`;
}

// Failed actions waiting for the link to come back, so the toast can say, once
// it does, that there is something to do again.
const unfinished = new Set();

const RESTORED_TOAST_MS = 6000;

// One toast for the whole page while the server is out of reach, fixed to the
// bottom of the screen so it is seen wherever the reader is, however many
// requests failed: why, and a way to get the link back.
export function ConnectionToast() {
  const { t } = useLocale();
  const link = useConnection();
  // A server that is down refuses at once: without a word, a reconnect that
  // failed would look like a button that does nothing.
  const [failed, setFailed] = useState(false);
  const [restored, setRestored] = useState(null);

  useEffect(() => {
    if (link.restored === 0) {
      return undefined;
    }
    setFailed(false);
    setRestored({ again: unfinished.size > 0 });
    const timer = setTimeout(() => setRestored(null), RESTORED_TOAST_MS);
    return () => clearTimeout(timer);
  }, [link.restored]);

  if (link.state === 'connected') {
    if (!restored) {
      return null;
    }
    const message = restored.again
      ? `${t('connection.restored')} ${t('connection.tryAgain')}`
      : t('connection.restored');
    return html`
      <div class="connection-toast connection-toast-ok" role="status">
        <p>${message}</p>
        <button type="button" class="toast-close" aria-label=${t('common.close')} onClick=${() => setRestored(null)}>×</button>
      </div>
    `;
  }
  const signedOut = link.state === 'signedOut';
  let message = t(signedOut ? 'connection.signedOut' : 'connection.offline');
  if (link.checking) {
    message = t('connection.checking');
  } else if (failed) {
    message = `${t('connection.stillDown')} ${message}`;
  }
  const reconnect = async () => setFailed((await connection.check()) !== 'connected');
  return html`
    <div class="connection-toast" role="alert">
      <p>${message}</p>
      <p class="notice-actions">
        ${signedOut && html`<${SignInLink} label=${t('connection.signIn')} />`}
        <button type="button" disabled=${link.checking} onClick=${reconnect}>
          ${t('connection.reconnect')}
        </button>
      </p>
    </div>
  `;
}

// Where a request failed for want of the link, the toast speaks; here only
// what the place itself needs. A notice that can redo its request does so once
// the link is back, whoever brought it back; one that cannot is counted for the
// toast to say so.
function ConnectionNotice({ error, problem, link, since, onRetry }) {
  const { t } = useLocale();
  const back = link.state === 'connected' && !link.checking;
  // Back, after a 401 that the probe got past: the account lacks the rights.
  const refused = back && problem === 'signedOut' && link.restored === since;

  useEffect(() => {
    if (onRetry) {
      return undefined;
    }
    unfinished.add(error);
    return () => unfinished.delete(error);
  }, [error]);

  useEffect(() => {
    if (back && !refused && onRetry) {
      onRetry();
    }
  }, [back, refused]);

  if (!refused) {
    return null;
  }
  return html`
    <div class="notice notice-error" role="alert">
      <p>${t('error.forbidden')} <${SignInLink} label=${t('error.signIn')} /></p>
    </div>
  `;
}

export function ErrorNotice({ error, onRetry }) {
  const { t } = useLocale();
  const link = useConnection();
  const problem = connectionProblem(error);
  // How many times the link had come back when this error arrived.
  const since = useMemo(() => link.restored, [error]);
  if (!error) {
    return null;
  }
  if (problem) {
    return html`<${ConnectionNotice} error=${error} problem=${problem} link=${link} since=${since} onRetry=${onRetry} />`;
  }
  let message;
  if (error.code === 'forbidden') {
    message = html`${t('error.forbidden')} <${SignInLink} label=${t('error.signIn')} />`;
  } else if (error.code === 'plugin_not_started') {
    message = t('error.notRunning');
  } else {
    message = t('error.generic', { message: error.message });
  }
  return html`
    <div class="notice notice-error" role="alert">
      <p>${message}</p>
      ${onRetry && html`<button type="button" onClick=${onRetry}>${t('common.retry')}</button>`}
    </div>
  `;
}

export function Loading() {
  const { t } = useLocale();
  return html`<p class="loading">${t('common.loading')}</p>`;
}

export function PlaceName({ name, pending }) {
  const { t } = useLocale();
  return html`
    <span
      class=${pending ? 'place place-pending' : 'place'}
      title=${pending ? t('place.pending') : undefined}
    >
      ${name ?? t('place.unknown')}
    </span>
  `;
}

export function passageTitle(entry, t) {
  const from = entry.startPlaceName ?? t('place.unknown');
  return entry.endTime ? `${from} → ${entry.endPlaceName ?? t('place.unknown')}` : `${from} → …`;
}

export function EngineSailBar({ engine, sail }) {
  const { t, format } = useLocale();
  const total = engine + sail;
  if (total <= 0) {
    return null;
  }
  const enginePercent = (engine / total) * 100;
  return html`
    <div
      class="engine-sail"
      title=${`${t('passage.engine')} ${format.duration(engine)} · ${t('passage.sail')} ${format.duration(sail)}`}
    >
      <span class="engine-sail-engine" style=${`width:${enginePercent}%`}></span>
      <span class="engine-sail-sail" style=${`width:${100 - enginePercent}%`}></span>
    </div>
  `;
}

export function elapsedSeconds(entry, now = Date.now()) {
  const end = entry.endTime ? Date.parse(entry.endTime) : now;
  return Math.max(0, (end - Date.parse(entry.startTime)) / 1000);
}

import { html, useEffect, useState } from '../../vendor/preact-htm.mjs';
import { get, request } from '../api.mjs';
import { useLocale, usePolling } from '../context.mjs';
import { ErrorNotice } from './common.mjs';

const STATUS_REFRESH_MS = 30 * 1000;
// While a code waits to be claimed, so the page says "paired" soon after it is.
const PAIRING_REFRESH_MS = 3 * 1000;

function BackupStatus({ status }) {
  const { t, format } = useLocale();
  const when = (value) => `${format.shortDate(value)} ${format.time(value)}`;
  const { lastSuccess, lastError, inProgress } = status;
  return html`
    <ul class="usb-status">
      <li>${t('cloud.backingUpTo', { url: status.url })}</li>
      ${
        inProgress &&
        html`<li>${t('cloud.inProgress', { done: inProgress.done, total: inProgress.total })}</li>`
      }
      ${
        lastError &&
        html`<li class="notice notice-error">
          ${t('cloud.lastError', { time: when(lastError.at), message: lastError.message })}
        </li>`
      }
      <li>
        ${
          lastSuccess
            ? t('cloud.lastSuccess', {
                time: when(lastSuccess.at),
                sent: lastSuccess.sent,
                held: lastSuccess.held
              })
            : t('cloud.notYet')
        }
      </li>
    </ul>
  `;
}

// A QR code from its rows of '1' and '0', with the light margin a reader needs around it.
// Always dark on white, whatever the theme: a phone reads contrast, not style.
const QR_MARGIN = 4;
function QrCode({ rows, label }) {
  const size = rows.length + 2 * QR_MARGIN;
  const path = rows
    .flatMap((row, y) =>
      [...row].map((module, x) =>
        module === '1' ? `M${x + QR_MARGIN} ${y + QR_MARGIN}h1v1h-1z` : ''
      )
    )
    .join('');
  return html`
    <svg class="qr-code" viewBox=${`0 0 ${size} ${size}`} role="img" aria-label=${label}>
      <rect width=${size} height=${size} fill="#fff" />
      <path d=${path} fill="#000" />
    </svg>
  `;
}

function PairingState({ pairing, onCancel }) {
  const { t, format } = useLocale();
  if (pairing.state === 'waiting') {
    return html`
      <div class="pairing-code" role="status">
        <p>${t('cloud.enterCode')}</p>
        <p class="code">${pairing.code}</p>
        ${
          pairing.claimUrl &&
          html`<p><a href=${pairing.claimUrl} target="_blank" rel="noopener">${t('cloud.openClaim')}</a></p>`
        }
        ${
          pairing.claimQr &&
          html`<${QrCode} rows=${pairing.claimQr} label=${t('cloud.scanClaim')} />
            <p class="muted">${t('cloud.scanClaim')}</p>`
        }
        <p class="muted">${t('cloud.codeExpires', { time: format.time(pairing.expiresAt) })}</p>
        <button type="button" onClick=${onCancel}>${t('common.cancel')}</button>
      </div>
    `;
  }
  if (pairing.state === 'paired') {
    return html`<p class="notice notice-ok">
      ${t('cloud.paired', { vessel: pairing.vesselName || '—' })}
    </p>`;
  }
  if (pairing.state === 'expired') {
    return html`<p class="notice notice-error">${t('cloud.expired')}</p>`;
  }
  if (pairing.state === 'failed') {
    return html`<p class="notice notice-error">
      ${t('cloud.pairingFailed', { message: pairing.error.message })}
    </p>`;
  }
  return null;
}

function PairingForm({ initialUrl, onStart, busy }) {
  const { t } = useLocale();
  const [url, setUrl] = useState(initialUrl ?? '');
  return html`
    <form
      class="pairing-form"
      onSubmit=${(event) => {
        event.preventDefault();
        onStart(url);
      }}
    >
      <label>
        ${t('cloud.serviceUrl')}
        <input
          type="url"
          required
          placeholder="https://"
          value=${url}
          onInput=${(event) => setUrl(event.currentTarget.value)}
        />
      </label>
      <button type="submit" disabled=${busy}>${t('cloud.pair')}</button>
    </form>
  `;
}

// Getting an earlier logbook of this boat back from the service, into a logbook still empty
// (SPEC §4.17): offered then, followed while it runs, and to carry on with if it was cut short.
function Restore({ restore, busy, onStart }) {
  const { t, format } = useLocale();
  const [logbooks, setLogbooks] = useState(null);
  const offered = restore.possible || (restore.restoring && !restore.running);

  useEffect(() => {
    if (!offered) {
      setLogbooks(null);
      return undefined;
    }
    let current = true;
    get('/cloud-sync/restore')
      .then((answer) => current && setLogbooks(answer.logbooks))
      // Nothing to offer when the service cannot be asked: the backup's own status says why.
      .catch(() => current && setLogbooks([]));
    return () => {
      current = false;
    };
  }, [offered]);

  if (restore.running) {
    const { done, total } = restore.inProgress ?? { done: 0, total: 0 };
    return html`<p class="notice" role="status">${t('cloud.restoring', { done, total })}</p>`;
  }
  return html`
    ${
      restore.lastError &&
      html`<p class="notice notice-error">
        ${t('cloud.restoreFailed', { message: restore.lastError.message })}
      </p>`
    }
    ${
      restore.lastResult &&
      html`<p class="notice notice-ok">
        ${t('cloud.restored', { count: restore.lastResult.passages })}
        ${restore.lastResult.failed > 0 && t('cloud.restoreRefused', { count: restore.lastResult.failed })}
      </p>`
    }
    ${
      offered &&
      logbooks?.length > 0 &&
      html`
        <div class="restore-offer">
          <p>${restore.restoring ? t('cloud.restoreUnfinished') : t('cloud.restoreIntro')}</p>
          <ul>
            ${logbooks.map(
              (logbook) => html`
                <li>
                  ${t('cloud.restoreLogbook', {
                    count: logbook.passages,
                    first: format.shortDate(logbook.firstStart),
                    last: format.shortDate(logbook.lastStart)
                  })}
                  <button
                    type="button"
                    disabled=${busy}
                    onClick=${() => onStart(logbook.logbookId)}
                  >
                    ${restore.restoring ? t('cloud.restoreResume') : t('cloud.restore')}
                  </button>
                </li>
              `
            )}
          </ul>
        </div>
      `
    }
  `;
}

// The online backup (SPEC §4.17): what it last did, sending now, and pairing the boat with the
// service by a short code.
export function CloudBackup() {
  const { t } = useLocale();
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);
  const waiting = status?.pairing?.state === 'waiting';
  // Followed closely, so the page shows passages coming back.
  const restoring = status?.restore?.running === true;

  usePolling(
    (isCurrent) => {
      get('/cloud-sync')
        .then((next) => isCurrent() && setStatus(next))
        .catch((err) => isCurrent() && setError(err));
    },
    waiting || restoring ? PAIRING_REFRESH_MS : STATUS_REFRESH_MS,
    [version, waiting, restoring]
  );

  const act = async (method, path, body) => {
    setBusy(true);
    setError(null);
    try {
      await request(method, path, body);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
      setVersion((v) => v + 1);
    }
  };

  const ready = status?.enabled && status?.configured;
  return html`
    <section class="card">
      <h2>${t('cloud.title')}</h2>
      <p>${t('cloud.intro')}</p>
      ${ready && html`<${BackupStatus} status=${status} />`}
      ${
        ready &&
        html`<button type="button" disabled=${busy} onClick=${() => act('POST', '/cloud-sync')}>
          ${t('cloud.backUpNow')}
        </button>`
      }
      ${
        ready &&
        status.restore &&
        html`<${Restore}
          restore=${status.restore}
          busy=${busy}
          onStart=${(logbookId) => act('POST', '/cloud-sync/restore', { logbookId })}
        />`
      }
      ${
        status?.pairing &&
        html`<${PairingState}
          pairing=${status.pairing}
          onCancel=${() => act('DELETE', '/cloud-sync/pairing')}
        />`
      }
      ${
        status &&
        !waiting &&
        html`
          <details open=${!ready}>
            <summary>${ready ? t('cloud.pairAgain') : t('cloud.pairTitle')}</summary>
            <p>${t('cloud.pairIntro')}</p>
            <${PairingForm}
              initialUrl=${status.url}
              busy=${busy}
              onStart=${(url) => act('POST', '/cloud-sync/pairing', { url })}
            />
          </details>
        `
      }
      <${ErrorNotice} error=${error} />
    </section>
  `;
}

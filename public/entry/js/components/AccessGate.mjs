import { html, useEffect, useMemo, useState } from '../../../vendor/preact-htm.mjs';
import { deviceToken } from '../../../js/auth.mjs';
import { useLocale } from '../../../js/context.mjs';
import { createAccessRequester } from '../access.mjs';

const POLL_MS = 5000;

function storage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function AccessGate({ onGranted }) {
  const { t } = useLocale();
  const access = useMemo(
    () =>
      createAccessRequester({
        fetch: (...args) => window.fetch(...args),
        storage: storage(),
        tokenStore: deviceToken,
        description: t('access.deviceName')
      }),
    []
  );
  const [status, setStatus] = useState(access.hasPendingRequest() ? 'pending' : 'idle');

  useEffect(() => {
    if (status !== 'pending') {
      return undefined;
    }
    const timer = setInterval(async () => {
      const { state } = await access.poll();
      setStatus(state);
      if (state === 'approved') {
        onGranted();
      }
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [status]);

  const ask = async () => {
    setStatus('sending');
    const { state } = await access.request();
    setStatus(state);
  };

  const message = ['idle', 'sending'].includes(status) ? t('access.intro') : t(`access.${status}`);
  return html`
    <section class="panel access" role="alert" aria-labelledby="access-title">
      <h2 id="access-title" class="panel-title">${t('access.title')}</h2>
      <p>${message}</p>
      <div class="sheet-row">
        ${
          status === 'pending'
            ? html`<button type="button" class="big-button" onClick=${() => {
                access.cancel();
                setStatus('idle');
              }}>${t('access.cancel')}</button>`
            : html`<button type="button" class="big-button primary" disabled=${status === 'sending'} onClick=${ask}>
                ${t('access.request')}
              </button>`
        }
        <a class="big-button" data-standalone-link href="/admin/#/login">${t('access.signIn')}</a>
      </div>
    </section>
  `;
}

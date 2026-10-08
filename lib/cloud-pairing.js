const { getLogbookId } = require('./cloud-sync');
const { qrCode } = require('./qr');

const REQUEST_TIMEOUT_MS = 30 * 1000;
// When the service is out of reach mid-pairing: keep asking, as long as the code lives.
const RETRY_MS = 10 * 1000;

class PairingError extends Error {
  constructor(message, { status = null, code = null } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function serviceUrl(text) {
  let url;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return null;
  }
  return url.toString().replace(/\/+$/, '');
}

// Pairs the plugin with the online service by a short code instead of a pasted token
// (SPEC §4.17): the service hands out a code, someone claims it for their boat, and the plugin,
// polling meanwhile with a secret only it holds, collects its device token. `onPaired` is
// given the service address and the token, to save them in the plugin configuration.
function createCloudPairing({
  db,
  userAgent,
  onPaired,
  log,
  fetch = globalThis.fetch,
  clock = Date.now
}) {
  let state = { state: 'idle' };
  // The current attempt's secret and address, never reported.
  let attempt = null;
  let timer = null;

  async function call(url, path, body) {
    const response = await fetch(`${url}/v1${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': userAgent,
        'x-chiplog-version': userAgent.split('/')[1] ?? ''
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new PairingError(data.message ?? `The service answered ${response.status}`, {
        status: response.status,
        code: data.error ?? null
      });
    }
    return data;
  }

  function schedule(current, delayMs) {
    clearTimeout(timer);
    timer = setTimeout(() => poll(current), delayMs);
  }

  async function poll(current) {
    if (attempt !== current) {
      return;
    }
    let result;
    try {
      result = await call(current.url, `/pairings/${current.pairingId}/poll`, {
        pollSecret: current.pollSecret
      });
    } catch (error) {
      if (attempt !== current) {
        return;
      }
      if (error.status === 410 || Date.parse(state.expiresAt) <= clock()) {
        attempt = null;
        state = { state: 'expired', at: new Date(clock()).toISOString() };
      } else if (!(error instanceof PairingError)) {
        // Out of reach for a moment: the code is still good.
        schedule(current, RETRY_MS);
      } else {
        attempt = null;
        state = { state: 'failed', error: { message: error.message, code: error.code } };
      }
      return;
    }
    if (attempt !== current) {
      return;
    }
    if (result.status !== 'paired') {
      schedule(current, current.pollIntervalMs);
      return;
    }
    attempt = null;
    try {
      await onPaired({ url: current.url, token: result.token });
    } catch (error) {
      log('error', `Online backup paired, but its settings could not be saved: ${error.message}`);
      state = { state: 'failed', error: { message: error.message, code: 'save_failed' } };
      return;
    }
    state = {
      state: 'paired',
      vesselName: result.vesselName,
      at: new Date(clock()).toISOString()
    };
    log('info', `Online backup paired with ${result.vesselName || 'a vessel'} at ${current.url}`);
  }

  return {
    // Asks the service for a code and starts waiting for it to be claimed. A pairing already
    // under way is dropped: its code was not used.
    async start(text) {
      const url = serviceUrl(text);
      if (!url) {
        throw new PairingError('The service address must be an http or https URL', {
          code: 'invalid_url'
        });
      }
      this.cancel();
      const pairing = await call(url, '/pairings', { logbookId: getLogbookId(db) });
      const current = {
        url,
        pairingId: pairing.pairingId,
        pollSecret: pairing.pollSecret,
        pollIntervalMs: Math.max(1, pairing.pollIntervalSeconds) * 1000
      };
      attempt = current;
      state = {
        state: 'waiting',
        url,
        code: pairing.code,
        claimUrl: pairing.claimUrl ?? null,
        // The same address as a QR code, for a phone to open: the plugin's page is often on
        // the chart table, the account on the phone in someone's hand.
        claimQr: pairing.claimUrl ? qrCode(pairing.claimUrl) : null,
        expiresAt: pairing.expiresAt
      };
      schedule(current, current.pollIntervalMs);
      return this.status();
    },

    cancel() {
      clearTimeout(timer);
      attempt = null;
      if (state.state === 'waiting') {
        state = { state: 'idle' };
      }
    },

    status() {
      return { ...state };
    },

    stop() {
      clearTimeout(timer);
      attempt = null;
    }
  };
}

module.exports = { createCloudPairing, PairingError };

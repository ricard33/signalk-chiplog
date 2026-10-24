// Node's fetch says only "fetch failed" when no answer came back; the reason — a name that does
// not resolve, a refused connection, a certificate refused — is in `cause`, which the plugin
// would otherwise lose. These turn such a failure into one sentence for the log and the page.

// A hint for the causes a boat meets most, where the fix is not obvious from the code alone.
const HINTS = [
  [/^(ENOTFOUND|EAI_AGAIN)$/, 'check the address and that this server can resolve names (DNS)'],
  [
    /^(CERT_|UNABLE_TO_VERIFY|SELF_SIGNED|DEPTH_ZERO|ERR_TLS_CERT)/,
    "check this server's clock: a wrong date makes valid certificates look invalid"
  ],
  [/^(ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH)$/, 'check the address and the network']
];

function describeCause(cause) {
  if (!cause) {
    return null;
  }
  // Several addresses tried (IPv4 and IPv6): each has its own reason.
  if (Array.isArray(cause.errors) && cause.errors.length > 0) {
    const parts = [
      ...new Set(cause.errors.map((each) => describeCause(each)?.text).filter(Boolean))
    ];
    return { code: cause.code ?? cause.errors[0].code ?? null, text: parts.join('; ') };
  }
  const message = cause.message || String(cause);
  const code = cause.code ?? null;
  const text = code && !message.includes(code) ? `${code}: ${message}` : message;
  return { code, text };
}

// The error a failed `fetch(url)` threw, explained. An answer the service gave is not this
// function's: only failures where no answer came back are rewritten; anything else is returned
// as it was.
function networkError(error, url, timeoutMs) {
  let host;
  try {
    host = new URL(url).host;
  } catch {
    host = url;
  }
  if (error?.name === 'TimeoutError') {
    const result = new Error(
      `No answer from ${host} within ${Math.round(timeoutMs / 1000)} s: check the network`
    );
    result.code = 'timeout';
    result.cause = error;
    return result;
  }
  if (!(error instanceof TypeError) || error.message !== 'fetch failed') {
    return error;
  }
  const cause = describeCause(error.cause);
  const hint = cause?.code && HINTS.find(([pattern]) => pattern.test(cause.code))?.[1];
  const result = new Error(
    `Cannot reach ${host}${cause ? ` (${cause.text})` : ''}${hint ? `: ${hint}` : ''}`
  );
  result.code = cause?.code ?? 'fetch_failed';
  result.cause = error;
  return result;
}

// `fetch`, with what went wrong said when no answer came back.
async function fetchExplained(fetch, url, options, timeoutMs) {
  try {
    return await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw networkError(error, url, timeoutMs);
  }
}

module.exports = { networkError, fetchExplained };

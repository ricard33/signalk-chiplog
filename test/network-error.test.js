const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { networkError, fetchExplained } = require('../lib/network-error');

const URL = 'https://app.example.org/v1/pairings';

function failed(cause) {
  return new TypeError('fetch failed', { cause });
}

function coded(code, message) {
  return Object.assign(new Error(message), { code });
}

describe('network errors', () => {
  it('names the host and the cause when no answer came back', () => {
    const error = networkError(
      failed(coded('ECONNREFUSED', 'connect ECONNREFUSED 1.2.3.4:443')),
      URL
    );

    assert.equal(
      error.message,
      'Cannot reach app.example.org (connect ECONNREFUSED 1.2.3.4:443): check the address and the network'
    );
    assert.equal(error.code, 'ECONNREFUSED');
    assert.equal(error.cause.message, 'fetch failed');
  });

  it('points at the clock for a refused certificate', () => {
    const error = networkError(
      failed(coded('CERT_NOT_YET_VALID', 'certificate is not yet valid')),
      URL
    );

    assert.match(error.message, /\(CERT_NOT_YET_VALID: certificate is not yet valid\): .*clock/);
  });

  it('gives every address tried', () => {
    const cause = Object.assign(
      new AggregateError([
        coded('ENETUNREACH', 'connect ENETUNREACH 2001:db8::1:443'),
        coded('ETIMEDOUT', 'connect ETIMEDOUT 1.2.3.4:443')
      ]),
      { code: 'ETIMEDOUT' }
    );

    const error = networkError(failed(cause), URL);

    assert.equal(
      error.message,
      'Cannot reach app.example.org (connect ENETUNREACH 2001:db8::1:443; connect ETIMEDOUT 1.2.3.4:443)'
    );
    assert.equal(error.code, 'ETIMEDOUT');
  });

  it('still says something without a cause', () => {
    const error = networkError(failed(undefined), URL);

    assert.equal(error.message, 'Cannot reach app.example.org');
    assert.equal(error.code, 'fetch_failed');
  });

  it('says how long it waited for an answer', () => {
    const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError');

    const error = networkError(timeout, URL, 30000);

    assert.equal(error.message, 'No answer from app.example.org within 30 s: check the network');
    assert.equal(error.code, 'timeout');
  });

  it('leaves any other error as it was', () => {
    const other = new Error('something else');
    assert.equal(networkError(other, URL), other);
  });

  it('explains what fetch throws, and passes a timeout signal', async () => {
    let seen;
    const fetch = async (url, options) => {
      seen = options;
      throw failed(coded('ENOTFOUND', 'getaddrinfo ENOTFOUND app.example.org'));
    };

    await assert.rejects(fetchExplained(fetch, URL, { method: 'POST' }, 1000), /DNS/);
    assert.equal(seen.method, 'POST');
    assert.ok(seen.signal instanceof AbortSignal);
  });
});

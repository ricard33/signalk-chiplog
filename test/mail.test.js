const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { buildMessage, parseAddress, parseAddressList, encodeHeaderText } = require('../lib/mail');

const header = (message, name) =>
  message
    .split('\r\n\r\n')[0]
    .split('\r\n')
    .find((line) => line.startsWith(`${name}: `))
    ?.slice(name.length + 2);

// The parts of a multipart body, split on its own boundary.
function parts(message) {
  const boundary = /boundary="([^"]+)"/.exec(message)[1];
  return message
    .split(`--${boundary}`)
    .slice(1, -1)
    .map((part) => part.replace(/^\r\n/, ''));
}

const body = (part) => part.split('\r\n\r\n').slice(1).join('\r\n\r\n').trim();
const decode = (part) => Buffer.from(body(part), 'base64').toString('utf8');

const message = (overrides = {}) =>
  buildMessage({
    from: { name: null, address: 'log@boat.test' },
    to: [{ name: null, address: 'skipper@shore.test' }],
    subject: 'A passage',
    text: 'plain',
    html: '<p>rich</p>',
    ...overrides
  });

describe('mail addresses', () => {
  it('reads a bare address and a named one', () => {
    assert.deepEqual(parseAddress('log@boat.test'), { name: null, address: 'log@boat.test' });
    assert.deepEqual(parseAddress('  Zéphyr <log@boat.test> '), {
      name: 'Zéphyr',
      address: 'log@boat.test'
    });
    assert.deepEqual(parseAddress('"Le bord" <log@boat.test>'), {
      name: 'Le bord',
      address: 'log@boat.test'
    });
  });

  it('splits a configured list and drops what is not an address', () => {
    assert.deepEqual(parseAddressList('a@b.test, Skipper <c@d.test> ; nonsense ,, e@f.test'), [
      { name: null, address: 'a@b.test' },
      { name: 'Skipper', address: 'c@d.test' },
      { name: null, address: 'e@f.test' }
    ]);
  });

  it('is empty rather than wrong when nothing is configured', () => {
    assert.deepEqual(parseAddressList(null), []);
    assert.deepEqual(parseAddressList(''), []);
  });
});

describe('header encoding', () => {
  it('leaves plain ASCII alone', () => {
    assert.equal(
      encodeHeaderText('Passage La Rochelle - Ile dAix'),
      'Passage La Rochelle - Ile dAix'
    );
  });

  it('encodes anything else as one or more base64 words', () => {
    const encoded = encodeHeaderText('La Rochelle → Île d’Aix');
    assert.match(encoded, /^=\?UTF-8\?B\?/);
    assert.equal(
      encoded
        .split('\r\n ')
        .map((word) => Buffer.from(/\?B\?(.*)\?=$/.exec(word)[1], 'base64').toString('utf8'))
        .join(''),
      'La Rochelle → Île d’Aix'
    );
  });

  it('keeps every encoded word inside the 75 characters a header allows', () => {
    const long = 'Rade de l’Île d’Aix par le pertuis d’Antioche → Les Minimes, La Rochelle';
    for (const word of encodeHeaderText(long).split('\r\n ')) {
      assert.ok(word.length <= 75, `${word.length} characters: ${word}`);
    }
  });

  it('never cuts a character in two', () => {
    const encoded = encodeHeaderText('é'.repeat(60));
    const joined = encoded
      .split('\r\n ')
      .map((word) => Buffer.from(/\?B\?(.*)\?=$/.exec(word)[1], 'base64').toString('utf8'))
      .join('');
    assert.equal(joined, 'é'.repeat(60));
  });
});

describe('building the message', () => {
  it('writes the headers a relay and a reader need', () => {
    const built = message({
      from: { name: 'Zéphyr', address: 'log@boat.test' },
      to: [
        { name: null, address: 'skipper@shore.test' },
        { name: 'Second', address: 'crew@shore.test' }
      ]
    });

    assert.match(header(built, 'From'), /^=\?UTF-8\?B\?.*\?= <log@boat\.test>$/);
    assert.equal(header(built, 'To'), 'skipper@shore.test, Second <crew@shore.test>');
    assert.equal(header(built, 'MIME-Version'), '1.0');
    assert.match(header(built, 'Message-ID'), /^<.+@signalk-chiplog>$/);
    assert.match(header(built, 'Date'), /\+0000$/);
  });

  it('offers the plain text and the HTML as alternatives', () => {
    const built = message();

    assert.match(header(built, 'Content-Type'), /^multipart\/alternative;/);
    const [plain, rich] = parts(built);
    assert.match(plain, /Content-Type: text\/plain; charset=utf-8/);
    assert.equal(decode(plain), 'plain');
    assert.match(rich, /Content-Type: text\/html; charset=utf-8/);
    assert.equal(decode(rich), '<p>rich</p>');
  });

  it('carries an inline image the HTML points at, related to it', () => {
    const built = message({
      html: '<img src="cid:passage-map" />',
      inlineImages: [
        {
          cid: 'passage-map',
          filename: 'passage-7.png',
          contentType: 'image/png',
          content: Buffer.from([0x89, 0x50, 0x4e, 0x47])
        }
      ]
    });

    assert.match(
      header(built, 'Content-Type'),
      /^multipart\/related;.*type="multipart\/alternative"/
    );
    const [alternative, image] = parts(built);
    assert.match(alternative, /^Content-Type: multipart\/alternative;/);
    assert.match(image, /Content-ID: <passage-map>/);
    assert.match(image, /Content-Disposition: inline; filename="passage-7\.png"/);
    assert.deepEqual(Buffer.from(body(image), 'base64'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });

  it('survives SMTP: CRLF throughout, and no line too long', () => {
    const built = message({
      text: 'é'.repeat(4000),
      inlineImages: [
        {
          cid: 'passage-map',
          filename: 'map.png',
          contentType: 'image/png',
          content: Buffer.alloc(20000, 7)
        }
      ]
    });

    assert.equal(built.replace(/\r\n/g, '').includes('\n'), false);
    for (const line of built.split('\r\n')) {
      assert.ok(line.length <= 998, `${line.length} characters`);
    }
  });
});

const crypto = require('node:crypto');

// Building the message itself: addresses, headers, and the MIME tree a mail
// reader needs to show an HTML summary with the map inside it rather than as an
// attachment hanging off the bottom.

const LINE = 76;

// "Nom du bord <log@example.org>", or just the address.
function parseAddress(text) {
  const trimmed = String(text).trim();
  const angled = /^(.*)<([^<>]+)>$/s.exec(trimmed);
  if (!angled) {
    return trimmed === '' ? null : { name: null, address: trimmed };
  }
  const name = angled[1]
    .trim()
    .replace(/^"(.*)"$/s, '$1')
    .trim();
  return { name: name === '' ? null : name, address: angled[2].trim() };
}

// A comma-separated setting, as the plugin's configuration takes recipients.
// Commas inside a quoted display name are left to whoever needs them: the
// boat's logbook goes to a handful of plain addresses.
function parseAddressList(text) {
  return String(text ?? '')
    .split(/[,;]/)
    .map((part) => parseAddress(part))
    .filter((address) => address !== null && address.address.includes('@'));
}

function base64Lines(buffer) {
  const encoded = buffer.toString('base64');
  const lines = [];
  for (let at = 0; at < encoded.length; at += LINE) {
    lines.push(encoded.slice(at, at + LINE));
  }
  return lines.join('\r\n');
}

// RFC 2047: a header carrying anything but US-ASCII is encoded whole, in
// base64, which keeps an accented place name readable in the subject line.
function encodeHeaderText(text) {
  if (/^[\x20-\x7e]*$/.test(text)) {
    return text;
  }
  // Each encoded word must fit in 75 characters including the wrapper, so the
  // text is cut into pieces whose base64 stays under that -- on whole
  // characters, never mid-codepoint.
  const words = [];
  let piece = '';
  for (const character of text) {
    if (Buffer.byteLength(piece + character) > 36) {
      words.push(piece);
      piece = '';
    }
    piece += character;
  }
  words.push(piece);
  return words.map((word) => `=?UTF-8?B?${Buffer.from(word).toString('base64')}?=`).join('\r\n ');
}

function formatAddress({ name, address }) {
  return name ? `${encodeHeaderText(name)} <${address}>` : address;
}

function headerLines(headers) {
  return Object.entries(headers)
    .filter(([, value]) => value !== null && value !== undefined && value !== '')
    .map(([name, value]) => `${name}: ${value}`);
}

function part(headers, body) {
  return [...headerLines(headers), '', body].join('\r\n');
}

function textPart(contentType, body) {
  return part(
    {
      'Content-Type': `${contentType}; charset=utf-8`,
      'Content-Transfer-Encoding': 'base64'
    },
    base64Lines(Buffer.from(body, 'utf8'))
  );
}

function multipart(subtype, parts, extra = {}) {
  const boundary = `----=_chiplog_${crypto.randomUUID()}`;
  const body = [...parts.map((item) => `--${boundary}\r\n${item}`), `--${boundary}--`, ''].join(
    '\r\n'
  );
  return {
    contentType: Object.entries({ boundary: `"${boundary}"`, ...extra })
      .map(([key, value]) => `; ${key}=${value}`)
      .join(''),
    header: `multipart/${subtype}`,
    body
  };
}

// `inlineImages` are referenced from the HTML as `cid:<their id>`.
// Returns the message ready for SMTP DATA, CRLF throughout.
function buildMessage({
  from,
  to,
  subject,
  text,
  html,
  inlineImages = [],
  date = new Date(),
  messageId = `${crypto.randomUUID()}@signalk-chiplog`
}) {
  const alternative = multipart('alternative', [
    textPart('text/plain', text),
    textPart('text/html', html)
  ]);

  let body = alternative;
  if (inlineImages.length > 0) {
    body = multipart(
      'related',
      [
        `Content-Type: ${alternative.header}${alternative.contentType}\r\n\r\n${alternative.body}`,
        ...inlineImages.map((image) =>
          part(
            {
              'Content-Type': `${image.contentType}; name="${image.filename}"`,
              'Content-Transfer-Encoding': 'base64',
              'Content-ID': `<${image.cid}>`,
              'Content-Disposition': `inline; filename="${image.filename}"`
            },
            base64Lines(image.content)
          )
        )
      ],
      { type: '"multipart/alternative"' }
    );
  }

  const headers = headerLines({
    From: formatAddress(from),
    To: to.map(formatAddress).join(', '),
    Subject: encodeHeaderText(subject),
    Date: date.toUTCString().replace('GMT', '+0000'),
    'Message-ID': `<${messageId}>`,
    'MIME-Version': '1.0',
    'Content-Type': `${body.header}${body.contentType}`
  });

  return `${headers.join('\r\n')}\r\n\r\n${body.body}`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

module.exports = { buildMessage, parseAddress, parseAddressList, escapeHtml, encodeHeaderText };

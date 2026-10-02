const net = require('node:net');
const os = require('node:os');
const tls = require('node:tls');

// A small SMTP client: EHLO, optional STARTTLS, optional AUTH, one message.
// Enough to hand a passage summary to the boat's mail relay (SPEC §4.16), and
// no more -- the same reason the PDF writer and the PNG codec are hand-rolled
// rather than pulled in as dependencies (SPEC §2).

const CONNECT_TIMEOUT_MS = 20 * 1000;
const COMMAND_TIMEOUT_MS = 60 * 1000;
// RFC 5321 §4.5.3.1: no line of a command or of the data may exceed this.
const MAX_LINE = 998;

const SECURITIES = ['starttls', 'tls', 'none'];

class SmtpError extends Error {
  constructor(message, { code = null, permanent = false } = {}) {
    super(message);
    this.name = 'SmtpError';
    this.code = code;
    // 5xx is the server saying "not like this, ever": retrying the same
    // message would only repeat it.
    this.permanent = permanent;
  }
}

// Reads the CRLF-delimited replies of one connection. A reply is one or more
// lines sharing a code, all but the last written `250-like this`.
//
// The bytes are kept as a Buffer rather than read through `setEncoding`: after
// STARTTLS the same socket carries TLS records, which must reach the TLS layer
// untouched.
function createReader(socket) {
  let buffer = Buffer.alloc(0);
  let failure = null;
  let waiting = null;

  const settle = () => {
    if (!waiting) {
      return;
    }
    if (failure) {
      const { reject } = waiting;
      waiting = null;
      reject(failure);
      return;
    }
    const lines = [];
    for (;;) {
      const end = buffer.indexOf('\r\n');
      if (end === -1) {
        return;
      }
      const line = buffer.toString('utf8', 0, end);
      buffer = buffer.subarray(end + 2);
      lines.push(line);
      if (line.length < 4 || line[3] !== '-') {
        const { resolve } = waiting;
        waiting = null;
        resolve({
          code: Number.parseInt(lines[0].slice(0, 3), 10),
          text: lines.map((item) => item.slice(4)).join('\n'),
          lines
        });
        return;
      }
    }
  };

  const onData = (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    settle();
  };
  const onError = (err) => {
    failure ??= new SmtpError(`SMTP connection failed: ${err.message}`);
    settle();
  };
  const onClose = () => {
    failure ??= new SmtpError('The SMTP server closed the connection');
    settle();
  };

  socket.on('data', onData);
  socket.on('error', onError);
  socket.on('close', onClose);

  return {
    read() {
      return new Promise((resolve, reject) => {
        waiting = { resolve, reject };
        settle();
      });
    },
    // Lets go of the socket, so STARTTLS can hand it to the TLS layer with
    // nobody else reading it.
    detach() {
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
      socket.pause();
    }
  };
}

function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new SmtpError(`The SMTP server did not answer ${what}`)), ms);
    })
  ]);
}

// `secure` is implicit TLS, the submission-over-TLS port (465); STARTTLS
// starts in the clear and upgrades below.
function openSocket({ host, port, secure }) {
  return new Promise((resolve, reject) => {
    const socket = secure ? tls.connect({ host, port, servername: host }) : net.connect(port, host);
    const ready = secure ? 'secureConnect' : 'connect';
    socket.setTimeout(CONNECT_TIMEOUT_MS, () =>
      socket.destroy(new Error(`no answer from ${host}:${port}`))
    );
    socket.once(ready, () => {
      socket.setTimeout(0);
      resolve(socket);
    });
    socket.once('error', reject);
  });
}

function upgrade(socket, host) {
  return new Promise((resolve, reject) => {
    const secure = tls.connect({ socket, servername: host });
    secure.once('secureConnect', () => resolve(secure));
    secure.once('error', reject);
  });
}

// `connect(options)` returns a connected duplex stream; injected so a test can
// speak to a socket of its own.
function createSmtpClient({
  host,
  port,
  security = 'starttls',
  username = null,
  password = null,
  clientName = os.hostname(),
  connect = openSocket
} = {}) {
  if (!SECURITIES.includes(security)) {
    throw new Error(`Unknown SMTP security "${security}"`);
  }

  async function send({ from, to, message }) {
    const recipients = Array.isArray(to) ? to : [to];
    if (recipients.length === 0) {
      throw new SmtpError('No recipient for the message', { permanent: true });
    }
    for (const line of message.split('\r\n')) {
      if (line.length > MAX_LINE) {
        throw new SmtpError('A line of the message is too long for SMTP', { permanent: true });
      }
    }

    let socket = await connect({ host, port, secure: security === 'tls' });
    let reader = createReader(socket);
    let closed = false;

    const say = async (command, what, expected) => {
      socket.write(`${command}\r\n`);
      return expect(what, expected);
    };

    const expect = async (what, expected) => {
      const reply = await withTimeout(reader.read(), COMMAND_TIMEOUT_MS, what);
      if (!expected.includes(Math.floor(reply.code / 100))) {
        throw new SmtpError(`SMTP ${what} refused: ${reply.code} ${reply.text}`, {
          code: reply.code,
          permanent: reply.code >= 500
        });
      }
      return reply;
    };

    try {
      await expect('the greeting', [2]);
      let hello = await say(`EHLO ${clientName}`, 'EHLO', [2]);
      const supports = (keyword) =>
        hello.lines.some((line) => line.slice(4).toUpperCase().startsWith(keyword));

      if (security === 'starttls') {
        if (!supports('STARTTLS')) {
          throw new SmtpError(`${host} does not offer STARTTLS`, { permanent: true });
        }
        await say('STARTTLS', 'STARTTLS', [2]);
        reader.detach();
        socket = await upgrade(socket, host);
        reader = createReader(socket);
        hello = await say(`EHLO ${clientName}`, 'EHLO', [2]);
      }

      if (username) {
        if (supports('AUTH') && hello.lines.some((line) => /\bPLAIN\b/i.test(line))) {
          const credentials = Buffer.from(`\0${username}\0${password ?? ''}`).toString('base64');
          await say(`AUTH PLAIN ${credentials}`, 'authentication', [2]);
        } else {
          await say('AUTH LOGIN', 'authentication', [3]);
          await say(Buffer.from(username).toString('base64'), 'the user name', [3]);
          await say(Buffer.from(password ?? '').toString('base64'), 'the password', [2]);
        }
      }

      await say(`MAIL FROM:<${from}>`, 'the sender', [2]);
      for (const recipient of recipients) {
        await say(`RCPT TO:<${recipient}>`, `the recipient ${recipient}`, [2]);
      }
      await say('DATA', 'DATA', [3]);
      // Dot-stuffing: a line of the message that starts with one would
      // otherwise end it.
      socket.write(`${message.replace(/\r\n\./g, '\r\n..')}\r\n.\r\n`);
      await expect('the message', [2]);
      // The message is accepted; waiting for the goodbye only makes sure the
      // relay has it before the connection goes, and a server that hangs up on
      // QUIT instead of answering has done nothing wrong.
      socket.write('QUIT\r\n');
      await withTimeout(reader.read(), COMMAND_TIMEOUT_MS, 'QUIT').catch(() => {});
      closed = true;
      socket.end();
      return { recipients };
    } finally {
      if (!closed) {
        socket.destroy();
      }
    }
  }

  return { send };
}

module.exports = { createSmtpClient, SmtpError, SECURITIES, MAX_LINE };

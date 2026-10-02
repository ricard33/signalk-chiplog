const assert = require('node:assert/strict');
const net = require('node:net');
const { describe, it, beforeEach, afterEach } = require('node:test');
const { createSmtpClient, SmtpError } = require('../lib/smtp');

// A real SMTP server on a local port, so the client is tested over a socket
// rather than against a mock of itself. `refuse` lets a test answer one verb
// with a code of its own.
function startRelay({ refuse = {}, capabilities = ['STARTTLS', 'AUTH PLAIN LOGIN'] } = {}) {
  const sessions = [];
  const server = net.createServer((socket) => {
    const session = { commands: [], data: '', from: null, to: [] };
    sessions.push(session);
    let inData = false;
    let buffer = '';

    socket.write('220 relay.test ESMTP\r\n');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      for (;;) {
        const end = buffer.indexOf('\r\n');
        if (end === -1) {
          return;
        }
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);

        if (inData) {
          if (line === '.') {
            inData = false;
            socket.write('250 2.0.0 Queued\r\n');
          } else {
            // Undo the dot-stuffing, as a server does.
            session.data += `${line.startsWith('..') ? line.slice(1) : line}\r\n`;
          }
          continue;
        }

        session.commands.push(line);
        const verb = line.split(' ')[0].toUpperCase();
        if (refuse[verb]) {
          socket.write(`${refuse[verb]}\r\n`);
          continue;
        }
        switch (verb) {
          case 'EHLO':
            socket.write(
              [
                ...capabilities.map((capability, index) =>
                  index === capabilities.length - 1 ? `250 ${capability}` : `250-${capability}`
                )
              ].join('\r\n') || '250 relay.test'
            );
            socket.write('\r\n');
            break;
          case 'AUTH':
            socket.write(
              line.includes(' PLAIN ') ? '235 2.7.0 Accepted\r\n' : '334 VXNlcm5hbWU6\r\n'
            );
            break;
          case 'MAIL':
            session.from = line;
            socket.write('250 2.1.0 Ok\r\n');
            break;
          case 'RCPT':
            session.to.push(line);
            socket.write('250 2.1.5 Ok\r\n');
            break;
          case 'DATA':
            inData = true;
            socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
            break;
          case 'QUIT':
            socket.write('221 2.0.0 Bye\r\n');
            socket.end();
            break;
          default:
            // A base64 answer to AUTH LOGIN.
            socket.write(
              session.commands.filter((c) => c === line).length > 0
                ? '334 UGFzc3dvcmQ6\r\n'
                : '500 5.5.1 Unknown\r\n'
            );
        }
      }
    });
    socket.on('error', () => {});
  });
  return { server, sessions };
}

describe('the SMTP client', () => {
  let relay;
  let port;

  beforeEach(async () => {
    relay = startRelay();
    await new Promise((resolve) => relay.server.listen(0, '127.0.0.1', resolve));
    port = relay.server.address().port;
  });

  afterEach(async () => {
    await new Promise((resolve) => relay.server.close(resolve));
  });

  const client = (options = {}) =>
    createSmtpClient({
      host: '127.0.0.1',
      port,
      security: 'none',
      clientName: 'chiplog.test',
      ...options
    });

  it('greets, hands over the message and says goodbye', async () => {
    const result = await client().send({
      from: 'log@boat.test',
      to: ['skipper@shore.test', 'crew@shore.test'],
      message: 'Subject: Passage\r\n\r\nArrived.'
    });

    assert.deepEqual(result.recipients, ['skipper@shore.test', 'crew@shore.test']);
    const [session] = relay.sessions;
    assert.equal(session.commands[0], 'EHLO chiplog.test');
    assert.equal(session.from, 'MAIL FROM:<log@boat.test>');
    assert.deepEqual(session.to, ['RCPT TO:<skipper@shore.test>', 'RCPT TO:<crew@shore.test>']);
    assert.equal(session.data, 'Subject: Passage\r\n\r\nArrived.\r\n');
    assert.ok(session.commands.includes('QUIT'));
  });

  it('authenticates when a user name is configured', async () => {
    await client({ username: 'skipper', password: 'secret' }).send({
      from: 'log@boat.test',
      to: ['skipper@shore.test'],
      message: 'Subject: Hi\r\n\r\n.'
    });

    const auth = relay.sessions[0].commands.find((line) => line.startsWith('AUTH'));
    assert.match(auth, /^AUTH PLAIN /);
    assert.equal(
      Buffer.from(auth.slice('AUTH PLAIN '.length), 'base64').toString('utf8'),
      '\0skipper\0secret'
    );
  });

  it('dot-stuffs a line that would otherwise end the message', async () => {
    await client().send({
      from: 'log@boat.test',
      to: ['skipper@shore.test'],
      message: 'Subject: Hi\r\n\r\nbefore\r\n.\r\nafter'
    });

    const [session] = relay.sessions;
    assert.ok(session.commands.includes('QUIT'), 'the message ended where it should');
    assert.equal(session.data, 'Subject: Hi\r\n\r\nbefore\r\n.\r\nafter\r\n');
  });

  it('calls a 5xx refusal permanent, so it is not retried for ever', async () => {
    await new Promise((resolve) => relay.server.close(resolve));
    relay = startRelay({ refuse: { RCPT: '550 5.1.1 No such user' } });
    await new Promise((resolve) => relay.server.listen(port, '127.0.0.1', resolve));

    const error = await client()
      .send({ from: 'log@boat.test', to: ['nobody@shore.test'], message: 'Subject: Hi\r\n\r\n.' })
      .then(
        () => null,
        (err) => err
      );

    assert.ok(error instanceof SmtpError);
    assert.equal(error.permanent, true);
    assert.equal(error.code, 550);
    assert.match(error.message, /No such user/);
  });

  it('calls a 4xx refusal temporary, so it is tried again', async () => {
    await new Promise((resolve) => relay.server.close(resolve));
    relay = startRelay({ refuse: { MAIL: '451 4.3.0 Try later' } });
    await new Promise((resolve) => relay.server.listen(port, '127.0.0.1', resolve));

    const error = await client()
      .send({ from: 'log@boat.test', to: ['a@shore.test'], message: 'Subject: Hi\r\n\r\n.' })
      .then(
        () => null,
        (err) => err
      );

    assert.equal(error.permanent, false);
    assert.equal(error.code, 451);
  });

  it('insists on STARTTLS when it is asked for and not offered', async () => {
    await new Promise((resolve) => relay.server.close(resolve));
    relay = startRelay({ capabilities: ['SIZE 10240000'] });
    await new Promise((resolve) => relay.server.listen(port, '127.0.0.1', resolve));

    await assert.rejects(
      client({ security: 'starttls' }).send({
        from: 'log@boat.test',
        to: ['a@shore.test'],
        message: 'Subject: Hi\r\n\r\n.'
      }),
      /does not offer STARTTLS/
    );
  });

  it('refuses a message with a line SMTP cannot carry, before connecting', async () => {
    await assert.rejects(
      client().send({
        from: 'log@boat.test',
        to: ['a@shore.test'],
        message: `Subject: Hi\r\n\r\n${'x'.repeat(1200)}`
      }),
      /too long for SMTP/
    );
    assert.equal(relay.sessions.length, 0);
  });

  it('needs somewhere to send', async () => {
    await assert.rejects(
      client().send({ from: 'log@boat.test', to: [], message: 'Subject: Hi\r\n\r\n.' }),
      /No recipient/
    );
  });

  it('reports a server it cannot reach rather than hanging', async () => {
    await new Promise((resolve) => relay.server.close(resolve));

    await assert.rejects(
      client().send({
        from: 'log@boat.test',
        to: ['a@shore.test'],
        message: 'Subject: Hi\r\n\r\n.'
      }),
      /ECONNREFUSED|SMTP connection failed/
    );
  });
});

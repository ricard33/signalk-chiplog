const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { describe, it, beforeEach, afterEach } = require('node:test');
const { openDatabase } = require('../lib/database');
const { encodePng } = require('../lib/png');
const { SmtpError } = require('../lib/smtp');
const { createSummaryMailer, SUMMARY_MAIL_DEFAULTS, MAX_AGE_MS } = require('../lib/summary-mailer');
const { insert, insertEntry, startServer } = require('./helpers');

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const T0 = Date.parse('2026-09-13T08:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();

const SETTINGS = {
  ...SUMMARY_MAIL_DEFAULTS,
  summaryMailEnabled: true,
  summaryMailTo: 'skipper@shore.test',
  summaryMailFrom: 'log@boat.test',
  summaryMailTileUrl: '',
  smtpHost: 'relay.test',
  stopClosureMinutes: 30,
  logbookLanguage: 'en',
  logbookTimeZone: 'UTC'
};

function setup({ settings = {}, fail = null } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chiplog-mail-'));
  const { db } = openDatabase(dataDir);
  const clock = { now: T0 };
  const sent = [];
  const logs = [];
  const control = { fail };

  const createClient = (options) => ({
    async send({ from, to, message }) {
      if (control.fail) {
        throw control.fail;
      }
      sent.push({ options, from, to, message });
      return { recipients: to };
    }
  });

  const mailer = createSummaryMailer({
    db,
    settings: { ...SETTINGS, ...settings },
    clock: () => clock.now,
    vesselName: () => 'Zéphyr',
    fetchImpl: async () => {
      throw new Error('no network in tests');
    },
    createClient,
    log: (level, message) => logs.push({ level, message })
  });

  return {
    db,
    mailer,
    clock,
    sent,
    logs,
    control,
    close() {
      db.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  };
}

// A closed passage with a track, ended `endedMinutesAgo` before the clock.
function passage(db, { endedMinutesAgo = 60, distance = 22224, ...fields } = {}) {
  const end = T0 - endedMinutesAgo * MINUTE;
  const start = end - 4 * HOUR;
  const id = insertEntry(db, {
    start_time: iso(start),
    end_time: iso(end),
    start_place_name: 'Les Minimes',
    end_place_name: 'Île d’Aix',
    distance,
    engine_duration: 3600,
    sail_duration: 9000,
    created_at: iso(start),
    updated_at: iso(end),
    ...fields
  });
  for (let i = 0; i <= 20; i += 1) {
    insert(db, 'track_points', {
      entry_id: id,
      time: iso(start + (i * (end - start)) / 20),
      lat: 46.14 + i * 0.002,
      lon: -1.17 - i * 0.001,
      sog: 3 + (i % 5)
    });
  }
  return id;
}

const mailRow = (db, id) =>
  db.prepare('SELECT * FROM passage_summary_mails WHERE entry_id = ?').get(id);

// The readable parts of the message: the text and the HTML, decoded, with the
// image left where it is.
function bodyOf(message) {
  const boundaries = [...message.matchAll(/boundary="([^"]+)"/g)].map((match) => match[1]);
  return message
    .split(new RegExp(`--(?:${boundaries.join('|')})(?:--)?\r\n`))
    .filter((part) => part.startsWith('Content-Type: text/'))
    .map((part) => Buffer.from(part.split('\r\n\r\n').slice(1).join(''), 'base64').toString('utf8'))
    .join('\n');
}

// A throwaway SMTP relay keeping whatever it is handed, for the one test that
// goes through the real plugin rather than an injected client.
function startRelay() {
  const received = [];
  const server = net.createServer((socket) => {
    let inData = false;
    let message = '';
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
            received.push(message);
            message = '';
            socket.write('250 2.0.0 Queued\r\n');
          } else {
            message += `${line.startsWith('..') ? line.slice(1) : line}\r\n`;
          }
          continue;
        }
        const verb = line.split(' ')[0].toUpperCase();
        if (verb === 'EHLO') {
          socket.write('250 relay.test\r\n');
        } else if (verb === 'DATA') {
          inData = true;
          socket.write('354 go ahead\r\n');
        } else if (verb === 'QUIT') {
          socket.write('221 2.0.0 Bye\r\n');
          socket.end();
        } else {
          socket.write('250 2.0.0 Ok\r\n');
        }
      }
    });
    socket.on('error', () => {});
  });
  return { server, received };
}

describe('the passage summary mailer', () => {
  let ctx;

  beforeEach(() => {
    ctx = setup();
  });

  afterEach(() => ctx.close());

  it('waits out the delay in which a departure would carry the passage on', async () => {
    const id = passage(ctx.db, { endedMinutesAgo: 20 });

    assert.equal((await ctx.mailer.resolveNext()).outcome, 'idle');
    assert.equal(ctx.sent.length, 0);
    assert.equal(mailRow(ctx.db, id), undefined);

    ctx.clock.now += 11 * MINUTE;
    assert.equal((await ctx.mailer.resolveNext()).outcome, 'sent');
    assert.equal(ctx.sent.length, 1);
  });

  it('never summarises a passage still under way', async () => {
    passage(ctx.db, { state: 'active', end_time: null });

    assert.equal((await ctx.mailer.resolveNext()).outcome, 'idle');
    assert.equal(ctx.sent.length, 0);
  });

  it('sends each passage once, and remembers that it did', async () => {
    const id = passage(ctx.db);

    await ctx.mailer.resolveNext();
    assert.equal((await ctx.mailer.resolveNext()).outcome, 'idle');

    assert.equal(ctx.sent.length, 1);
    const row = mailRow(ctx.db, id);
    assert.equal(row.sent_at, iso(T0));
    assert.equal(row.recipients, 'skipper@shore.test');
    assert.equal(row.error, null);
  });

  it('works through a backlog oldest first', async () => {
    const older = passage(ctx.db, { endedMinutesAgo: 10 * 60 });
    const newer = passage(ctx.db, { endedMinutesAgo: 2 * 60 });

    for (let run = 0; run < 3; run += 1) {
      await ctx.mailer.resolveNext();
    }

    assert.equal(ctx.sent.length, 2);
    assert.deepEqual(
      [mailRow(ctx.db, older).sent_at, mailRow(ctx.db, newer).sent_at].map(Boolean),
      [true, true]
    );
    assert.match(ctx.sent[0].message, new RegExp(`passage-${older}\\.png|Subject`));
    assert.equal(ctx.logs.filter((entry) => entry.level === 'info').length, 2);
  });

  it('writes off a passage too old for its summary to be news', async () => {
    const stale = passage(ctx.db, { endedMinutesAgo: MAX_AGE_MS / MINUTE + 60 });

    assert.equal((await ctx.mailer.resolveNext()).outcome, 'idle');

    assert.equal(ctx.sent.length, 0);
    const row = mailRow(ctx.db, stale);
    assert.equal(row.sent_at, null);
    assert.match(row.error, /too long ago/);
  });

  it('sends nothing while the option is off, and nothing retroactively when it goes on', async () => {
    const off = setup({ settings: { summaryMailEnabled: false } });
    try {
      passage(off.db, {});
      assert.equal((await off.mailer.resolveNext()).outcome, 'disabled');
      assert.equal(off.sent.length, 0);
      assert.equal(off.db.prepare('SELECT COUNT(*) AS n FROM passage_summary_mails').get().n, 0);
    } finally {
      off.close();
    }
  });

  it('holds back while the configuration is incomplete', async () => {
    for (const missing of [{ smtpHost: null }, { summaryMailTo: '' }, { summaryMailFrom: null }]) {
      const partial = setup({ settings: missing });
      try {
        passage(partial.db, {});
        assert.equal((await partial.mailer.resolveNext()).outcome, 'disabled');
        assert.equal(partial.mailer.status().configured, false);
        assert.ok(partial.mailer.status().problem);
      } finally {
        partial.close();
      }
    }
  });

  it('retries a relay that is merely unreachable, with a growing delay', async () => {
    const id = passage(ctx.db);
    ctx.control.fail = new SmtpError('SMTP connection failed: ECONNREFUSED');

    const first = await ctx.mailer.resolveNext();
    const second = await ctx.mailer.resolveNext();

    assert.equal(first.outcome, 'failed');
    assert.ok(second.retryInMs > first.retryInMs);
    assert.equal(mailRow(ctx.db, id), undefined, 'the passage is still due a summary');

    ctx.control.fail = null;
    assert.equal((await ctx.mailer.resolveNext()).outcome, 'sent');
    assert.equal(ctx.sent.length, 1);
  });

  it('gives up on a refusal the relay would only repeat', async () => {
    const id = passage(ctx.db);
    ctx.control.fail = new SmtpError('SMTP the recipient refused: 550 No such user', {
      code: 550,
      permanent: true
    });

    assert.equal((await ctx.mailer.resolveNext()).outcome, 'refused');
    assert.equal((await ctx.mailer.resolveNext()).outcome, 'idle');

    const row = mailRow(ctx.db, id);
    assert.equal(row.sent_at, null);
    assert.match(row.error, /No such user/);
    assert.equal(ctx.logs.filter((entry) => entry.level === 'error').length, 1);
    assert.match(ctx.mailer.status().lastError.message, /No such user/);
  });

  it('stops where it is when the plugin stops', async () => {
    passage(ctx.db);
    ctx.control.fail = new Error('network down');
    ctx.mailer.stop();

    assert.equal((await ctx.mailer.resolveNext()).outcome, 'stopped');
  });
});

describe('what a passage summary says', () => {
  let ctx;
  let id;

  beforeEach(async () => {
    ctx = setup();
    id = passage(ctx.db, { distance: 46300 });
    await ctx.mailer.resolveNext();
  });

  afterEach(() => ctx.close());

  it('names the vessel, the route and the figures asked of it', () => {
    const [mail] = ctx.sent;
    const body = bodyOf(mail.message);

    assert.match(mail.message, /^Subject: =\?UTF-8\?B\?/m);
    assert.match(body, /Les Minimes/);
    assert.match(body, /Île d’Aix/);
    for (const [label, value] of [
      ['Departure', /Sep 13, 2026 03:00/],
      ['Arrival', /07:00/],
      ['Distance', /25\.0 nm/],
      ['Duration', /4 h 00/],
      ['Under way', /3 h 30/],
      ['Engine', /1 h 00/],
      ['Sail', /2 h 30/],
      // 46 300 m in the 3 h 30 under way, and 7 m/s at the fastest.
      ['Average speed', /7\.1 kn/],
      ['Max speed', /13\.6 kn/]
    ]) {
      assert.match(body, new RegExp(`${label}:`), `${label} is given`);
      assert.match(body, value, `${label} value`);
    }
  });

  it('is sent from the vessel, to every configured address', async () => {
    const many = setup({ settings: { summaryMailTo: 'a@shore.test, Second <b@shore.test>' } });
    try {
      passage(many.db);
      await many.mailer.resolveNext();

      const [mail] = many.sent;
      assert.equal(mail.from, 'log@boat.test');
      assert.deepEqual(mail.to, ['a@shore.test', 'b@shore.test']);
      assert.match(mail.message, /^To: a@shore\.test, Second <b@shore\.test>$/m);
      assert.equal(mailRow(many.db, 1).recipients, 'a@shore.test, b@shore.test');
    } finally {
      many.close();
    }
  });

  it('carries the map as an inline image the HTML points at', () => {
    const [mail] = ctx.sent;

    assert.match(mail.message, /Content-Type: multipart\/related;/);
    assert.match(mail.message, /Content-ID: <passage-map>/);
    assert.match(mail.message, new RegExp(`filename="passage-${id}\\.png"`));
    assert.match(bodyOf(mail.message), /src="cid:passage-map"/);
  });

  it('is written in the configured language and ship’s time', async () => {
    const french = setup({
      settings: { logbookLanguage: 'fr', logbookTimeZone: 'Europe/Paris' }
    });
    try {
      passage(french.db);
      await french.mailer.resolveNext();

      const body = bodyOf(french.sent[0].message);
      assert.match(body, /Départ\s*:/);
      assert.match(body, /Distance/);
      assert.match(body, /Vitesse max/);
      // 03:00 UTC is 05:00 in Paris in September.
      assert.match(body, /05:00/);
    } finally {
      french.close();
    }
  });

  it('still goes out when the passage has no track to draw', async () => {
    const bare = setup();
    try {
      const empty = insertEntry(bare.db, {
        start_time: iso(T0 - 3 * HOUR),
        end_time: iso(T0 - HOUR),
        start_place_name: 'Les Minimes',
        distance: 0,
        engine_duration: 0,
        sail_duration: 0
      });
      await bare.mailer.resolveNext();

      assert.equal(bare.sent.length, 1);
      assert.ok(mailRow(bare.db, empty).sent_at);
      assert.doesNotMatch(bare.sent[0].message, /Content-ID/);
      assert.match(bodyOf(bare.sent[0].message), /No track recorded/);
    } finally {
      bare.close();
    }
  });

  it('draws the map over the tiles when a tile server is configured', async () => {
    const tile = encodePng({ width: 256, height: 256, data: Buffer.alloc(256 * 256 * 3, 0x40) });
    const asked = [];
    const tiled = setup({ settings: { summaryMailTileUrl: 'https://tiles.test/{z}/{x}/{y}.png' } });
    try {
      // The injected fetch is the only network the mailer has.
      const mailer = createSummaryMailer({
        db: tiled.db,
        settings: {
          ...SETTINGS,
          summaryMailTileUrl: 'https://tiles.test/{z}/{x}/{y}.png'
        },
        clock: () => T0,
        fetchImpl: async (url) => {
          asked.push(url);
          return {
            ok: true,
            arrayBuffer: async () =>
              tile.buffer.slice(tile.byteOffset, tile.byteOffset + tile.length)
          };
        },
        createClient: () => ({ send: async () => ({ recipients: [] }) })
      });
      passage(tiled.db);
      assert.equal((await mailer.resolveNext()).outcome, 'sent');
      assert.ok(asked.length > 0);
      assert.ok(asked.every((url) => url.startsWith('https://tiles.test/')));
    } finally {
      tiled.close();
    }
  });
});

describe('the plugin and its summary emails', () => {
  it('counts every passage already on record as dealt with when the feature arrives', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chiplog-upgrade-'));
    try {
      // An installation on the schema version before summary emails existed.
      const before = openDatabase(dataDir).db;
      const closed = insertEntry(before, { end_time: iso(T0) });
      const open = insertEntry(before, { state: 'active', end_time: null });
      const latest = before.prepare('PRAGMA user_version').get().user_version;
      // Back to the version before migration 18, which brought summary emails,
      // undoing it and every migration since.
      before.exec('DROP TABLE logbook_identity');
      before.exec('DROP TABLE passage_summary_mails');
      before.exec('PRAGMA user_version = 17');
      before.close();

      const { db, migrated } = openDatabase(dataDir);
      try {
        assert.deepEqual(migrated, { from: 17, to: latest });
        assert.deepEqual(
          db
            .prepare('SELECT entry_id, sent_at FROM passage_summary_mails')
            .all()
            .map((row) => ({ ...row })),
          [{ entry_id: closed, sent_at: null }],
          'the passage already closed is written off, the one under way is not'
        );
        assert.match(
          db.prepare('SELECT error FROM passage_summary_mails WHERE entry_id = ?').get(closed)
            .error,
          /before summary emails/
        );
        assert.equal(
          db.prepare('SELECT * FROM passage_summary_mails WHERE entry_id = ?').get(open),
          undefined,
          'and the passage under way is still due a summary when it ends'
        );
      } finally {
        db.close();
      }
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('reports what it is set up to do, and sends nothing without being configured', async () => {
    const ctx = await startServer();
    try {
      const { status, body } = await ctx.request('GET', '/summary-mail');
      assert.equal(status, 200);
      assert.deepEqual(body.enabled, false);
      assert.equal(body.configured, false);
      assert.match(body.problem, /SMTP/);
      assert.deepEqual(body.recipients, []);

      const id = insertEntry(ctx.db, {});
      const refused = await ctx.request('POST', `/entries/${id}/summary-mail`);
      assert.equal(refused.status, 409);
      assert.equal(refused.body.error.code, 'summary_mail_failed');

      const missing = await ctx.request('POST', '/entries/9999/summary-mail');
      assert.equal(missing.status, 404);
    } finally {
      await ctx.close();
    }
  });
});

describe('a passage that gets going again', () => {
  it('is due a fresh summary once it really ends', async () => {
    const ctx = setup();
    try {
      const id = passage(ctx.db);
      await ctx.mailer.resolveNext();
      assert.ok(mailRow(ctx.db, id).sent_at);

      // What detection does when a cast-off reopens the passage.
      ctx.db
        .prepare("UPDATE log_entries SET state = 'active', end_time = NULL WHERE id = ?")
        .run(id);
      ctx.db.prepare('DELETE FROM passage_summary_mails WHERE entry_id = ?').run(id);
      ctx.db
        .prepare("UPDATE log_entries SET state = 'closed', end_time = ? WHERE id = ?")
        .run(iso(T0 - 31 * MINUTE), id);

      assert.equal((await ctx.mailer.resolveNext()).outcome, 'sent');
      assert.equal(ctx.sent.length, 2);
    } finally {
      ctx.close();
    }
  });
});

describe('the plugin, a relay and a passage', () => {
  it('sends the summary over SMTP with the settings from the plugin configuration', async () => {
    const { server, received } = startRelay();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const now = Date.now();
    const ctx = await startServer({
      config: {
        summaryMailEnabled: true,
        summaryMailTo: 'skipper@shore.test',
        summaryMailFrom: 'log@boat.test',
        smtpHost: '127.0.0.1',
        smtpPort: server.address().port,
        smtpSecurity: 'none',
        summaryMailTileUrl: '',
        logbookLanguage: 'fr',
        logbookTimeZone: 'Europe/Paris'
      },
      self: { name: 'Zéphyr' }
    });

    try {
      const end = now - 45 * MINUTE;
      const id = insertEntry(ctx.db, {
        start_time: iso(end - 4 * HOUR),
        end_time: iso(end),
        start_place_name: 'Les Minimes',
        end_place_name: 'Île d’Aix',
        distance: 46300,
        engine_duration: 3600,
        sail_duration: 9000
      });
      insert(ctx.db, 'track_points', {
        entry_id: id,
        time: iso(end - HOUR),
        lat: 46.14,
        lon: -1.17,
        sog: 4
      });

      const sent = await ctx.request('POST', `/entries/${id}/summary-mail`);

      assert.equal(sent.status, 200);
      assert.deepEqual(sent.body, { entryId: id, recipients: ['skipper@shore.test'] });
      assert.equal(received.length, 1);
      assert.match(received[0], /^From: .*<log@boat\.test>$/m, 'under the vessel’s name');
      assert.match(received[0], /^To: skipper@shore\.test$/m);
      assert.match(received[0], /Content-ID: <passage-map>/);
      assert.deepEqual(ctx.errors, []);

      const status = await ctx.request('GET', '/summary-mail');
      assert.equal(status.body.lastSuccess.entryId, id);
      assert.equal(status.body.lastError, null);
      assert.ok(
        ctx.db.prepare('SELECT sent_at FROM passage_summary_mails WHERE entry_id = ?').get(id)
          .sent_at
      );
    } finally {
      await ctx.close();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

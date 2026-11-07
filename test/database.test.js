const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, it, afterEach } = require('node:test');
const { openDatabase, withTransaction } = require('../lib/database');

describe('withTransaction', () => {
  let db;
  let dataDir;

  afterEach(() => {
    db?.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  function open() {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chiplog-db-'));
    ({ db } = openDatabase(dataDir));
    db.exec('CREATE TABLE t (n INTEGER)');
  }

  const count = () => db.prepare('SELECT COUNT(*) AS n FROM t').get().n;

  it('lets a nested call join the outer transaction', () => {
    open();
    const result = withTransaction(db, () => {
      db.exec('INSERT INTO t VALUES (1)');
      return withTransaction(db, () => {
        db.exec('INSERT INTO t VALUES (2)');
        return 'inner';
      });
    });

    assert.equal(result, 'inner');
    assert.equal(count(), 2);
    // Back to a plain connection: a new transaction can start.
    withTransaction(db, () => db.exec('INSERT INTO t VALUES (3)'));
    assert.equal(count(), 3);
  });

  it('rolls the whole transaction back when a nested call fails', () => {
    open();
    assert.throws(
      () =>
        withTransaction(db, () => {
          db.exec('INSERT INTO t VALUES (1)');
          withTransaction(db, () => {
            db.exec('INSERT INTO t VALUES (2)');
            throw new Error('boom');
          });
        }),
      /boom/
    );

    assert.equal(count(), 0);
    withTransaction(db, () => db.exec('INSERT INTO t VALUES (3)'));
    assert.equal(count(), 1);
  });
});

describe('the weather observation shortcut', () => {
  it('is added to a logbook seeded without it, after the shortcuts it has', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chiplog-db-'));
    try {
      let { db } = openDatabase(dataDir);
      const latest = db.prepare('PRAGMA user_version').get().user_version;
      // A logbook as it was before the migration, with a shortcut of the crew's own.
      db.prepare("DELETE FROM manoeuvre_types WHERE key = 'weather_observation'").run();
      db.prepare(
        "INSERT INTO manoeuvre_types (key, label, sort_order, builtin) VALUES ('lock', 'Lock', 110, 0)"
      ).run();
      db.exec(`PRAGMA user_version = ${latest - 1}`);
      db.close();

      ({ db } = openDatabase(dataDir));
      const row = db
        .prepare("SELECT * FROM manoeuvre_types WHERE key = 'weather_observation'")
        .get();
      assert.equal(row.builtin, 1);
      assert.equal(row.enabled, 1);
      assert.equal(row.sort_order, 120);
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, latest);
      db.close();
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

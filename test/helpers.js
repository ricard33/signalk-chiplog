const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const express = require('express');
const createPlugin = require('..');

const T0 = '2026-09-13T08:00:00.000Z';

function at(hours) {
  return new Date(Date.parse(T0) + hours * 3600 * 1000).toISOString();
}

// Mirrors signalk-server's asPluginRouter: routes registered through access()
// are recorded with their level, everything else stays admin-only.
function createPluginRouter() {
  const router = express.Router();
  const permissions = [];
  router.access = (level) => {
    const registrar = {};
    for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
      registrar[method] = (routePath, ...handlers) => {
        permissions.push({ method: method.toUpperCase(), path: routePath, level });
        router[method](routePath, ...handlers);
        return registrar;
      };
    }
    return registrar;
  };
  return { router, permissions };
}

async function startServer({ config = {}, self = {} } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chiplog-test-'));
  const errors = [];
  const app = {
    getDataDirPath: () => dataDir,
    getSelfPath: (selfPath) => selfPath.split('.').reduce((node, key) => node?.[key], self),
    debug: () => {},
    error: (message) => errors.push(message),
    setPluginStatus: () => {},
    setPluginError: () => {}
  };

  const plugin = createPlugin(app);
  const { router, permissions } = createPluginRouter();
  plugin.registerWithRouter(router);
  // Tests must never reach the public geocoding, landmark, tide or weather
  // service, a tile server or a mail relay.
  plugin.start(
    {
      geocodingEnabled: false,
      landmarksEnabled: false,
      tidesEnabled: false,
      weatherEnabled: false,
      summaryMailEnabled: false,
      ...config
    },
    () => {}
  );

  const server = express();
  server.use(express.json({ limit: '10mb' }));
  server.use('/plugins/signalk-chiplog', router);
  const listener = await new Promise((resolve) => {
    const instance = server.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const baseUrl = `http://127.0.0.1:${listener.address().port}/plugins/signalk-chiplog/api`;

  const db = new DatabaseSync(path.join(dataDir, 'chiplog.sqlite'));
  db.exec('PRAGMA foreign_keys = ON');

  async function request(method, url, body) {
    const response = await fetch(`${baseUrl}${url}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // Non-JSON bodies (GPX, CSV, empty 204) are read through `text`.
    }
    return { status: response.status, headers: response.headers, body: json, text };
  }

  async function close() {
    db.close();
    plugin.stop();
    listener.closeAllConnections();
    await new Promise((resolve) => listener.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  return { baseUrl, db, plugin, router, permissions, errors, self, dataDir, request, close };
}

function insert(db, table, row) {
  const columns = Object.keys(row);
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`
    )
    .run(...Object.values(row));
  return Number(lastInsertRowid);
}

function insertEntry(db, fields = {}) {
  const active = fields.state === 'active';
  return insert(db, 'log_entries', {
    state: 'closed',
    start_time: T0,
    end_time: active ? null : at(4),
    created_at: T0,
    updated_at: T0,
    ...fields
  });
}

module.exports = { T0, at, startServer, insert, insertEntry };

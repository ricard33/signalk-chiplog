const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { registerRoutes } = require('../lib/api');
const { getOpenApi, OPERATIONS } = require('../lib/openapi');
const { startServer } = require('./helpers');

// The public routes as lib/api.js registers them, with their access level.
function registeredRoutes() {
  const noop = () => {};
  const registrar = Object.fromEntries(
    ['get', 'post', 'put', 'patch', 'delete'].map((method) => [method, noop])
  );
  const router = { ...registrar, access: () => registrar };
  return registerRoutes(router, { getContext: noop, logError: noop });
}

// Every $ref in the document, wherever it is.
function refs(value, found = []) {
  if (Array.isArray(value)) {
    value.forEach((item) => refs(item, found));
  } else if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (key === '$ref') {
        found.push(child);
      } else {
        refs(child, found);
      }
    }
  }
  return found;
}

describe('the OpenAPI document', () => {
  it('describes every v1 route, and only those, at its access level', () => {
    const registered = registeredRoutes()
      .map(({ method, path, level }) => `${method} ${path} ${level}`)
      .sort();
    const described = Object.entries(OPERATIONS)
      .map(([key, [level]]) => `${key} ${level}`)
      .sort();
    assert.deepEqual(described, registered);
  });

  it('is well formed: unique operation ids, references that resolve, an error response', () => {
    const document = getOpenApi();
    assert.equal(document.openapi, '3.0.3');
    assert.equal(document.info.version, require('../package.json').version);
    assert.deepEqual(document.servers, [{ url: '/plugins/signalk-chiplog/api/v1' }]);

    const operations = Object.values(document.paths).flatMap((item) => Object.values(item));
    const ids = operations.map((operation) => operation.operationId);
    assert.equal(new Set(ids).size, ids.length, 'operation ids are unique');
    for (const operation of operations) {
      assert.ok(operation.responses.default, operation.operationId);
      assert.ok(['readonly', 'readwrite', 'admin'].includes(operation['x-signalk-access']));
    }
    for (const path of Object.keys(document.paths)) {
      assert.doesNotMatch(path, /:/, 'OpenAPI path parameters, not Express ones');
    }

    const schemas = document.components.schemas;
    for (const target of refs(document)) {
      const name = target.replace('#/components/schemas/', '');
      assert.ok(schemas[name], `${target} resolves`);
    }
  });

  it('closes request bodies and leaves responses open', () => {
    const { schemas } = getOpenApi().components;
    for (const name of ['PlanInput', 'PlanPatch', 'DefectInput', 'DefectPatch', 'EventInput']) {
      assert.equal(schemas[name].additionalProperties, false, name);
    }
    for (const name of ['Plan', 'Defect', 'Entry', 'Event', 'State', 'Changes']) {
      assert.notEqual(schemas[name].additionalProperties, false, name);
    }
  });

  it('is served by the plugin and by the API itself', async () => {
    const ctx = await startServer();
    try {
      assert.deepEqual(ctx.plugin.getOpenApi(), getOpenApi());
      const { status, body } = await ctx.request('GET', '/v1/openapi.json');
      assert.equal(status, 200);
      assert.deepEqual(body, getOpenApi());
    } finally {
      await ctx.close();
    }
  });
});

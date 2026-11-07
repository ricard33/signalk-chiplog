const assert = require('node:assert/strict');
const { describe, it, beforeEach, afterEach } = require('node:test');
const { startServer } = require('./helpers');

describe('manoeuvre types', () => {
  let ctx;

  beforeEach(async () => {
    ctx = await startServer();
  });

  afterEach(() => ctx.close());

  it('lists the built-in shortcuts in order', async () => {
    const { body } = await ctx.request('GET', '/manoeuvre-types');
    assert.equal(body.total, 11);
    assert.equal(body.items[0].key, 'tack');
    assert.equal(body.items[0].builtin, true);
    assert.equal(body.items[0].enabled, true);
  });

  it('creates a custom shortcut after the existing ones', async () => {
    const { status, body } = await ctx.request('POST', '/manoeuvre-types', {
      key: 'spinnaker_up',
      label: 'Hoist spinnaker'
    });

    assert.equal(status, 201);
    assert.equal(body.builtin, false);
    assert.equal(body.sortOrder, 120);

    const duplicate = await ctx.request('POST', '/manoeuvre-types', {
      key: 'spinnaker_up',
      label: 'Again'
    });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error.code, 'manoeuvre_type_exists');
  });

  it('validates the key format', async () => {
    const { status } = await ctx.request('POST', '/manoeuvre-types', {
      key: 'Hoist Spinnaker!',
      label: 'Hoist spinnaker'
    });
    assert.equal(status, 400);
  });

  it('lets a built-in be relabelled and disabled but not deleted', async () => {
    const patched = await ctx.request('PATCH', '/manoeuvre-types/gybe', {
      label: 'Jibe',
      enabled: false
    });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.label, 'Jibe');
    assert.equal(patched.body.enabled, false);

    const renamedKey = await ctx.request('PATCH', '/manoeuvre-types/gybe', { key: 'jibe' });
    assert.equal(renamedKey.status, 400);

    const deleted = await ctx.request('DELETE', '/manoeuvre-types/gybe');
    assert.equal(deleted.status, 409);
    assert.equal(deleted.body.error.code, 'builtin_manoeuvre_type');
  });

  it('deletes a custom shortcut', async () => {
    await ctx.request('POST', '/manoeuvre-types', { key: 'lock', label: 'Lock passage' });
    assert.equal((await ctx.request('DELETE', '/manoeuvre-types/lock')).status, 204);
    assert.equal((await ctx.request('DELETE', '/manoeuvre-types/lock')).status, 404);
  });
});

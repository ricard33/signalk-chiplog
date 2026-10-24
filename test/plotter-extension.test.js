const assert = require('node:assert/strict');
const { describe, it, afterEach } = require('node:test');
const { startServer } = require('./helpers');
const { version } = require('../package.json');

describe('plotter extension discovery', () => {
  let ctx;
  afterEach(() => ctx?.close());

  it('advertises the helm entry panel and its toolbar action while running', async () => {
    ctx = await startServer();
    const { methods } = ctx.providers.get('plotterExtensions');
    const manifest = (await methods.listResources())['signalk-chiplog'];
    assert.equal(manifest.version, version);
    assert.equal(manifest.apiVersion, '1');
    assert.deepEqual(manifest.requires, ['panels.iframe', 'buttons']);
    assert.equal(manifest.panels[0].url, '/signalk-chiplog/entry/?plotterExtension=1');
    assert.equal(manifest.panels[0].type, 'iframe');
    assert.equal(manifest.panels[0].lifecycle, 'keepAlive');
    assert.deepEqual(manifest.buttons[0].action, {
      type: 'togglePanel',
      panel: manifest.panels[0].id
    });
    assert.deepEqual(await methods.getResource('signalk-chiplog'), manifest);
    await assert.rejects(methods.getResource('other-extension'), /No such/);
    await assert.rejects(methods.setResource('signalk-chiplog', {}), /read-only/);
    await assert.rejects(methods.deleteResource('signalk-chiplog'), /read-only/);
  });

  it('withdraws the manifest on stop and publishes it again on restart', async () => {
    ctx = await startServer();
    const { methods } = ctx.providers.get('plotterExtensions');
    ctx.plugin.stop();
    assert.deepEqual(await methods.listResources(), {});
    await assert.rejects(methods.getResource('signalk-chiplog'), /No such/);
    ctx.plugin.start({
      geocodingEnabled: false,
      landmarksEnabled: false,
      tidesEnabled: false,
      weatherEnabled: false
    });
    assert.equal(Object.keys(await methods.listResources()).length, 1);
    assert.equal(ctx.providers.size, 1);
  });

  it('keeps the standalone app usable on servers without resource providers', async () => {
    ctx = await startServer({ resourceProviders: false });
    assert.equal(ctx.providers.size, 0);
    assert.equal((await ctx.request('GET', '/state')).status, 200);
  });
});

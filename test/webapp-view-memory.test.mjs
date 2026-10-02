import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createViewMemory } from '../public/js/view-memory.mjs';

describe('what a view leaves behind', () => {
  it('has nothing for a view that has never asked to be remembered', () => {
    const memory = createViewMemory();

    assert.equal(memory.recall('log'), null);
  });

  it('gives back what was left', () => {
    const memory = createViewMemory();

    memory.remember('log', { wanted: 100, scrollY: 1840 });

    assert.deepEqual(memory.recall('log'), { wanted: 100, scrollY: 1840 });
  });

  it('merges, so the view and the router each record their own part', () => {
    const memory = createViewMemory();

    memory.remember('log', { wanted: 100 });
    memory.remember('log', { scrollY: 1840 });
    memory.remember('log', { wanted: 150 });

    assert.deepEqual(memory.recall('log'), { wanted: 150, scrollY: 1840 });
  });

  it('keeps each view apart', () => {
    const memory = createViewMemory();

    memory.remember('log', { scrollY: 1840 });
    memory.remember('statistics', { scrollY: 200 });

    assert.equal(memory.recall('log').scrollY, 1840);
    assert.equal(memory.recall('statistics').scrollY, 200);
    assert.equal(memory.recall('passage'), null);
  });

  it('hands out a snapshot, not the memory itself', () => {
    const memory = createViewMemory();
    memory.remember('log', { wanted: 100 });

    const recalled = memory.recall('log');
    recalled.wanted = 999;

    assert.equal(memory.recall('log').wanted, 100);
  });

  it('forgets a view, which then reads as never remembered', () => {
    const memory = createViewMemory();
    memory.remember('log', { scrollY: 1840 });

    memory.forget('log');

    assert.equal(memory.recall('log'), null);
  });
});

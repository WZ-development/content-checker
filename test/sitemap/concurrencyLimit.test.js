'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { createLimiter } = require('../../lib/sitemap/concurrencyLimit');

describe('createLimiter', () => {
  test('never runs more than `concurrency` functions at once', async () => {
    const limit = createLimiter(2);
    let active = 0;
    let maxActive = 0;

    const task = () =>
      limit(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
        return 'done';
      });

    const results = await Promise.all([task(), task(), task(), task(), task()]);
    assert.equal(maxActive <= 2, true);
    assert.deepEqual(results, ['done', 'done', 'done', 'done', 'done']);
  });

  test('propagates a rejection for that task without affecting others', async () => {
    const limit = createLimiter(2);
    const ok = limit(async () => 'ok');
    const bad = limit(async () => {
      throw new Error('boom');
    });
    await assert.rejects(() => bad, /boom/);
    assert.equal(await ok, 'ok');
  });

  test('rejects a non-positive-integer concurrency', () => {
    assert.throws(() => createLimiter(0), TypeError);
    assert.throws(() => createLimiter(-1), TypeError);
    assert.throws(() => createLimiter(1.5), TypeError);
  });
});

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { describeOutboundTokenStartupNotice } = require('../src/server');

describe('describeOutboundTokenStartupNotice (sprint 7, requirement 2)', () => {
  test('when configured, states plainly that it is configured', () => {
    const text = describeOutboundTokenStartupNotice(true);
    assert.match(text, /outbound identification token is configured/i);
  });

  test('when NOT configured, names the environment variable and how to generate one', () => {
    const text = describeOutboundTokenStartupNotice(false);
    assert.match(text, /outbound identification token is not configured/i);
    assert.match(text, /CONTENTCHECK_OUTBOUND_TOKEN/);
    assert.match(text, /generate-outbound-token/);
  });

  test('neither branch ever contains anything that looks like a real token value', () => {
    // Both calls only ever receive a boolean — this just documents that
    // guarantee at the text level too, so a future edit that
    // accidentally threads the real value through here would be caught.
    for (const configured of [true, false]) {
      const text = describeOutboundTokenStartupNotice(configured);
      assert.doesNotMatch(text, /[0-9a-f]{32,}/i, 'must never contain a hex-token-shaped string');
    }
  });
});

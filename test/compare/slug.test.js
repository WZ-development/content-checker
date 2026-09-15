'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { deriveSlugTitle } = require('../../lib/compare/slug');

describe('deriveSlugTitle (requirement 8, acceptance criterion examples)', () => {
  test('/news/q3-earnings/ -> "Q3 Earnings" (hyphens)', () => {
    assert.equal(deriveSlugTitle('https://example.test/news/q3-earnings/'), 'Q3 Earnings');
  });

  test('/about_our_team/ -> "About Our Team" (underscores)', () => {
    assert.equal(deriveSlugTitle('https://example.test/about_our_team/'), 'About Our Team');
  });

  test('a percent-encoded segment decodes before word-splitting', () => {
    assert.equal(deriveSlugTitle('https://example.test/blog/caf%C3%A9-guide/'), 'Café Guide');
  });

  test('mixed hyphens and underscores in one segment', () => {
    assert.equal(deriveSlugTitle('https://example.test/2026_q3-earnings-report/'), '2026 Q3 Earnings Report');
  });

  test('no trailing slash still finds the last real segment', () => {
    assert.equal(deriveSlugTitle('https://example.test/news/q3-earnings'), 'Q3 Earnings');
  });

  test('the bare root path falls back to a fixed label rather than an empty string', () => {
    assert.equal(deriveSlugTitle('https://example.test/'), 'Home');
  });

  test('an unparseable URL does not throw', () => {
    assert.doesNotThrow(() => deriveSlugTitle('not a url'));
  });

  test('malformed percent-encoding does not throw', () => {
    assert.doesNotThrow(() => deriveSlugTitle('https://example.test/broken-%zz-segment/'));
  });
});

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { originOf, isAllowedOrigin } = require('../../lib/sitemap/originScope');

describe('originOf', () => {
  test('returns scheme+host+port, lowercased', () => {
    assert.equal(originOf('https://Example.Test/some/path?x=1'), 'https://example.test');
  });

  test('includes a non-default port', () => {
    assert.equal(originOf('https://example.test:8443/a'), 'https://example.test:8443');
  });

  test('a scheme change produces a different origin string', () => {
    assert.notEqual(originOf('http://example.test/a'), originOf('https://example.test/a'));
  });
});

describe('isAllowedOrigin (sprint 7 fix-loop, QA1 round 1 findings A/B)', () => {
  test('true when the URL origin is a member of allowedOrigins', () => {
    assert.equal(isAllowedOrigin('https://staging.test/a/b', new Set(['https://staging.test'])), true);
  });

  test('false when the URL origin is NOT a member', () => {
    assert.equal(isAllowedOrigin('https://attacker.example/a', new Set(['https://staging.test'])), false);
  });

  test('false on a scheme change even for the same host', () => {
    assert.equal(isAllowedOrigin('http://staging.test/a', new Set(['https://staging.test'])), false);
  });

  test('false on a port change even for the same host and scheme', () => {
    assert.equal(isAllowedOrigin('https://staging.test:8443/a', new Set(['https://staging.test'])), false);
  });

  test('false when allowedOrigins is undefined — the safe default', () => {
    assert.equal(isAllowedOrigin('https://staging.test/a', undefined), false);
  });

  test('false when allowedOrigins is an empty Set', () => {
    assert.equal(isAllowedOrigin('https://staging.test/a', new Set()), false);
  });

  test('false, not a thrown error, on a malformed URL', () => {
    assert.doesNotThrow(() => isAllowedOrigin('not-a-url', new Set(['https://staging.test'])));
    assert.equal(isAllowedOrigin('not-a-url', new Set(['https://staging.test'])), false);
  });

  test('true when the origin matches ANY member of a multi-origin set', () => {
    const allowed = new Set(['https://live.test', 'https://staging.test']);
    assert.equal(isAllowedOrigin('https://live.test/a', allowed), true);
    assert.equal(isAllowedOrigin('https://staging.test/a', allowed), true);
    assert.equal(isAllowedOrigin('https://other.test/a', allowed), false);
  });
});

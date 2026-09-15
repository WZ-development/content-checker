'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { normalizeUrlForComparison } = require('../../lib/compare/normalize');

describe('normalizeUrlForComparison', () => {
  test('the acceptance criterion: three real-world variants all normalize to the same key', () => {
    const a = normalizeUrlForComparison('https://clientdomain.com/About/');
    const b = normalizeUrlForComparison('http://www.clientdomain.com/about');
    const c = normalizeUrlForComparison('https://staging.clientdomain.com/about/#team');
    assert.equal(a, b);
    assert.equal(b, c);
  });

  test('scheme does not affect the key', () => {
    assert.equal(
      normalizeUrlForComparison('http://example.test/page/'),
      normalizeUrlForComparison('https://example.test/page/')
    );
  });

  test('host does not affect the key — an arbitrary staging host, unconfigured', () => {
    const key = '/blog/post-1';
    for (const host of [
      'clientdomain.com',
      'www.clientdomain.com',
      'staging.clientdomain.com',
      'client.wpengine.com',
      'dev-client.kinsta.cloud',
    ]) {
      assert.equal(normalizeUrlForComparison(`https://${host}/blog/post-1`), key);
    }
  });

  test('path case does not affect the key', () => {
    assert.equal(
      normalizeUrlForComparison('https://example.test/About-Us'),
      normalizeUrlForComparison('https://example.test/about-us')
    );
  });

  test('trailing slash is normalized consistently', () => {
    assert.equal(
      normalizeUrlForComparison('https://example.test/about/'),
      normalizeUrlForComparison('https://example.test/about')
    );
  });

  test('the bare root path is preserved as "/", not reduced to empty', () => {
    assert.equal(normalizeUrlForComparison('https://example.test/'), '/');
  });

  test('a fragment is dropped', () => {
    assert.equal(
      normalizeUrlForComparison('https://example.test/about#team'),
      normalizeUrlForComparison('https://example.test/about')
    );
  });

  describe('query strings', () => {
    test('are preserved, unlike scheme/host/fragment', () => {
      assert.notEqual(
        normalizeUrlForComparison('https://example.test/search'),
        normalizeUrlForComparison('https://example.test/search?q=widgets')
      );
    });

    test('are normalized by parameter order', () => {
      assert.equal(
        normalizeUrlForComparison('https://example.test/search?b=2&a=1'),
        normalizeUrlForComparison('https://example.test/search?a=1&b=2')
      );
    });

    test('parameter VALUES are not case-folded (only the path is)', () => {
      assert.notEqual(
        normalizeUrlForComparison('https://example.test/search?q=Widgets'),
        normalizeUrlForComparison('https://example.test/search?q=widgets')
      );
    });
  });

  test('degrades to the trimmed input for an unparseable URL, rather than throwing', () => {
    assert.doesNotThrow(() => normalizeUrlForComparison('not a url'));
    assert.equal(normalizeUrlForComparison('  not a url  '), 'not a url');
  });
});

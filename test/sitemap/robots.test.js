'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { parseRobotsTxtForSitemaps } = require('../../lib/sitemap/robots');
const { loadFixture } = require('./testHarness');

describe('parseRobotsTxtForSitemaps', () => {
  test('extracts a Sitemap: directive', () => {
    const urls = parseRobotsTxtForSitemaps(loadFixture('robots.txt'), 'https://example.test/');
    assert.deepEqual(urls, ['https://example.test/sitemap_index.xml']);
  });

  test('returns an empty array when there is no Sitemap: line', () => {
    const urls = parseRobotsTxtForSitemaps(loadFixture('robots-no-sitemap.txt'), 'https://example.test/');
    assert.deepEqual(urls, []);
  });

  test('extracts multiple Sitemap: directives, in order', () => {
    const text = ['Sitemap: https://example.test/sitemap1.xml', 'Sitemap: https://example.test/sitemap2.xml'].join('\n');
    const urls = parseRobotsTxtForSitemaps(text, 'https://example.test/');
    assert.deepEqual(urls, ['https://example.test/sitemap1.xml', 'https://example.test/sitemap2.xml']);
  });

  test('is case-insensitive on the directive name', () => {
    const urls = parseRobotsTxtForSitemaps('SITEMAP: https://example.test/s.xml', 'https://example.test/');
    assert.deepEqual(urls, ['https://example.test/s.xml']);
  });

  test('resolves a relative sitemap value against baseUrl', () => {
    const urls = parseRobotsTxtForSitemaps('Sitemap: /sitemap.xml', 'https://example.test/');
    assert.deepEqual(urls, ['https://example.test/sitemap.xml']);
  });

  test('strips trailing comments', () => {
    const urls = parseRobotsTxtForSitemaps('Sitemap: https://example.test/s.xml # comment', 'https://example.test/');
    assert.deepEqual(urls, ['https://example.test/s.xml']);
  });

  test('skips an unparseable sitemap value rather than throwing', () => {
    const text = ['Sitemap: http://[not-a-valid-host', 'Sitemap: https://example.test/good.xml'].join('\n');
    assert.doesNotThrow(() => parseRobotsTxtForSitemaps(text, 'https://example.test/'));
    const urls = parseRobotsTxtForSitemaps(text, 'https://example.test/');
    assert.deepEqual(urls, ['https://example.test/good.xml']);
  });

  test('handles an empty body', () => {
    assert.deepEqual(parseRobotsTxtForSitemaps('', 'https://example.test/'), []);
  });
});

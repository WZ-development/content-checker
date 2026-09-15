'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { discoverSitemapRoots } = require('../../lib/sitemap/discovery');
const { createGuardedFetch } = require('../../lib/sitemap/httpClient');
const { SitemapDiscoveryFailedError } = require('../../lib/sitemap/errors');
const { createFakeFetch, createFakeDnsLookup, loadFixture } = require('./testHarness');

const DNS = createFakeDnsLookup({ 'example.test': '93.184.216.34' });

function buildGuardedFetch(routes) {
  const fetchImpl = createFakeFetch(routes);
  const guardedFetch = createGuardedFetch({
    fetchImpl,
    dnsLookup: DNS,
    timeoutMs: 1000,
    userAgent: 'TestBot/1.0',
    maxRedirects: 5,
  });
  return { guardedFetch, log: fetchImpl.log };
}

describe('discoverSitemapRoots', () => {
  test('tries robots.txt first, then only falls back to candidates when it has nothing usable — asserting on request sequence', async () => {
    const { guardedFetch, log } = buildGuardedFetch({
      'https://example.test/robots.txt': { body: loadFixture('robots-no-sitemap.txt') },
      'https://example.test/sitemap_index.xml': { status: 404 },
      'https://example.test/wp-sitemap.xml': { body: loadFixture('sitemap-index-basic.xml') },
    });

    const result = await discoverSitemapRoots('https://example.test/', { guardedFetch });

    assert.equal(result.method, 'candidate');
    assert.equal(result.roots[0].url, 'https://example.test/wp-sitemap.xml');
    assert.deepEqual(
      log.map((entry) => entry.url),
      [
        'https://example.test/robots.txt',
        'https://example.test/sitemap_index.xml',
        'https://example.test/wp-sitemap.xml',
      ]
    );
  });

  test('uses the robots.txt-declared sitemap directly when it validates, without trying any candidate path', async () => {
    const { guardedFetch, log } = buildGuardedFetch({
      'https://example.test/robots.txt': { body: loadFixture('robots.txt') },
      'https://example.test/sitemap_index.xml': { body: loadFixture('sitemap-index-basic.xml') },
    });

    const result = await discoverSitemapRoots('https://example.test/', { guardedFetch });

    assert.equal(result.method, 'robots.txt');
    assert.equal(result.roots[0].url, 'https://example.test/sitemap_index.xml');
    assert.deepEqual(
      log.map((entry) => entry.url),
      ['https://example.test/robots.txt', 'https://example.test/sitemap_index.xml']
    );
  });

  test('falls through to candidates when every robots.txt-declared sitemap fails to validate', async () => {
    const { guardedFetch } = buildGuardedFetch({
      'https://example.test/robots.txt': { body: loadFixture('robots.txt') },
      'https://example.test/sitemap_index.xml': { status: 404 }, // the one robots.txt declared, broken
      'https://example.test/wp-sitemap.xml': { status: 404 },
      'https://example.test/sitemap.xml': { body: loadFixture('sitemap-index-basic.xml') },
    });

    const result = await discoverSitemapRoots('https://example.test/', { guardedFetch });
    assert.equal(result.method, 'candidate');
    assert.equal(result.roots[0].url, 'https://example.test/sitemap.xml');
  });

  test('reports discovery failure with a full attempt log when nothing works', async () => {
    const { guardedFetch } = buildGuardedFetch({
      'https://example.test/robots.txt': { status: 404 },
      'https://example.test/sitemap_index.xml': { status: 404 },
      'https://example.test/wp-sitemap.xml': { status: 404 },
      'https://example.test/sitemap.xml': { status: 404 },
    });

    await assert.rejects(
      () => discoverSitemapRoots('https://example.test/', { guardedFetch }),
      (err) => {
        assert.ok(err instanceof SitemapDiscoveryFailedError);
        assert.equal(err.code, 'DISCOVERY_FAILED');
        assert.equal(err.attempts.length, 4);
        assert.ok(err.attempts.every((a) => a.ok === false));
        return true;
      }
    );
  });

  test('surfaces a 401 in the attempt log so the caller can prompt for credentials specifically', async () => {
    const { guardedFetch } = buildGuardedFetch({
      'https://example.test/robots.txt': { status: 404 },
      'https://example.test/sitemap_index.xml': { status: 401 },
      'https://example.test/wp-sitemap.xml': { status: 404 },
      'https://example.test/sitemap.xml': { status: 404 },
    });

    await assert.rejects(
      () => discoverSitemapRoots('https://example.test/', { guardedFetch }),
      (err) => {
        const indexAttempt = err.attempts.find((a) => a.url === 'https://example.test/sitemap_index.xml');
        assert.equal(indexAttempt.error, 'HTTP_401');
        return true;
      }
    );
  });
});

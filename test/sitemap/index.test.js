'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { discoverAndParseSitemap, errors } = require('../../lib/sitemap/index');
const { createFakeFetch, createFakeDnsLookup, loadFixture } = require('./testHarness');

const DNS = createFakeDnsLookup({ 'example.test': '93.184.216.34', 'evil.test': '127.0.0.1' });

function fixtureRoutes(names) {
  const routes = {};
  for (const name of names) {
    routes[`https://example.test/${name}`] = { body: loadFixture(name) };
  }
  return routes;
}

describe('discoverAndParseSitemap (end to end, fixtures only, no live network)', () => {
  test('discovers via robots.txt, crawls the index, and returns the full result shape', async () => {
    const routes = {
      'https://example.test/robots.txt': { body: loadFixture('robots.txt') },
      // robots.txt (fixture) declares /sitemap_index.xml specifically.
      'https://example.test/sitemap_index.xml': { body: loadFixture('sitemap-index-basic.xml') },
      ...fixtureRoutes(['page-sitemap.xml', 'post-sitemap.xml']),
    };
    const fetchImpl = createFakeFetch(routes);

    const result = await discoverAndParseSitemap({
      baseUrl: 'https://example.test/',
      fetchImpl,
      dnsLookup: DNS,
    });

    assert.equal(result.discovery.method, 'robots.txt');
    assert.equal(result.urls.length, 4);
    assert.ok(result.urls.some((u) => u.loc === 'https://example.test/about/'));
    assert.deepEqual(result.skipped, []);
    assert.deepEqual(result.ambiguous, []);
    assert.equal(result.truncated, false);
    assert.ok(Array.isArray(result.consulted));
  });

  test('a manual sitemap URL bypasses discovery entirely', async () => {
    const routes = fixtureRoutes(['page-sitemap.xml']);
    // No robots.txt or candidate routes configured at all — if discovery
    // ran, this would throw "no route configured".
    const fetchImpl = createFakeFetch(routes);

    const result = await discoverAndParseSitemap({
      manualSitemapUrl: 'https://example.test/page-sitemap.xml',
      fetchImpl,
      dnsLookup: DNS,
    });

    assert.equal(result.discovery.method, 'manual');
    assert.equal(result.urls.length, 2);
  });

  test('a failing manual sitemap URL propagates a typed error directly, with no fallback', async () => {
    const fetchImpl = createFakeFetch({ 'https://example.test/missing.xml': { status: 404 } });

    await assert.rejects(
      () =>
        discoverAndParseSitemap({
          manualSitemapUrl: 'https://example.test/missing.xml',
          fetchImpl,
          dnsLookup: DNS,
        }),
      (err) => {
        assert.ok(err instanceof errors.HttpNotFoundError);
        return true;
      }
    );
  });

  test('automatic discovery failure surfaces as SitemapDiscoveryFailedError in a form the UI can use for a manual-entry prompt', async () => {
    const fetchImpl = createFakeFetch({
      'https://example.test/robots.txt': { status: 404 },
      'https://example.test/sitemap_index.xml': { status: 404 },
      'https://example.test/wp-sitemap.xml': { status: 404 },
      'https://example.test/sitemap.xml': { status: 404 },
    });

    await assert.rejects(
      () => discoverAndParseSitemap({ baseUrl: 'https://example.test/', fetchImpl, dnsLookup: DNS }),
      (err) => {
        assert.ok(err instanceof errors.SitemapDiscoveryFailedError);
        assert.ok(Array.isArray(err.attempts) && err.attempts.length > 0);
        return true;
      }
    );
  });

  test('registers no Express routes and imports nothing from a route layer', () => {
    // Static guarantee, verified structurally: the module's own source
    // never requires express or any src/routes/* file. (A route-layer
    // import would show up here as a require() call.)
    const fs = require('node:fs');
    const path = require('node:path');
    const dir = path.join(__dirname, '..', '..', 'lib', 'sitemap');
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.js')) continue;
      const contents = fs.readFileSync(path.join(dir, file), 'utf8');
      assert.ok(!/require\(['"]express['"]\)/.test(contents), `${file} must not import express`);
      assert.ok(!/require\(['"].*routes/.test(contents), `${file} must not import a routes module`);
    }
  });

  test('rejects a request whose target resolves to a private address, end to end', async () => {
    const fetchImpl = createFakeFetch({ 'https://evil.test/sitemap.xml': { body: 'ignored' } });
    await assert.rejects(
      () =>
        discoverAndParseSitemap({
          manualSitemapUrl: 'https://evil.test/sitemap.xml',
          fetchImpl,
          dnsLookup: DNS,
        }),
      errors.SsrfBlockedError
    );
  });

  test('throws a TypeError when neither baseUrl nor manualSitemapUrl is given', async () => {
    await assert.rejects(() => discoverAndParseSitemap({}), TypeError);
  });

  describe('userinfo redaction (sprint 4 carry-forward fix I)', () => {
    test('a manualSitemapUrl containing userinfo never appears in the thrown error', async () => {
      const SECRET = 'sekrit-password';
      // Mirrors real fetch()'s own behavior for a URL with embedded
      // credentials (verified against Node 24's global fetch, which
      // throws before making any request): a TypeError whose message
      // embeds the credential URL — the actual leak path this fix
      // closes runs through exactly this message text, not just
      // through the `url` argument httpClient.js passes around.
      const fetchImpl = async (url) => {
        throw new TypeError(`Request cannot be constructed from a URL that includes credentials: ${url}`);
      };

      await assert.rejects(
        () =>
          discoverAndParseSitemap({
            manualSitemapUrl: `https://user:${SECRET}@example.test/sitemap.xml`,
            fetchImpl,
            dnsLookup: DNS,
          }),
        (err) => {
          assert.ok(!err.message.includes(SECRET), `error.message leaked the credential: ${err.message}`);
          assert.ok(!String(err.url).includes(SECRET), `error.url leaked the credential: ${err.url}`);
          assert.ok(
            !(err.cause && String(err.cause.message).includes(SECRET)),
            `error.cause leaked the credential: ${err.cause && err.cause.message}`
          );
          return true;
        }
      );
    });

    test('a baseUrl containing userinfo never appears in the discovery attempts log', async () => {
      const SECRET = 'sekrit-password';
      const fetchImpl = createFakeFetch({}); // no routes configured — every discovery attempt fails

      await assert.rejects(
        () =>
          discoverAndParseSitemap({
            baseUrl: `https://user:${SECRET}@example.test/`,
            fetchImpl,
            dnsLookup: DNS,
          }),
        (err) => {
          assert.ok(err instanceof errors.SitemapDiscoveryFailedError);
          assert.ok(err.attempts.length > 0, 'expected at least one recorded attempt');
          for (const attempt of err.attempts) {
            assert.ok(!attempt.url.includes(SECRET), `attempts log leaked the credential: ${attempt.url}`);
          }
          return true;
        }
      );
    });
  });

  test('end to end: a flat index that would blow a short budget still returns truncated:true with partial, fully-recorded results (QA1 round 1, finding A)', async () => {
    const childNames = ['sitemap-page-1', 'sitemap-page-2', 'sitemap-page-3', 'sitemap-page-4', 'sitemap-page-5', 'sitemap-page-6'];
    const routes = {};
    for (const name of childNames) {
      routes[`https://example.test/${name}.xml`] = { body: loadFixture(`${name}.xml`), delayMs: 25 };
    }
    const rootXml = `<?xml version="1.0"?><sitemapindex>${childNames
      .map((n) => `<sitemap><loc>https://example.test/${n}.xml</loc></sitemap>`)
      .join('')}</sitemapindex>`;
    routes['https://example.test/sitemap.xml'] = { body: rootXml };

    const fetchImpl = createFakeFetch(routes);
    const result = await discoverAndParseSitemap({
      manualSitemapUrl: 'https://example.test/sitemap.xml',
      fetchImpl,
      dnsLookup: DNS,
      budgetMs: 40,
      concurrency: 1,
    });

    assert.equal(result.truncated, true, 'a 40ms budget against 6x25ms sequential children must trip');
    assert.ok(result.urls.length < 12, `expected fewer than 12 URLs, got ${result.urls.length}`);
    assert.ok(
      result.skipped.some((s) => s.reason === 'truncated:budget'),
      'every child cut off by the budget must be recorded in skipped'
    );
  });
});

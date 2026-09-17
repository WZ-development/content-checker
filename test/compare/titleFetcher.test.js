'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { resolveTitles, TITLE_FETCH_DEFAULTS } = require('../../lib/compare/titleFetcher');
const { createFakeFetch, createFakeDnsLookup } = require('../sitemap/testHarness');

const DNS = createFakeDnsLookup({ 'live.test': '93.184.216.34', 'staging.test': '93.184.216.35' });

function htmlRoute(title) {
  return { body: `<title>${title}</title>`, headers: { 'content-type': 'text/html; charset=utf-8' } };
}

describe('requirement 12 — reuses Sprint 3\'s HTTP layer, builds no second one', () => {
  test('constructs no HTTP client of its own: no fetch/http/https/net require anywhere in lib/compare/', () => {
    const dir = path.join(__dirname, '..', '..', 'lib', 'compare');
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.js')) continue;
      const contents = fs.readFileSync(path.join(dir, file), 'utf8');
      assert.ok(
        !/require\(['"]node:(http|https|net)['"]\)/.test(contents),
        `${file} must not import a raw HTTP module`
      );
    }
  });

  test('imports nothing from the store (src/db) or the decrypt helper (src/lib/crypto)', () => {
    const dir = path.join(__dirname, '..', '..', 'lib', 'compare');
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.js')) continue;
      const contents = fs.readFileSync(path.join(dir, file), 'utf8');
      assert.ok(!/require\(.*src\/db/.test(contents), `${file} must not import the project store`);
      assert.ok(!/require\(.*src\/lib\/crypto/.test(contents), `${file} must not import the decrypt helper`);
    }
  });

  test('takes an injected fetch implementation exactly as Sprint 3\'s crawler does', async () => {
    const fetchImpl = createFakeFetch({ 'https://live.test/a/': htmlRoute('A') });
    const [result] = await resolveTitles([{ url: 'https://live.test/a/', side: 'live' }], {
      fetchImpl,
      dnsLookup: DNS,
    });
    assert.equal(result.title, 'A');
  });

  test('takes credentials as a plaintext {username, password} object supplied by the caller', async () => {
    const fetchImpl = createFakeFetch({ 'https://staging.test/a/': htmlRoute('A') });
    await resolveTitles([{ url: 'https://staging.test/a/', side: 'staging' }], {
      fetchImpl,
      dnsLookup: DNS,
      auth: { username: 'dev', password: 'hunter2' },
      authOrigins: new Set(['https://staging.test']),
    });
    const expected = `Basic ${Buffer.from('dev:hunter2').toString('base64')}`;
    assert.equal(fetchImpl.log[0].headers.Authorization, expected);
  });
});

describe('requirement 7 — Basic Auth respected for staging-side URLs only', () => {
  test('a "staging" item receives the Authorization header', async () => {
    const fetchImpl = createFakeFetch({ 'https://staging.test/a/': htmlRoute('A') });
    await resolveTitles([{ url: 'https://staging.test/a/', side: 'staging' }], {
      fetchImpl,
      dnsLookup: DNS,
      auth: { username: 'dev', password: 'pw' },
      authOrigins: new Set(['https://staging.test']),
    });
    assert.ok(fetchImpl.log[0].headers.Authorization);
  });

  test('a "live" item does NOT receive the Authorization header, even when auth is supplied', async () => {
    const fetchImpl = createFakeFetch({ 'https://live.test/a/': htmlRoute('A') });
    await resolveTitles([{ url: 'https://live.test/a/', side: 'live' }], {
      fetchImpl,
      dnsLookup: DNS,
      auth: { username: 'dev', password: 'pw' },
      authOrigins: new Set(['https://staging.test']),
    });
    assert.equal(fetchImpl.log[0].headers.Authorization, undefined);
  });
});

describe('Sprint 7 fix-loop, QA1 round 1 finding B — a staging item on a THIRD-PARTY host never gets the credential', () => {
  test('a "staging" item whose URL is on a host outside authOrigins does not receive Authorization', async () => {
    // Exactly QA1's demonstrated exploit: a staging sitemap can list a
    // <loc> on any host it likes. Before this fix, resolveTitles's own
    // per-item guardedFetch call trusted that URL's own origin, so the
    // credential went straight to the attacker-named host.
    const dnsWithAttacker = createFakeDnsLookup({
      'live.test': '93.184.216.34',
      'staging.test': '93.184.216.35',
      'attacker.example': '93.184.216.36',
    });
    const fetchImpl = createFakeFetch({ 'https://attacker.example/harvest/': htmlRoute('Harvested') });
    await resolveTitles([{ url: 'https://attacker.example/harvest/', side: 'staging' }], {
      fetchImpl,
      dnsLookup: dnsWithAttacker,
      auth: { username: 'dev', password: 'pw' },
      authOrigins: new Set(['https://staging.test']),
    });
    assert.equal(fetchImpl.log[0].headers.Authorization, undefined);
  });
});

describe('requirement 7 — concurrency limit (default 5)', () => {
  test('never runs more than the configured concurrency at once', async () => {
    const routes = {};
    for (let i = 0; i < 12; i += 1) {
      routes[`https://live.test/p${i}/`] = { ...htmlRoute(`P${i}`), delayMs: 15 };
    }
    const fetchImpl = createFakeFetch(routes);
    let active = 0;
    let maxActive = 0;
    const trackingFetch = async (...args) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        return await fetchImpl(...args);
      } finally {
        active -= 1;
      }
    };

    const items = Array.from({ length: 12 }, (_, i) => ({ url: `https://live.test/p${i}/`, side: 'live' }));
    await resolveTitles(items, { fetchImpl: trackingFetch, dnsLookup: DNS, concurrency: 3 });

    assert.ok(maxActive <= 3, `expected at most 3 concurrent fetches, saw ${maxActive}`);
  });

  test('the default concurrency is 5', () => {
    assert.equal(TITLE_FETCH_DEFAULTS.concurrency, 5);
  });
});

describe('requirement 7 — per-request timeout (default 10s)', () => {
  test('a request exceeding the timeout falls back to a slug title, not an unhandled rejection', async () => {
    const fetchImpl = createFakeFetch({ 'https://live.test/slow/': { ...htmlRoute('Slow'), delayMs: 200 } });
    const [result] = await resolveTitles([{ url: 'https://live.test/slow/', side: 'live' }], {
      fetchImpl,
      dnsLookup: DNS,
      timeoutMs: 20,
    });
    assert.equal(result.titleSource, 'slug');
    assert.equal(result.title, 'Slow');
  });

  test('the default timeout is 10000ms', () => {
    assert.equal(TITLE_FETCH_DEFAULTS.timeoutMs, 10000);
  });
});

describe('requirement 8 — slug fallback, and the item is never dropped', () => {
  test('a fetch failure falls back to slug', async () => {
    const fetchImpl = createFakeFetch({ 'https://live.test/missing/': { status: 404 } });
    const [result] = await resolveTitles([{ url: 'https://live.test/missing/', side: 'live' }], {
      fetchImpl,
      dnsLookup: DNS,
    });
    assert.equal(result.titleSource, 'slug');
    assert.equal(result.title, 'Missing');
    assert.equal(result.url, 'https://live.test/missing/', 'the item itself must still be present');
  });

  test('a non-HTML response falls back to slug', async () => {
    const fetchImpl = createFakeFetch({
      'https://live.test/data.json': { body: '{"ok":true}', headers: { 'content-type': 'application/json' } },
    });
    const [result] = await resolveTitles([{ url: 'https://live.test/data.json', side: 'live' }], {
      fetchImpl,
      dnsLookup: DNS,
    });
    assert.equal(result.titleSource, 'slug');
    assert.equal(result.title, 'Data.json');
  });

  test('HTML with no <title> tag falls back to slug rather than an empty title', async () => {
    const fetchImpl = createFakeFetch({
      'https://live.test/no-title/': { body: '<html><body>hi</body></html>', headers: { 'content-type': 'text/html' } },
    });
    const [result] = await resolveTitles([{ url: 'https://live.test/no-title/', side: 'live' }], {
      fetchImpl,
      dnsLookup: DNS,
    });
    assert.equal(result.titleSource, 'slug');
  });

  test('an item beyond the overall cap falls back to slug WITHOUT any fetch attempt', async () => {
    const fetchImpl = createFakeFetch({
      'https://live.test/a/': htmlRoute('A'),
      'https://live.test/b/': htmlRoute('B'),
    });
    const items = [
      { url: 'https://live.test/a/', side: 'live' },
      { url: 'https://live.test/b/', side: 'live' },
    ];
    const results = await resolveTitles(items, { fetchImpl, dnsLookup: DNS, maxItems: 1 });

    assert.equal(results[0].titleSource, 'fetched');
    assert.equal(results[1].titleSource, 'slug');
    assert.equal(results[1].title, 'B');
    assert.ok(
      !fetchImpl.log.some((entry) => entry.url === 'https://live.test/b/'),
      'the capped item must never have been fetched at all'
    );
  });

  test('the default cap is 100 items', () => {
    assert.equal(TITLE_FETCH_DEFAULTS.maxItems, 100);
  });
});

describe('requirement 9 — each item records whether its title was fetched or derived', () => {
  test('a successful fetch is titleSource: "fetched"', async () => {
    const fetchImpl = createFakeFetch({ 'https://live.test/a/': htmlRoute('Real Title') });
    const [result] = await resolveTitles([{ url: 'https://live.test/a/', side: 'live' }], {
      fetchImpl,
      dnsLookup: DNS,
    });
    assert.equal(result.titleSource, 'fetched');
    assert.equal(result.title, 'Real Title');
  });
});

describe('title-suffix stripping is applied to fetched titles', () => {
  test('a fetched title with a site-name suffix is stripped before being returned', async () => {
    const fetchImpl = createFakeFetch({ 'https://live.test/a/': htmlRoute('Page Title - Acme Inc') });
    const [result] = await resolveTitles([{ url: 'https://live.test/a/', side: 'live' }], {
      fetchImpl,
      dnsLookup: DNS,
    });
    assert.equal(result.title, 'Page Title');
  });
});

describe('other item fields are preserved through resolution', () => {
  test('key, sourceType, lastmod and side all survive untouched', async () => {
    const fetchImpl = createFakeFetch({ 'https://live.test/a/': htmlRoute('A') });
    const [result] = await resolveTitles(
      [{ key: '/a', url: 'https://live.test/a/', sourceType: 'page', lastmod: '2026-01-01', side: 'live' }],
      { fetchImpl, dnsLookup: DNS }
    );
    assert.equal(result.key, '/a');
    assert.equal(result.sourceType, 'page');
    assert.equal(result.lastmod, '2026-01-01');
    assert.equal(result.side, 'live');
  });
});

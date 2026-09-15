'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { compareAndResolveTitles } = require('../../lib/compare/index');
const { createFakeFetch, createFakeDnsLookup } = require('../sitemap/testHarness');

const DNS = createFakeDnsLookup({ 'live.test': '93.184.216.34', 'staging.test': '93.184.216.35' });

function sitemapResult(urls, overrides = {}) {
  return { urls, truncated: false, ambiguous: [], skipped: [], consulted: [], ...overrides };
}

function htmlRoute(title) {
  return { body: `<title>${title}</title>`, headers: { 'content-type': 'text/html' } };
}

describe('titles are fetched ONLY for differing items — the performance requirement (requirement 6, acceptance criterion)', () => {
  test('a large on-both set produces zero outbound requests for those URLs; only the 2 differing items are fetched', async () => {
    const sharedUrls = Array.from({ length: 200 }, (_, i) => `shared-${i}/`);
    const live = sitemapResult([
      ...sharedUrls.map((slug) => ({ loc: `https://live.test/${slug}` })),
      { loc: 'https://live.test/only-on-live/' },
    ]);
    const staging = sitemapResult([
      ...sharedUrls.map((slug) => ({ loc: `https://staging.test/${slug}` })),
      { loc: 'https://staging.test/only-on-staging/' },
    ]);

    const routes = {
      'https://live.test/only-on-live/': htmlRoute('Only Live'),
      'https://staging.test/only-on-staging/': htmlRoute('Only Staging'),
    };
    const fetchImpl = createFakeFetch(routes);

    const result = await compareAndResolveTitles({
      live,
      staging,
      titleOptions: { fetchImpl, dnsLookup: DNS },
    });

    assert.equal(result.onBothCount, 200);
    assert.equal(fetchImpl.log.length, 2, `expected exactly 2 outbound requests, got ${fetchImpl.log.length}`);
    assert.ok(
      fetchImpl.log.every((entry) => entry.url.includes('only-on-')),
      'no request was made for any of the 200 shared URLs'
    );
  });
});

describe('end-to-end orchestration', () => {
  test('compares, resolves titles, and returns a fully-titled result', async () => {
    const live = sitemapResult([
      { loc: 'https://live.test/a/', sourceType: 'page' },
      { loc: 'https://live.test/shared/' },
    ]);
    const staging = sitemapResult([
      { loc: 'https://staging.test/shared/' },
      { loc: 'https://staging.test/d/', sourceType: 'post' },
    ]);
    const fetchImpl = createFakeFetch({
      'https://live.test/a/': htmlRoute('Page A'),
      'https://staging.test/d/': htmlRoute('Page D'),
    });

    const result = await compareAndResolveTitles({
      live,
      staging,
      auth: { username: 'dev', password: 'hunter2' },
      titleOptions: { fetchImpl, dnsLookup: DNS },
    });

    assert.equal(result.onLiveOnly.length, 1);
    assert.equal(result.onLiveOnly[0].title, 'Page A');
    assert.equal(result.onLiveOnly[0].titleSource, 'fetched');
    assert.equal(result.onLiveOnly[0].sourceType, 'page');

    assert.equal(result.onStagingOnly.length, 1);
    assert.equal(result.onStagingOnly[0].title, 'Page D');
    assert.equal(result.onStagingOnly[0].sourceType, 'post');

    assert.equal(result.onBothCount, 1);
  });

  test('auth is only sent for the staging-side fetch, never the live-side one, in the combined flow', async () => {
    const live = sitemapResult([{ loc: 'https://live.test/only-live/' }]);
    const staging = sitemapResult([{ loc: 'https://staging.test/only-staging/' }]);
    const fetchImpl = createFakeFetch({
      'https://live.test/only-live/': htmlRoute('Live'),
      'https://staging.test/only-staging/': htmlRoute('Staging'),
    });

    await compareAndResolveTitles({
      live,
      staging,
      auth: { username: 'dev', password: 'pw' },
      titleOptions: { fetchImpl, dnsLookup: DNS },
    });

    const liveRequest = fetchImpl.log.find((entry) => entry.url.includes('live.test'));
    const stagingRequest = fetchImpl.log.find((entry) => entry.url.includes('staging.test'));
    assert.equal(liveRequest.headers.Authorization, undefined);
    assert.ok(stagingRequest.headers.Authorization);
  });

  test('a truncated live crawl is reflected in the final comparison output, not silently dropped', async () => {
    const live = sitemapResult([{ loc: 'https://live.test/a/' }], { truncated: true });
    const staging = sitemapResult([{ loc: 'https://staging.test/a/' }]);
    const fetchImpl = createFakeFetch({});

    const result = await compareAndResolveTitles({ live, staging, titleOptions: { fetchImpl, dnsLookup: DNS } });
    assert.equal(result.truncated, true);
  });
});

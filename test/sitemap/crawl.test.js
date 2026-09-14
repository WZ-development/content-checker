'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { crawlSitemapTree } = require('../../lib/sitemap/crawl');
const { parseSitemapXml } = require('../../lib/sitemap/xml');
const { createGuardedFetch } = require('../../lib/sitemap/httpClient');
const { createLimiter } = require('../../lib/sitemap/concurrencyLimit');
const { createFakeFetch, createFakeDnsLookup, loadFixture } = require('./testHarness');

const DNS = createFakeDnsLookup({ 'example.test': '93.184.216.34' });

function buildCtx(routes, overrides = {}) {
  const fetchImpl = createFakeFetch(routes);
  const guardedFetch = createGuardedFetch({
    fetchImpl,
    dnsLookup: DNS,
    timeoutMs: overrides.timeoutMs || 1000,
    auth: overrides.auth,
    userAgent: 'TestBot/1.0',
    maxRedirects: 5,
  });
  return {
    ctx: {
      guardedFetch,
      limit: createLimiter(overrides.concurrency || 5),
      budgetMs: overrides.budgetMs ?? 90000,
      maxChildren: overrides.maxChildren ?? 50,
      maxSafetyDepth: overrides.maxSafetyDepth ?? 20,
      startedAt: Date.now(),
      fetchedCount: 0,
      truncated: false,
      visited: new Set(),
      consulted: [],
      skipped: [],
      ambiguous: [],
      urls: new Map(),
    },
    log: fetchImpl.log,
  };
}

function fixtureRoutes(names) {
  const routes = {};
  for (const name of names) {
    routes[`https://example.test/${name}`] = { body: loadFixture(name) };
  }
  return routes;
}

async function runFromRoot(rootFixtureName, routeFixtureNames, ctxOverrides) {
  const routes = fixtureRoutes(routeFixtureNames);
  const { ctx, log } = buildCtx(routes, ctxOverrides);
  const rootUrl = `https://example.test/${rootFixtureName}`;
  const parsedDoc = parseSitemapXml(loadFixture(rootFixtureName));
  await crawlSitemapTree([{ url: rootUrl, parsedDoc }], ctx);
  return { ctx, log };
}

describe('crawlSitemapTree', () => {
  test('resolves a basic index into its two child urlsets', async () => {
    const { ctx } = await runFromRoot('sitemap-index-basic.xml', ['page-sitemap.xml', 'post-sitemap.xml']);
    assert.equal(ctx.urls.size, 4);
    assert.deepEqual(ctx.consulted.sort(), [
      'https://example.test/page-sitemap.xml',
      'https://example.test/post-sitemap.xml',
      'https://example.test/sitemap-index-basic.xml',
    ]);
    assert.equal(ctx.truncated, false);
  });

  test('resolves a depth-3+ nested index chain fully', async () => {
    const { ctx } = await runFromRoot('nested-index-root.xml', [
      'nested-index-mid.xml',
      'nested-index-leaf.xml',
      'nested-post-sitemap.xml',
    ]);
    assert.equal(ctx.urls.size, 1);
    assert.ok(ctx.urls.has('https://example.test/deep/article/'));
    assert.equal(ctx.consulted.length, 4); // root + mid + leaf + urlset
  });

  test('terminates on a cyclic reference rather than hanging, and still collects the real content', async () => {
    const { ctx } = await runFromRoot('cyclic-index-a.xml', [
      'cyclic-index-b.xml',
      'cyclic-post-sitemap.xml',
      'cyclic-page-sitemap.xml',
    ]);
    // If cycle detection failed this test would simply never resolve.
    assert.equal(ctx.urls.size, 2);
    assert.ok(ctx.urls.has('https://example.test/cyclic/post-1/'));
    assert.ok(ctx.urls.has('https://example.test/cyclic/page-1/'));
    // Each sitemap in the cycle is visited exactly once.
    assert.equal(ctx.consulted.filter((u) => u.includes('cyclic-index-a')).length, 1);
    assert.equal(ctx.consulted.filter((u) => u.includes('cyclic-index-b')).length, 1);
  });

  test('a self-referencing sitemap terminates immediately', async () => {
    const routes = { 'https://example.test/self.xml': { body: '' } }; // never actually fetched again
    const { ctx } = buildCtx(routes);
    const selfXml = `<?xml version="1.0"?><sitemapindex><sitemap><loc>https://example.test/self.xml</loc></sitemap></sitemapindex>`;
    const parsedDoc = parseSitemapXml(selfXml);
    await crawlSitemapTree([{ url: 'https://example.test/self.xml', parsedDoc }], ctx);
    assert.equal(ctx.consulted.length, 1); // the pre-parsed root only; the self-reference is never re-visited
  });

  test('collects URLs from BOTH pages of a Yoast-style paginated set, and excludes/flags the rest correctly', async () => {
    const { ctx } = await runFromRoot('yoast-index.xml', [
      'page-sitemap.xml',
      'post-sitemap.xml',
      'post-sitemap2.xml',
      'gallery-sitemap.xml',
      // product-/category-/author-/tag-/media- sitemaps are excluded by
      // classification and never fetched, so no fixture needed for them.
    ]);

    // 2 (page) + 2 (post) + 2 (post2) + 1 (gallery, ambiguous-but-included) = 7
    assert.equal(ctx.urls.size, 7);
    assert.ok(ctx.urls.has('https://example.test/blog/page-2-post-a/'), 'must include post-sitemap2 URLs');
    assert.ok(ctx.urls.has('https://example.test/gallery/summer-2026/'), 'ambiguous child must still be included');

    const excludedReasons = ctx.skipped.filter((s) => s.reason === 'excluded-content-type').map((s) => s.url);
    assert.equal(excludedReasons.length, 5); // product, category, author, tag, media
    assert.ok(excludedReasons.some((u) => u.includes('product-sitemap')));
    assert.ok(excludedReasons.some((u) => u.includes('category-sitemap')));
    assert.ok(excludedReasons.some((u) => u.includes('author-sitemap')));
    assert.ok(excludedReasons.some((u) => u.includes('tag-sitemap')));
    assert.ok(excludedReasons.some((u) => u.includes('media-sitemap')));

    assert.equal(ctx.ambiguous.length, 1);
    assert.ok(ctx.ambiguous[0].url.includes('gallery-sitemap'));
  });

  test('collects URLs from EVERY sitemap-page-N child, not just the first few (TechCrunch-style, silent-data-loss case)', async () => {
    const { ctx } = await runFromRoot('techcrunch-style-index.xml', [
      'sitemap-page-1.xml',
      'sitemap-page-2.xml',
      'sitemap-page-3.xml',
      'sitemap-page-4.xml',
      'sitemap-page-5.xml',
      'sitemap-page-6.xml',
    ]);
    assert.equal(ctx.urls.size, 12); // 6 children x 2 URLs each
    assert.equal(ctx.truncated, false);
  });

  test('sets truncated:true and stops fetching once the child cap is hit, rather than throwing or silently returning a short list', async () => {
    const { ctx } = await runFromRoot(
      'techcrunch-style-index.xml',
      ['sitemap-page-1.xml', 'sitemap-page-2.xml', 'sitemap-page-3.xml', 'sitemap-page-4.xml', 'sitemap-page-5.xml', 'sitemap-page-6.xml'],
      { maxChildren: 4 } // root + 3 children before the cap trips
    );
    assert.equal(ctx.truncated, true);
    assert.ok(ctx.urls.size < 12, 'should not have collected every URL');
    assert.ok(ctx.urls.size > 0, 'should still return whatever it gathered');
  });

  test('sets truncated:true when the overall time budget is exceeded', async () => {
    // Budget must be checked mid-crawl, not just once up front — use a
    // SEQUENTIAL chain (each level only starts once the previous fetch
    // resolves) so elapsed time actually accrues between checks, unlike
    // sibling children which are all budget-checked near-simultaneously.
    const routes = fixtureRoutes(['nested-index-mid.xml', 'nested-index-leaf.xml', 'nested-post-sitemap.xml']);
    routes['https://example.test/nested-index-mid.xml'].delayMs = 20;
    routes['https://example.test/nested-index-leaf.xml'].delayMs = 20;
    const { ctx, log } = buildCtx(routes, { budgetMs: 25 });
    const parsedDoc = parseSitemapXml(loadFixture('nested-index-root.xml'));
    await crawlSitemapTree([{ url: 'https://example.test/nested-index-root.xml', parsedDoc }], ctx);

    assert.equal(ctx.truncated, true);
    // The budget should have tripped before the final urlset was ever
    // fetched — proving this is an honest early stop, not a fluke.
    assert.ok(!log.some((entry) => entry.url.includes('nested-post-sitemap')));
  });

  test('a child that fails to fetch (e.g. 404) is recorded in skipped and does not abort the rest of the crawl', async () => {
    const routes = fixtureRoutes(['page-sitemap.xml']);
    routes['https://example.test/post-sitemap.xml'] = { status: 404 };
    const { ctx } = buildCtx(routes);
    const parsedDoc = parseSitemapXml(loadFixture('sitemap-index-basic.xml'));
    await crawlSitemapTree([{ url: 'https://example.test/sitemap-index-basic.xml', parsedDoc }], ctx);

    assert.equal(ctx.urls.size, 2); // only page-sitemap's URLs
    const failed = ctx.skipped.find((s) => s.url.includes('post-sitemap'));
    assert.ok(failed);
    assert.ok(failed.reason.startsWith('fetch-failed:'));
    assert.ok(failed.reason.includes('HTTP_404'));
  });

  test('a child with malformed XML is recorded in skipped and does not abort the rest of the crawl', async () => {
    const routes = fixtureRoutes(['page-sitemap.xml', 'malformed.xml']);
    // Re-point post-sitemap.xml at the malformed fixture's content
    routes['https://example.test/post-sitemap.xml'] = { body: loadFixture('malformed.xml') };
    const { ctx } = buildCtx(routes);
    const parsedDoc = parseSitemapXml(loadFixture('sitemap-index-basic.xml'));
    await crawlSitemapTree([{ url: 'https://example.test/sitemap-index-basic.xml', parsedDoc }], ctx);

    assert.equal(ctx.urls.size, 2); // only page-sitemap's URLs
    const failed = ctx.skipped.find((s) => s.url.includes('post-sitemap'));
    assert.ok(failed);
    assert.ok(failed.reason.startsWith('parse-failed:'));
  });

  test('sends Authorization on child-sitemap requests, not only the root', async () => {
    const routes = fixtureRoutes(['page-sitemap.xml', 'post-sitemap.xml']);
    const { ctx, log } = buildCtx(routes, { auth: { username: 'dev', password: 'pw' } });
    const parsedDoc = parseSitemapXml(loadFixture('sitemap-index-basic.xml'));
    await crawlSitemapTree([{ url: 'https://example.test/sitemap-index-basic.xml', parsedDoc }], ctx);

    assert.equal(log.length, 2); // both children fetched (root was pre-parsed, no fetch)
    assert.ok(log.every((entry) => Boolean(entry.headers.Authorization)), 'every child request must carry auth');
  });
});

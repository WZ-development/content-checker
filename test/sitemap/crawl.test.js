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
  const startedAt = Date.now();
  const budgetMs = overrides.budgetMs ?? 90000;

  // Mirrors index.js: a budget-wide AbortSignal that guardedFetch
  // observes, so a fetch already admitted/queued is still cut off when
  // the budget expires mid-flight, not just checked at admission time.
  // .unref() so a test's default 90s budget timer never holds the test
  // runner process open after the suite itself has finished.
  const budgetController = new AbortController();
  const budgetTimer = setTimeout(() => budgetController.abort(), budgetMs);
  budgetTimer.unref();

  const guardedFetch = createGuardedFetch({
    fetchImpl,
    dnsLookup: DNS,
    timeoutMs: overrides.timeoutMs || 1000,
    auth: overrides.auth,
    authOrigins: overrides.authOrigins,
    userAgent: 'TestBot/1.0',
    maxRedirects: 5,
    budgetSignal: budgetController.signal,
  });
  return {
    ctx: {
      guardedFetch,
      limit: createLimiter(overrides.concurrency || 5),
      budgetMs,
      maxChildren: overrides.maxChildren ?? 50,
      maxSafetyDepth: overrides.maxSafetyDepth ?? 20,
      startedAt,
      fetchedCount: 0,
      truncated: false,
      visited: new Set(),
      consulted: [],
      skipped: [],
      ambiguous: [],
      ambiguousRecorded: new Set(),
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

  describe('sourceType tagging (sprint 4, requirement 5)', () => {
    test('tags entries from a page-sitemap.xml child as "page" and from post-sitemap.xml as "post"', async () => {
      const { ctx } = await runFromRoot('sitemap-index-basic.xml', ['page-sitemap.xml', 'post-sitemap.xml']);

      assert.equal(ctx.urls.get('https://example.test/about/').sourceType, 'page');
      assert.equal(ctx.urls.get('https://example.test/contact/').sourceType, 'page');
      assert.equal(ctx.urls.get('https://example.test/blog/first-post/').sourceType, 'post');
      assert.equal(ctx.urls.get('https://example.test/blog/second-post/').sourceType, 'post');
    });

    test('leaves sourceType undefined for a child whose filename names no recognizable content type', async () => {
      const rootXml = `<?xml version="1.0"?><sitemapindex>
        <sitemap><loc>https://example.test/gallery-sitemap.xml</loc></sitemap>
      </sitemapindex>`;
      const routes = { 'https://example.test/gallery-sitemap.xml': { body: loadFixture('gallery-sitemap.xml') } };
      const { ctx } = buildCtx(routes);
      const parsedDoc = parseSitemapXml(rootXml);
      await crawlSitemapTree([{ url: 'https://example.test/root.xml', parsedDoc }], ctx);

      assert.equal(ctx.urls.get('https://example.test/gallery/summer-2026/').sourceType, undefined);
    });

    test('a deeper level with no type of its own inherits its parent\'s sourceType', async () => {
      // wp-sitemap-posts.xml (classified 'post') -> a further nested
      // index whose OWN filename names nothing (numbered.xml) -> the
      // leaf urlset. The type must survive the untyped middle hop.
      const rootXml = `<?xml version="1.0"?><sitemapindex>
        <sitemap><loc>https://example.test/wp-sitemap-posts.xml</loc></sitemap>
      </sitemapindex>`;
      const routes = {
        'https://example.test/wp-sitemap-posts.xml': {
          body: `<?xml version="1.0"?><sitemapindex><sitemap><loc>https://example.test/numbered.xml</loc></sitemap></sitemapindex>`,
        },
        'https://example.test/numbered.xml': { body: loadFixture('post-sitemap.xml') },
      };
      const { ctx } = buildCtx(routes);
      const parsedDoc = parseSitemapXml(rootXml);
      await crawlSitemapTree([{ url: 'https://example.test/root.xml', parsedDoc }], ctx);

      assert.equal(ctx.urls.get('https://example.test/blog/first-post/').sourceType, 'post');
    });
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
      { maxChildren: 4 } // the pre-parsed root does not count — exactly 4 CHILDREN get fetched (finding B)
    );
    assert.equal(ctx.truncated, true);
    assert.equal(ctx.urls.size, 8, 'exactly 4 children x 2 URLs each — root never counted against the cap');
    const truncatedSkips = ctx.skipped.filter((s) => s.reason === 'truncated:cap');
    assert.equal(truncatedSkips.length, 2, 'the 2 children that never got a slot must be recorded, not silently dropped');
  });

  test('a cap of 1 fetches exactly one CHILD sitemap, not zero (QA1 round 1, finding B)', async () => {
    const { ctx } = await runFromRoot('sitemap-index-basic.xml', ['page-sitemap.xml', 'post-sitemap.xml'], {
      maxChildren: 1,
    });
    assert.equal(ctx.truncated, true);
    assert.equal(ctx.consulted.length, 2, 'the pre-parsed root + exactly one child'); // root + 1 child
    assert.equal(ctx.urls.size, 2, 'the one fetched child contributed its URLs');
    assert.equal(ctx.skipped.filter((s) => s.reason === 'truncated:cap').length, 1);
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

  test('sets truncated:true for a FLAT index too, not only a sequential chain (QA1 round 1, finding A)', async () => {
    // QA1's exact demonstration: a flat index's siblings are all admitted
    // in the same tick, so an admission-time-only budget check never
    // trips once they're queued — regardless of how long the queue
    // actually takes to drain under a low concurrency limit.
    const routes = {};
    const childNames = [];
    for (let i = 1; i <= 10; i += 1) {
      const name = `sitemap-page-${((i - 1) % 6) + 1}.xml`; // reuse the 6 existing fixtures, repeated
      childNames.push(`child${i}`);
      routes[`https://example.test/child${i}.xml`] = { body: loadFixture(name), delayMs: 30 };
    }
    const rootXml = `<?xml version="1.0"?><sitemapindex>${childNames
      .map((n) => `<sitemap><loc>https://example.test/${n}.xml</loc></sitemap>`)
      .join('')}</sitemapindex>`;

    const { ctx } = buildCtx(routes, { budgetMs: 50, concurrency: 1 });
    const parsedDoc = parseSitemapXml(rootXml);

    const start = Date.now();
    await crawlSitemapTree([{ url: 'https://example.test/root.xml', parsedDoc }], ctx);
    const elapsed = Date.now() - start;

    assert.equal(ctx.truncated, true, `budget (50ms) must trip well before all 10 x 30ms children finish (took ${elapsed}ms)`);
    assert.ok(ctx.consulted.length < 10, `expected fewer than 10 children consulted, got ${ctx.consulted.length}`);
    assert.ok(
      ctx.skipped.some((s) => s.reason === 'truncated:budget'),
      'children cut off by the budget must be recorded in skipped, not silently dropped'
    );
  });

  test('a child classified ambiguous is recorded in skipped, not ambiguous, when it is cut off by the cap before being fetched (QA1 round 1, finding C)', async () => {
    // gallery-sitemap.xml classifies as ambiguous. With a cap that lets
    // the FIRST child through but not the second, gallery-sitemap (2nd
    // in document order) must never be fetched, and must NOT appear in
    // `ambiguous` implying "included, check it" when it was not
    // included at all.
    const routes = fixtureRoutes(['page-sitemap.xml']); // gallery-sitemap.xml deliberately has no route — it must never be fetched
    const rootXml = `<?xml version="1.0"?><sitemapindex>
      <sitemap><loc>https://example.test/page-sitemap.xml</loc></sitemap>
      <sitemap><loc>https://example.test/gallery-sitemap.xml</loc></sitemap>
    </sitemapindex>`;
    const { ctx } = buildCtx(routes, { maxChildren: 1 });
    const parsedDoc = parseSitemapXml(rootXml);
    await crawlSitemapTree([{ url: 'https://example.test/root.xml', parsedDoc }], ctx);

    assert.equal(ctx.truncated, true);
    assert.deepEqual(ctx.ambiguous, [], 'gallery-sitemap.xml was never fetched — it must not appear in ambiguous');
    const truncatedGallery = ctx.skipped.find((s) => s.url.includes('gallery-sitemap'));
    assert.ok(truncatedGallery, 'the truncated child must still be recorded, in skipped');
    assert.equal(truncatedGallery.reason, 'truncated:cap');
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

  test('a child referenced by two different parents is recorded in ambiguous exactly once (sprint 4 carry-forward fix J)', async () => {
    // QA1's Sprint 3 audit: the ambiguous-recording check ran once per
    // PARENT that references a child, not once per child — the
    // visited-set only stops it being FETCHED twice, it does nothing to
    // the ambiguous push. Two index sitemaps (page-index-a, page-index-b
    // — named with 'page' so THEY classify as 'include' and don't
    // themselves confound this test) both reference the same
    // unrecognized gallery-sitemap.xml.
    const rootXml = `<?xml version="1.0"?><sitemapindex>
      <sitemap><loc>https://example.test/page-index-a.xml</loc></sitemap>
      <sitemap><loc>https://example.test/page-index-b.xml</loc></sitemap>
    </sitemapindex>`;
    const routes = {
      'https://example.test/page-index-a.xml': {
        body: `<?xml version="1.0"?><sitemapindex><sitemap><loc>https://example.test/gallery-sitemap.xml</loc></sitemap></sitemapindex>`,
      },
      'https://example.test/page-index-b.xml': {
        body: `<?xml version="1.0"?><sitemapindex><sitemap><loc>https://example.test/gallery-sitemap.xml</loc></sitemap></sitemapindex>`,
      },
      'https://example.test/gallery-sitemap.xml': { body: loadFixture('gallery-sitemap.xml') },
    };
    const { ctx } = buildCtx(routes);
    const parsedDoc = parseSitemapXml(rootXml);
    await crawlSitemapTree([{ url: 'https://example.test/root.xml', parsedDoc }], ctx);

    assert.equal(
      ctx.ambiguous.length,
      1,
      'gallery-sitemap.xml, referenced by two parents, must appear exactly once, not twice'
    );
    assert.ok(ctx.ambiguous[0].url.includes('gallery-sitemap'));
    assert.equal(
      ctx.consulted.filter((u) => u.includes('gallery-sitemap')).length,
      1,
      'and was genuinely only fetched once'
    );
  });

  test('sends Authorization on child-sitemap requests, not only the root', async () => {
    const routes = fixtureRoutes(['page-sitemap.xml', 'post-sitemap.xml']);
    const { ctx, log } = buildCtx(routes, {
      auth: { username: 'dev', password: 'pw' },
      authOrigins: new Set(['https://example.test']),
    });
    const parsedDoc = parseSitemapXml(loadFixture('sitemap-index-basic.xml'));
    await crawlSitemapTree([{ url: 'https://example.test/sitemap-index-basic.xml', parsedDoc }], ctx);

    assert.equal(log.length, 2); // both children fetched (root was pre-parsed, no fetch)
    assert.ok(log.every((entry) => Boolean(entry.headers.Authorization)), 'every child request must carry auth');
  });

  describe('rejects non-http(s) <loc> schemes at collection (QA1 Sprint 5 audit, finding A)', () => {
    test('javascript:, data:, and vbscript: locs never reach result.urls, and are recorded in skipped', async () => {
      const hostileXml = `<?xml version="1.0"?><urlset>
        <url><loc>javascript:alert(document.cookie)</loc></url>
        <url><loc>data:text/html,&lt;script&gt;alert(1)&lt;/script&gt;</loc></url>
        <url><loc>vbscript:msgbox("x")</loc></url>
        <url><loc>https://example.test/a-real-page/</loc></url>
      </urlset>`;
      const { ctx } = buildCtx({});
      const parsedDoc = parseSitemapXml(hostileXml);
      await crawlSitemapTree([{ url: 'https://example.test/urlset.xml', parsedDoc }], ctx);

      // The one legitimate entry made it through.
      assert.equal(ctx.urls.size, 1);
      assert.ok(ctx.urls.has('https://example.test/a-real-page/'));

      // None of the hostile schemes reached urls, under any key.
      for (const url of ctx.urls.keys()) {
        assert.doesNotMatch(url, /^(javascript|data|vbscript):/i);
      }

      // Each was recorded, not silently dropped — this module's
      // standing rule for every other kind of exclusion.
      const skippedSchemes = ctx.skipped.filter((s) => s.reason === 'invalid-url-scheme').map((s) => s.url);
      assert.equal(skippedSchemes.length, 3);
      assert.ok(skippedSchemes.some((u) => u.startsWith('javascript:')));
      assert.ok(skippedSchemes.some((u) => u.startsWith('data:')));
      assert.ok(skippedSchemes.some((u) => u.startsWith('vbscript:')));
    });

    test('a malformed (unparseable) loc is also rejected, not just an unwanted scheme', async () => {
      const xml = `<?xml version="1.0"?><urlset>
        <url><loc>not a url at all</loc></url>
        <url><loc>https://example.test/fine/</loc></url>
      </urlset>`;
      const { ctx } = buildCtx({});
      const parsedDoc = parseSitemapXml(xml);
      await crawlSitemapTree([{ url: 'https://example.test/urlset.xml', parsedDoc }], ctx);

      assert.equal(ctx.urls.size, 1);
      assert.ok(ctx.urls.has('https://example.test/fine/'));
      assert.ok(ctx.skipped.some((s) => s.url === 'not a url at all' && s.reason === 'invalid-url-scheme'));
    });
  });
});

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const request = require('supertest');

const { createApp } = require('../../src/app');
const { openDatabase } = require('../../src/db/database');
const { createProjectsRepository } = require('../../src/db/projectsRepository');
const { createFakeFetch, createFakeDnsLookup } = require('../sitemap/testHarness');

const TEST_PASSWORD = 'correct-horse-battery-staple';
const TEAM_PASSWORD_HASH = bcrypt.hashSync(TEST_PASSWORD, 4);
const TEST_ENCRYPTION_KEY = Buffer.from('ab'.repeat(32), 'hex');

const DNS = createFakeDnsLookup({
  'live.test': '93.184.216.34',
  'staging.test': '93.184.216.35',
});

function buildConfig(overrides = {}) {
  return {
    port: 0,
    sessionSecret: 'test-session-secret',
    teamPasswordHash: TEAM_PASSWORD_HASH,
    encryptionKey: TEST_ENCRYPTION_KEY,
    basePath: '',
    nodeEnv: 'test',
    ...overrides,
  };
}

function createTestApp({ routes = {}, dnsLookup = DNS, configOverrides = {} } = {}) {
  const repository = createProjectsRepository(openDatabase(':memory:'), TEST_ENCRYPTION_KEY);
  const fetchImpl = createFakeFetch(routes);
  const app = createApp(buildConfig(configOverrides), { repository, fetchImpl, dnsLookup });
  return { app, repository, fetchImpl };
}

async function loginAgent(app, basePath = '') {
  const agent = request.agent(app);
  await agent.post(`${basePath}/login`).type('form').send({ password: TEST_PASSWORD });
  return agent;
}

function extractCsrfToken(html) {
  const match = html.match(/name="_csrf" value="([^"]+)"/);
  assert.ok(match, 'expected a _csrf hidden field');
  return match[1];
}

async function createProject(agent, overrides = {}) {
  const csrfToken = extractCsrfToken((await agent.get('/projects/new')).text);
  await agent.post('/projects').type('form').send({
    _csrf: csrfToken,
    name: 'Test Co',
    liveUrl: 'https://live.test',
    stagingUrl: 'https://staging.test',
    ...overrides,
  });
  const listHtml = (await agent.get('/projects')).text;
  return listHtml.match(/projects\/([^/]+)\/edit/)[1];
}

function html(title) {
  return { body: `<title>${title}</title>`, headers: { 'content-type': 'text/html' } };
}
function notFound() {
  return { status: 404 };
}

const LIVE_INDEX_XML = `<?xml version="1.0"?><sitemapindex>
  <sitemap><loc>https://live.test/page-sitemap.xml</loc></sitemap>
  <sitemap><loc>https://live.test/post-sitemap.xml</loc></sitemap>
</sitemapindex>`;
const LIVE_PAGE_XML = `<?xml version="1.0"?><urlset>
  <url><loc>https://live.test/about/</loc></url>
  <url><loc>https://live.test/contact/</loc></url>
  <url><loc>https://live.test/old-page/</loc></url>
</urlset>`;
const LIVE_POST_XML = `<?xml version="1.0"?><urlset>
  <url><loc>https://live.test/blog/shared/</loc></url>
  <url><loc>https://live.test/blog/alpha/</loc></url>
</urlset>`;

const STAGING_INDEX_XML = `<?xml version="1.0"?><sitemapindex>
  <sitemap><loc>https://staging.test/page-sitemap.xml</loc></sitemap>
  <sitemap><loc>https://staging.test/post-sitemap.xml</loc></sitemap>
</sitemapindex>`;
const STAGING_PAGE_XML = `<?xml version="1.0"?><urlset>
  <url><loc>https://staging.test/about/</loc></url>
  <url><loc>https://staging.test/contact/</loc></url>
  <url><loc>https://staging.test/new-page/</loc></url>
</urlset>`;
const STAGING_POST_XML = `<?xml version="1.0"?><urlset>
  <url><loc>https://staging.test/blog/shared/</loc></url>
  <url><loc>https://staging.test/blog/beta/</loc></url>
</urlset>`;

function fullDiffRoutes() {
  return {
    'https://live.test/robots.txt': notFound(),
    'https://live.test/sitemap_index.xml': { body: LIVE_INDEX_XML },
    'https://live.test/page-sitemap.xml': { body: LIVE_PAGE_XML },
    'https://live.test/post-sitemap.xml': { body: LIVE_POST_XML },
    'https://staging.test/robots.txt': notFound(),
    'https://staging.test/sitemap_index.xml': { body: STAGING_INDEX_XML },
    'https://staging.test/page-sitemap.xml': { body: STAGING_PAGE_XML },
    'https://staging.test/post-sitemap.xml': { body: STAGING_POST_XML },
    // Title fetches: one real title, one left unconfigured (-> slug fallback) per side.
    'https://live.test/old-page/': html('Old Page Title'),
    'https://staging.test/new-page/': html('New Page Title'),
  };
}

describe('auth gate and BASE_PATH', () => {
  test('GET /projects/:id/scan redirects to login when unauthenticated', async () => {
    const { app } = createTestApp();
    const res = await request(app).get('/projects/anything/scan');
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, '/login');
  });

  test('every link/form action on the scan screen is prefixed with a non-root BASE_PATH', async () => {
    const { app, repository } = createTestApp({ routes: fullDiffRoutes(), configOverrides: { basePath: '/content-check' } });
    const agent = await loginAgent(app, '/content-check');
    const csrfToken = extractCsrfToken((await agent.get('/content-check/projects/new')).text);
    await agent.post('/content-check/projects').type('form').send({
      _csrf: csrfToken,
      name: 'Test Co',
      liveUrl: 'https://live.test',
      stagingUrl: 'https://staging.test',
    });
    const listHtml = (await agent.get('/content-check/projects')).text;
    const id = listHtml.match(/projects\/([^/]+)\/edit/)[1];
    assert.match(listHtml, new RegExp(`/content-check/projects/${id}/scan`));

    const scanHtml = (await agent.get(`/content-check/projects/${id}/scan`)).text;
    assert.match(scanHtml, new RegExp(`action="/content-check/projects/${id}/scan"`));
    assert.doesNotMatch(scanHtml, /href="\/(?!content-check)/);
    assert.doesNotMatch(scanHtml, /action="\/(?!content-check)/);
    void repository;
  });
});

describe('Cache-Control and bfcache handling (requirement 15)', () => {
  test('the scan screen carries Cache-Control: no-store and the bfcache guard', async () => {
    const { app } = createTestApp({ routes: fullDiffRoutes() });
    const agent = await loginAgent(app);
    const id = await createProject(agent);

    const res = await agent.get(`/projects/${id}/scan`);
    assert.match(res.headers['cache-control'], /no-store/);
    assert.match(res.text, /pageshow/);
    assert.match(res.text, /event\.persisted/);
  });
});

describe('CSRF protection on the scan trigger (state-changing route)', () => {
  test('POST without a CSRF token is rejected', async () => {
    const { app } = createTestApp({ routes: fullDiffRoutes() });
    const agent = await loginAgent(app);
    const id = await createProject(agent);
    const res = await agent.post(`/projects/${id}/scan`).type('form').send({});
    assert.equal(res.status, 403);
  });
});

describe('the double-submit guard is server-side (requirement 3)', () => {
  test('a second concurrent POST for the same project is rejected while the first is still running', async () => {
    const routes = fullDiffRoutes();
    // Make the live-side fetch slow so the first scan is still in flight
    // when the second request arrives.
    routes['https://live.test/sitemap_index.xml'] = { body: LIVE_INDEX_XML, delayMs: 150 };
    const { app } = createTestApp({ routes });
    const agent = await loginAgent(app);
    const id = await createProject(agent);
    const csrfToken = extractCsrfToken((await agent.get(`/projects/${id}/scan`)).text);

    const [first, second] = await Promise.all([
      agent.post(`/projects/${id}/scan`).type('form').send({ _csrf: csrfToken }),
      new Promise((resolve) => setTimeout(resolve, 20)).then(() =>
        agent.post(`/projects/${id}/scan`).type('form').send({ _csrf: csrfToken })
      ),
    ]);

    assert.equal(second.status, 409);
    assert.match(second.text, /already running/i);
    assert.equal(first.status, 200);
  });

  test('a scan can be run again normally once the previous one has finished', async () => {
    const { app } = createTestApp({ routes: fullDiffRoutes() });
    const agent = await loginAgent(app);
    const id = await createProject(agent);
    const csrfToken = extractCsrfToken((await agent.get(`/projects/${id}/scan`)).text);

    const first = await agent.post(`/projects/${id}/scan`).type('form').send({ _csrf: csrfToken });
    assert.equal(first.status, 200);

    const csrfToken2 = extractCsrfToken(first.text);
    const second = await agent.post(`/projects/${id}/scan`).type('form').send({ _csrf: csrfToken2 });
    assert.equal(second.status, 200);
    assert.doesNotMatch(second.text, /already running/i);
  });
});

describe('full comparison — all three group states, grouping, and approximate-title marking', () => {
  test('renders onLiveOnly (risk) and onStagingOnly (informational) sections, grouped by page/post, with correct framing copy', async () => {
    const { app } = createTestApp({ routes: fullDiffRoutes() });
    const agent = await loginAgent(app);
    const id = await createProject(agent);
    const csrfToken = extractCsrfToken((await agent.get(`/projects/${id}/scan`)).text);

    const res = await agent.post(`/projects/${id}/scan`).type('form').send({ _csrf: csrfToken });
    assert.equal(res.status, 200);

    // Framing copy (requirement 4) — asserted on the actual text, not
    // just presence of two sections.
    assert.match(res.text, /On live, missing from staging/);
    assert.match(res.text, /will be lost if you push/i);
    assert.match(res.text, /On staging, not yet on live/);
    assert.match(res.text, /informational only/i);

    // Summary line (requirement 6): counts for each group + compared.
    assert.match(res.text, /<strong>2<\/strong> on live only/);
    assert.match(res.text, /<strong>2<\/strong> on staging only/);
    assert.match(res.text, /<strong>3<\/strong> present on both/);

    // A real fetched title and a slug-derived one, each marked correctly.
    assert.match(res.text, /Old Page Title/);
    assert.match(res.text, />Alpha<\/a>/); // slug-derived from /blog/alpha/
    assert.match(res.text, /New Page Title/);
    assert.match(res.text, />Beta<\/a>/);

    // requirement 5: slug-derived titles are visually marked as approximate.
    const approxCount = (res.text.match(/approx-badge/g) || []).length;
    assert.equal(approxCount, 2, 'exactly the two slug-derived titles should be marked approximate');

    // Links open in a new tab and point at the real absolute URL.
    assert.match(res.text, /href="https:\/\/live\.test\/old-page\/" target="_blank"/);
    assert.match(res.text, /href="https:\/\/staging\.test\/new-page\/" target="_blank"/);
  });

  test('titles are fetched only for differing items, not the on-both set (requirement 6 performance rule, end to end)', async () => {
    const { app, fetchImpl } = createTestApp({ routes: fullDiffRoutes() });
    const agent = await loginAgent(app);
    const id = await createProject(agent);
    const csrfToken = extractCsrfToken((await agent.get(`/projects/${id}/scan`)).text);

    await agent.post(`/projects/${id}/scan`).type('form').send({ _csrf: csrfToken });

    const titleFetchUrls = fetchImpl.log.map((entry) => entry.url).filter((u) => u.includes('/old-page/') || u.includes('/new-page/') || u.includes('/alpha/') || u.includes('/beta/') || u.includes('/about/') || u.includes('/contact/') || u.includes('/shared/'));
    assert.ok(!titleFetchUrls.some((u) => u.includes('/about/')), 'must never fetch a title for an on-both URL');
    assert.ok(!titleFetchUrls.some((u) => u.includes('/contact/')), 'must never fetch a title for an on-both URL');
    assert.ok(!titleFetchUrls.some((u) => u.includes('/shared/')), 'must never fetch a title for an on-both URL');
  });

  test('a javascript: <loc> from a compromised site never reaches a rendered href (QA1 Sprint 5 audit, finding A, end to end)', async () => {
    const routes = {
      'https://live.test/robots.txt': notFound(),
      'https://live.test/sitemap_index.xml': {
        body: `<?xml version="1.0"?><urlset><url><loc>https://live.test/real-page/</loc></url></urlset>`,
      },
      'https://live.test/real-page/': html('Real Page'),
      'https://staging.test/robots.txt': notFound(),
      'https://staging.test/sitemap_index.xml': {
        body: `<?xml version="1.0"?><urlset>
          <url><loc>javascript:alert(document.querySelector('[name=_csrf]').value)</loc></url>
          <url><loc>https://staging.test/legit/</loc></url>
        </urlset>`,
      },
      'https://staging.test/legit/': html('Legit'),
    };
    const { app } = createTestApp({ routes });
    const agent = await loginAgent(app);
    const id = await createProject(agent);
    const csrfToken = extractCsrfToken((await agent.get(`/projects/${id}/scan`)).text);

    const res = await agent.post(`/projects/${id}/scan`).type('form').send({ _csrf: csrfToken });
    assert.equal(res.status, 200);

    assert.doesNotMatch(res.text, /javascript:/i);
    assert.doesNotMatch(res.text, /href="[^"]*alert/i);
    // The legitimate staging-only item still rendered normally.
    assert.match(res.text, /href="https:\/\/staging\.test\/legit\/"/);
  });
});

describe('zero-difference state (requirement 7)', () => {
  test('renders an explicit "no differences" message, not an empty page', async () => {
    const routes = {
      'https://live.test/robots.txt': notFound(),
      'https://live.test/sitemap_index.xml': { body: LIVE_PAGE_XML.replace(/live\.test\/old-page/, 'live.test/about') }, // won't be used directly
      'https://staging.test/robots.txt': notFound(),
      'https://staging.test/sitemap_index.xml': { body: STAGING_PAGE_XML },
    };
    // Simplify: identical single urlset root on both sides.
    const identicalXml = `<?xml version="1.0"?><urlset>
      <url><loc>https://SIDE.test/about/</loc></url>
      <url><loc>https://SIDE.test/contact/</loc></url>
    </urlset>`;
    routes['https://live.test/sitemap_index.xml'] = { body: identicalXml.replace(/SIDE/g, 'live') };
    routes['https://staging.test/sitemap_index.xml'] = { body: identicalXml.replace(/SIDE/g, 'staging') };

    const { app } = createTestApp({ routes });
    const agent = await loginAgent(app);
    const id = await createProject(agent);
    const csrfToken = extractCsrfToken((await agent.get(`/projects/${id}/scan`)).text);

    const res = await agent.post(`/projects/${id}/scan`).type('form').send({ _csrf: csrfToken });
    assert.equal(res.status, 200);
    assert.match(res.text, /No differences found — safe to push/);
    assert.doesNotMatch(res.text, /On live, missing from staging/);
  });
});

describe('truncation warning renders alongside results, never instead of them (requirement 8)', () => {
  test('a side hitting the child-sitemap cap still shows results plus an incompleteness warning', async () => {
    const routes = {
      'https://live.test/robots.txt': notFound(),
      'https://live.test/sitemap_index.xml': { body: LIVE_INDEX_XML },
      'https://live.test/page-sitemap.xml': { body: LIVE_PAGE_XML },
      'https://live.test/post-sitemap.xml': { body: LIVE_POST_XML },
      'https://live.test/old-page/': html('Old Page Title'),
      'https://staging.test/robots.txt': notFound(),
    };

    // A staging index with 51 children — one over the default cap of 50
    // (lib/sitemap/constants.js DEFAULTS.maxChildren) — guarantees
    // truncated: true deterministically, no delays/budget needed.
    const childNames = [];
    let stagingIndexEntries = '';
    for (let i = 0; i < 51; i += 1) {
      const name = `child${i}`;
      childNames.push(name);
      stagingIndexEntries += `<sitemap><loc>https://staging.test/page-${name}.xml</loc></sitemap>`;
      routes[`https://staging.test/page-${name}.xml`] = {
        body: `<?xml version="1.0"?><urlset><url><loc>https://staging.test/only-on-staging-${name}/</loc></url></urlset>`,
      };
    }
    routes['https://staging.test/sitemap_index.xml'] = {
      body: `<?xml version="1.0"?><sitemapindex>${stagingIndexEntries}</sitemapindex>`,
    };

    const { app } = createTestApp({ routes });
    const agent = await loginAgent(app);
    const id = await createProject(agent);
    const csrfToken = extractCsrfToken((await agent.get(`/projects/${id}/scan`)).text);

    const res = await agent.post(`/projects/${id}/scan`).type('form').send({ _csrf: csrfToken });
    assert.equal(res.status, 200);

    assert.match(res.text, /may be incomplete/i);
    assert.match(res.text, /staging/); // names which side
    // Results are STILL rendered alongside the warning.
    assert.match(res.text, /On staging, not yet on live/);
    assert.match(res.text, /only-on-staging-child0/);
  });

  // QA1's Sprint 5 audit, finding C: the warning fired for `truncated`
  // only — `skipped` and `ambiguous`, both named in requirement 8's
  // first sentence, were carried all the way to the view and never
  // rendered. Two demonstrations, reproduced here as regression tests.
  describe('skipped and ambiguous sitemaps also warn, not just truncation (finding C)', () => {
    test('a 404 on a staging child sitemap produces a warning, instead of a silent false alarm on the live-only side', async () => {
      // staging's post-sitemap2.xml 404s. Its content (had it succeeded)
      // would have matched live's /p2/ — because staging never actually
      // saw it, /p2/ reads as "on live only" (a false "will be lost"
      // alarm), with nothing on screen explaining that a staging
      // sitemap was never read at all.
      const routes = {
        'https://live.test/robots.txt': notFound(),
        'https://live.test/sitemap_index.xml': {
          body: `<?xml version="1.0"?><urlset><url><loc>https://live.test/p2/</loc></url></urlset>`,
        },
        'https://live.test/p2/': html('Page 2'),
        'https://staging.test/robots.txt': notFound(),
        'https://staging.test/sitemap_index.xml': {
          body: `<?xml version="1.0"?><sitemapindex>
            <sitemap><loc>https://staging.test/post-sitemap.xml</loc></sitemap>
            <sitemap><loc>https://staging.test/post-sitemap2.xml</loc></sitemap>
          </sitemapindex>`,
        },
        'https://staging.test/post-sitemap.xml': {
          body: `<?xml version="1.0"?><urlset><url><loc>https://staging.test/other/</loc></url></urlset>`,
        },
        'https://staging.test/post-sitemap2.xml': notFound(),
      };
      const { app } = createTestApp({ routes });
      const agent = await loginAgent(app);
      const id = await createProject(agent);
      const csrfToken = extractCsrfToken((await agent.get(`/projects/${id}/scan`)).text);

      const res = await agent.post(`/projects/${id}/scan`).type('form').send({ _csrf: csrfToken });
      assert.equal(res.status, 200);

      // The false alarm is still there (that part is honest — /p2/
      // genuinely wasn't seen on staging) ...
      assert.match(res.text, /p2\//);
      // ... but now explained, not silent.
      assert.match(res.text, /could not be read|skipped/i);
      assert.match(res.text, /post-sitemap2\.xml/);
    });

    test('an ambiguous sitemap included on both sides produces a note even alongside a zero-difference result', async () => {
      const routes = {
        'https://live.test/robots.txt': notFound(),
        'https://live.test/sitemap_index.xml': {
          body: `<?xml version="1.0"?><sitemapindex>
            <sitemap><loc>https://live.test/post-sitemap.xml</loc></sitemap>
            <sitemap><loc>https://live.test/gallery-sitemap.xml</loc></sitemap>
          </sitemapindex>`,
        },
        'https://live.test/post-sitemap.xml': {
          body: `<?xml version="1.0"?><urlset><url><loc>https://x.test/shared/</loc></url></urlset>`,
        },
        'https://live.test/gallery-sitemap.xml': {
          body: `<?xml version="1.0"?><urlset><url><loc>https://x.test/gallery/item/</loc></url></urlset>`,
        },
        'https://staging.test/robots.txt': notFound(),
        'https://staging.test/sitemap_index.xml': {
          body: `<?xml version="1.0"?><sitemapindex>
            <sitemap><loc>https://staging.test/post-sitemap.xml</loc></sitemap>
            <sitemap><loc>https://staging.test/gallery-sitemap.xml</loc></sitemap>
          </sitemapindex>`,
        },
        'https://staging.test/post-sitemap.xml': {
          body: `<?xml version="1.0"?><urlset><url><loc>https://x.test/shared/</loc></url></urlset>`,
        },
        'https://staging.test/gallery-sitemap.xml': {
          body: `<?xml version="1.0"?><urlset><url><loc>https://x.test/gallery/item/</loc></url></urlset>`,
        },
      };
      const { app } = createTestApp({ routes });
      const agent = await loginAgent(app);
      const id = await createProject(agent);
      const csrfToken = extractCsrfToken((await agent.get(`/projects/${id}/scan`)).text);

      const res = await agent.post(`/projects/${id}/scan`).type('form').send({ _csrf: csrfToken });
      assert.equal(res.status, 200);

      // Both sides normalize to the same two comparison keys, so this
      // is a genuine zero-difference result...
      assert.match(res.text, /No differences found/);
      // ...but "safe to push" must not stand alone: an unrecognized
      // sitemap was included on faith on both sides.
      assert.match(res.text, /didn't match a known naming convention/i);
      assert.match(res.text, /gallery-sitemap\.xml/);
    });

    test('excluded-content-type skips do NOT trigger the warning — it fires on every normal site otherwise', async () => {
      const routes = {
        'https://live.test/robots.txt': notFound(),
        'https://live.test/sitemap_index.xml': {
          body: `<?xml version="1.0"?><sitemapindex>
            <sitemap><loc>https://live.test/post-sitemap.xml</loc></sitemap>
            <sitemap><loc>https://live.test/product-sitemap.xml</loc></sitemap>
          </sitemapindex>`,
        },
        'https://live.test/post-sitemap.xml': {
          body: `<?xml version="1.0"?><urlset><url><loc>https://live.test/only/</loc></url></urlset>`,
        },
        // product-sitemap.xml is classified 'exclude' and never fetched
        // — no route needed, and its absence proves it really wasn't
        // requested.
        'https://staging.test/robots.txt': notFound(),
        'https://staging.test/sitemap_index.xml': {
          body: `<?xml version="1.0"?><urlset></urlset>`,
        },
        'https://live.test/only/': html('Only'),
      };
      const { app } = createTestApp({ routes });
      const agent = await loginAgent(app);
      const id = await createProject(agent);
      const csrfToken = extractCsrfToken((await agent.get(`/projects/${id}/scan`)).text);

      const res = await agent.post(`/projects/${id}/scan`).type('form').send({ _csrf: csrfToken });
      assert.equal(res.status, 200);
      assert.doesNotMatch(res.text, /could not be read/i);
      assert.doesNotMatch(res.text, /product-sitemap/);
    });
  });
});

describe('typed error presentation — staging 401 (requirement 10)', () => {
  // QA1's Sprint 5 audit, finding B: this is the PRIMARY path —
  // discovery running from the project's own saved staging URL, no
  // manual sitemap entered — and it's exactly what LiveQA's own
  // criterion scans ("run a scan against a site whose staging URL
  // requires Basic Auth with no credentials saved"). Every automatic
  // attempt (robots.txt, then each candidate path) 401s independently;
  // discovery.js records each as an attempt and keeps trying the next
  // one rather than aborting, so this exercises SitemapDiscoveryFailedError
  // carrying auth-coded attempts, not HttpAuthError directly — see
  // scanErrorPresentation.js's hasAuthAttempt().
  test('discovery from the saved staging URL, with no manual sitemap entered, produces the .htaccess message and edit link', async () => {
    const routes = {
      'https://live.test/robots.txt': notFound(),
      'https://live.test/sitemap_index.xml': { body: LIVE_INDEX_XML },
      'https://live.test/page-sitemap.xml': { body: LIVE_PAGE_XML },
      'https://live.test/post-sitemap.xml': { body: LIVE_POST_XML },
      'https://live.test/old-page/': html('Old Page Title'),
      'https://staging.test/robots.txt': { status: 401 },
      'https://staging.test/sitemap_index.xml': { status: 401 },
      'https://staging.test/wp-sitemap.xml': { status: 401 },
      'https://staging.test/sitemap.xml': { status: 401 },
    };
    const { app } = createTestApp({ routes });
    const agent = await loginAgent(app);
    const id = await createProject(agent);
    const csrfToken = extractCsrfToken((await agent.get(`/projects/${id}/scan`)).text);

    const res = await agent.post(`/projects/${id}/scan`).type('form').send({ _csrf: csrfToken });
    assert.equal(res.status, 200);
    assert.match(res.text, /\.htaccess/);
    assert.match(res.text, new RegExp(`href="/projects/${id}/edit"`));
    assert.doesNotMatch(res.text, /Could not automatically discover a sitemap/);
  });

  test('a 401 on a manually-supplied staging sitemap URL also produces the .htaccess message and edit link (the direct-propagation path)', async () => {
    const routes = {
      'https://live.test/robots.txt': notFound(),
      'https://live.test/sitemap_index.xml': { body: LIVE_INDEX_XML },
      'https://live.test/page-sitemap.xml': { body: LIVE_PAGE_XML },
      'https://live.test/post-sitemap.xml': { body: LIVE_POST_XML },
      'https://live.test/old-page/': html('Old Page Title'),
      'https://staging.test/my-sitemap.xml': { status: 401 },
    };
    const { app } = createTestApp({ routes });
    const agent = await loginAgent(app);
    const id = await createProject(agent);
    const csrfToken = extractCsrfToken((await agent.get(`/projects/${id}/scan`)).text);

    const res = await agent
      .post(`/projects/${id}/scan`)
      .type('form')
      .send({ _csrf: csrfToken, manualStagingSitemapUrl: 'https://staging.test/my-sitemap.xml' });
    assert.equal(res.status, 200);
    assert.match(res.text, /\.htaccess/);
    assert.match(res.text, new RegExp(`href="/projects/${id}/edit"`));
  });
});

describe('partial result — one side fails, the other still renders (requirement 11)', () => {
  test('a fully-failed staging side still shows the live side\'s findings, clearly labelled partial', async () => {
    const routes = {
      'https://live.test/robots.txt': notFound(),
      'https://live.test/sitemap_index.xml': { body: LIVE_INDEX_XML },
      'https://live.test/page-sitemap.xml': { body: LIVE_PAGE_XML },
      'https://live.test/post-sitemap.xml': { body: LIVE_POST_XML },
      'https://live.test/old-page/': html('Old Page Title'),
      'https://staging.test/robots.txt': notFound(),
      'https://staging.test/sitemap_index.xml': notFound(),
      'https://staging.test/wp-sitemap.xml': notFound(),
      'https://staging.test/sitemap.xml': notFound(),
    };
    const { app } = createTestApp({ routes });
    const agent = await loginAgent(app);
    const id = await createProject(agent);
    const csrfToken = extractCsrfToken((await agent.get(`/projects/${id}/scan`)).text);

    const res = await agent.post(`/projects/${id}/scan`).type('form').send({ _csrf: csrfToken });
    assert.equal(res.status, 200);
    assert.match(res.text, /Partial result/i);
    assert.match(res.text, /Live site/);
    // The live site's actual pages/posts are shown (not a diff).
    assert.match(res.text, /about\//);
    assert.match(res.text, /blog\/shared\//);
    assert.match(res.text, /Staging scan failed/i);
  });

  // QA1 Sprint 5 audit, item E (non-blocking, verified anyway since it's
  // cheap and directly adjacent to finding B): both sides 401ing must
  // still give staging its specific credentials message, independent of
  // whatever the live side's (separate, correct) wording says.
  test('a 401 on BOTH sides still produces the staging-specific credentials message, not the generic live wording for both', async () => {
    const routes = {
      'https://live.test/robots.txt': { status: 401 },
      'https://live.test/sitemap_index.xml': { status: 401 },
      'https://live.test/wp-sitemap.xml': { status: 401 },
      'https://live.test/sitemap.xml': { status: 401 },
      'https://staging.test/robots.txt': { status: 401 },
      'https://staging.test/sitemap_index.xml': { status: 401 },
      'https://staging.test/wp-sitemap.xml': { status: 401 },
      'https://staging.test/sitemap.xml': { status: 401 },
    };
    const { app } = createTestApp({ routes });
    const agent = await loginAgent(app);
    const id = await createProject(agent);
    const csrfToken = extractCsrfToken((await agent.get(`/projects/${id}/scan`)).text);

    const res = await agent.post(`/projects/${id}/scan`).type('form').send({ _csrf: csrfToken });
    assert.equal(res.status, 200);
    assert.match(res.text, /\.htaccess/);
    assert.match(res.text, new RegExp(`href="/projects/${id}/edit"`));
    // The live-side wording is separate and must not ALSO claim
    // .htaccess credentials — there's no live credential field.
    assert.match(res.text, /This live site rejected requests with an authentication error/);
  });
});

describe('manual sitemap fallback (requirement 9)', () => {
  test('automatic discovery failure is explained, and a pasted sitemap URL completes the scan on resubmission', async () => {
    const routes = {
      'https://live.test/robots.txt': notFound(),
      'https://live.test/sitemap_index.xml': { body: LIVE_INDEX_XML },
      'https://live.test/page-sitemap.xml': { body: LIVE_PAGE_XML },
      'https://live.test/post-sitemap.xml': { body: LIVE_POST_XML },
      'https://live.test/old-page/': html('Old Page Title'),
      // Staging: every automatic candidate fails.
      'https://staging.test/robots.txt': notFound(),
      'https://staging.test/sitemap_index.xml': notFound(),
      'https://staging.test/wp-sitemap.xml': notFound(),
      'https://staging.test/sitemap.xml': notFound(),
      // The URL the user will paste manually.
      'https://staging.test/my-manual-sitemap.xml': { body: STAGING_INDEX_XML },
      'https://staging.test/page-sitemap.xml': { body: STAGING_PAGE_XML },
      'https://staging.test/post-sitemap.xml': { body: STAGING_POST_XML },
      'https://staging.test/new-page/': html('New Page Title'),
    };
    const { app } = createTestApp({ routes });
    const agent = await loginAgent(app);
    const id = await createProject(agent);

    const first = await agent
      .post(`/projects/${id}/scan`)
      .type('form')
      .send({ _csrf: extractCsrfToken((await agent.get(`/projects/${id}/scan`)).text) });
    assert.match(first.text, /Could not automatically discover a sitemap/);
    assert.match(first.text, /paste a sitemap url/i);

    // Resubmit with ONLY the manual staging URL filled in — nothing else
    // re-entered (project id stays in the URL path; the form's other
    // fields are simply left as they already were).
    const csrfToken2 = extractCsrfToken(first.text);
    const second = await agent
      .post(`/projects/${id}/scan`)
      .type('form')
      .send({ _csrf: csrfToken2, manualStagingSitemapUrl: 'https://staging.test/my-manual-sitemap.xml' });

    assert.equal(second.status, 200);
    assert.match(second.text, /On live, missing from staging/);
    assert.doesNotMatch(second.text, /Could not automatically discover/);
  });

  test('an invalid pasted URL produces a clear validation error rather than a crash', async () => {
    const routes = {
      'https://live.test/robots.txt': notFound(),
      'https://live.test/sitemap_index.xml': { body: LIVE_INDEX_XML },
      'https://live.test/page-sitemap.xml': { body: LIVE_PAGE_XML },
      'https://live.test/post-sitemap.xml': { body: LIVE_POST_XML },
      'https://live.test/old-page/': html('Old Page Title'),
    };
    const { app } = createTestApp({ routes });
    const agent = await loginAgent(app);
    const id = await createProject(agent);
    const csrfToken = extractCsrfToken((await agent.get(`/projects/${id}/scan`)).text);

    const res = await agent
      .post(`/projects/${id}/scan`)
      .type('form')
      .send({ _csrf: csrfToken, manualStagingSitemapUrl: 'not-a-url' });

    assert.equal(res.status, 200);
    assert.match(res.text, /http:\/\/ or https:\/\//);
  });
});

describe('the credential boundary holds at the route (requirement 16)', () => {
  test('lib/sitemap and lib/compare import neither the store nor the decrypt helper (structural, re-confirms sprint 4\'s own check)', () => {
    for (const dir of ['lib/sitemap', 'lib/compare']) {
      const fullDir = path.join(__dirname, '..', '..', dir);
      for (const file of fs.readdirSync(fullDir)) {
        if (!file.endsWith('.js')) continue;
        const contents = fs.readFileSync(path.join(fullDir, file), 'utf8');
        assert.ok(!/require\(.*src\/db/.test(contents), `${dir}/${file} must not import the store`);
        assert.ok(!/require\(.*src\/lib\/crypto/.test(contents), `${dir}/${file} must not import the decrypt helper`);
      }
    }
  });

  test('getDecryptedBasicAuthPassword is called only from src/routes/scan.js', () => {
    const srcDir = path.join(__dirname, '..', '..', 'src');
    const callers = [];
    function walk(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.js')) {
          const contents = fs.readFileSync(full, 'utf8');
          if (contents.includes('getDecryptedBasicAuthPassword(') && !full.endsWith('projectsRepository.js')) {
            callers.push(full);
          }
        }
      }
    }
    walk(srcDir);
    assert.deepEqual(
      callers.map((f) => path.relative(srcDir, f)),
      [path.join('routes', 'scan.js')]
    );
  });
});

describe('connection pinning wiring (requirement 14)', () => {
  test('the SAME injected fetchImpl serves both the sitemap crawl and the title fetch, end to end through a real route request', async () => {
    const { app, fetchImpl } = createTestApp({ routes: fullDiffRoutes() });
    const agent = await loginAgent(app);
    const id = await createProject(agent);
    const csrfToken = extractCsrfToken((await agent.get(`/projects/${id}/scan`)).text);

    await agent.post(`/projects/${id}/scan`).type('form').send({ _csrf: csrfToken });

    const urls = fetchImpl.log.map((entry) => entry.url);
    // Sitemap-crawl traffic (lib/sitemap) ...
    assert.ok(urls.some((u) => u.includes('sitemap_index.xml')), 'expected sitemap discovery traffic');
    // ...and title-fetch traffic (lib/compare) both went through the
    // SAME fetchImpl instance this test injected — there is no second,
    // unobserved fetch implementation anywhere in the chain.
    assert.ok(urls.some((u) => u.includes('/old-page/')), 'expected title-fetch traffic through the same fetchImpl');
  });

  test('with NO fetchImpl override (the real production wiring), a literal private-address project URL is blocked end to end', async () => {
    const repository = createProjectsRepository(openDatabase(':memory:'), TEST_ENCRYPTION_KEY);
    // No fetchImpl/dnsLookup passed — exercises createApp's own default
    // createPinnedFetch() construction, exactly as server.js does.
    const app = createApp(buildConfig(), { repository });
    const agent = await loginAgent(app);

    // Sprint 2's own save-time SSRF check would normally reject a
    // private live/staging URL outright — bypass it by writing the
    // project directly into the repository, so this test exercises the
    // SCAN-time pinned fetch specifically, not the unrelated save-time
    // check.
    const id = repository.createProject({
      name: 'Direct Insert',
      liveUrl: 'http://127.0.0.1:1/',
      stagingUrl: 'https://staging.test',
      basicAuthUsername: '',
      passwordAction: 'none',
      rawPassword: '',
    });

    const csrfToken = extractCsrfToken((await agent.get(`/projects/${id}/scan`)).text);
    const res = await agent.post(`/projects/${id}/scan`).type('form').send({ _csrf: csrfToken });

    assert.equal(res.status, 200);
    // Blocked — never actually connects to loopback — and reported as a
    // failure, not silently ignored or crashed.
    assert.match(res.text, /failed|not permitted|disallowed/i);
  });
});

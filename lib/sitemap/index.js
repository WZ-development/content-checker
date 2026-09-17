'use strict';

const dns = require('node:dns');

const { DEFAULTS } = require('./constants');
const { createGuardedFetch } = require('./httpClient');
const { createLimiter } = require('./concurrencyLimit');
const { discoverSitemapRoots } = require('./discovery');
const { crawlSitemapTree } = require('./crawl');
const { parseSitemapXml } = require('./xml');
const errors = require('./errors');

/**
 * Discovers and fully resolves a site's sitemap, returning the complete
 * set of page/post URLs (sprint 3, requirement 1). Registers no Express
 * routes and renders no UI — this is a standalone module; Sprint 5 wires
 * it into a route.
 *
 * Credentials: `auth`, when supplied, is a plaintext `{ username,
 * password }` pair. This module never touches Sprint 2's storage or its
 * encryption format — the caller is responsible for decrypting a stored
 * password (via Sprint 2's decrypt helper) before calling this function.
 * Keeping this module's credential boundary at "plaintext in" is what
 * keeps it standalone and fixture-testable with zero coupling to Sprint
 * 2's file layout, which does not exist yet as of this sprint.
 *
 * @param {object} options
 * @param {string} [options.baseUrl] - Site origin to discover a sitemap
 *   for. Required unless manualSitemapUrl is given.
 * @param {string} [options.manualSitemapUrl] - Bypasses discovery
 *   entirely (requirement 3). Any fetch/parse failure on this URL
 *   propagates directly as a typed error — there is no fallback for an
 *   explicit manual URL.
 * @param {{username: string, password: string}} [options.auth] -
 *   Plaintext HTTP Basic Auth credentials, sent on every request in the
 *   chain to the originally-requested host (requirement 7).
 * @param {Set<string>} [options.authOrigins] - Sprint 7 fix-loop (QA1
 *   round 1 finding B): the ONLY origins `auth` may ever be sent to —
 *   lowercased origin strings, supplied by the caller from the project's
 *   own configured staging URL, never derived from `baseUrl` or
 *   `manualSitemapUrl` themselves. Forwarded to httpClient.js's
 *   createGuardedFetch unchanged; see lib/sitemap/originScope.js.
 * @param {number} [options.timeoutMs] - Per-request timeout (default 15s).
 * @param {number} [options.budgetMs] - Overall operation budget (default 90s).
 * @param {number} [options.maxChildren] - Cap on child sitemaps fetched (default 50).
 * @param {number} [options.concurrency] - Max in-flight fetches (default 5).
 * @param {typeof fetch} [options.fetchImpl] - Injectable for tests; defaults to global fetch.
 * @param {Function} [options.dnsLookup] - Injectable for tests; defaults to dns.promises.lookup.
 *
 * @returns {Promise<{
 *   urls: Array<{loc: string, lastmod?: string, sourceType?: 'page'|'post'}>,
 *   consulted: string[],
 *   skipped: Array<{url: string, reason: string}>,
 *   ambiguous: Array<{url: string, reason: string}>,
 *   truncated: boolean,
 *   discovery: {method: string, attempts?: object[]},
 * }>}
 *   - urls: the complete, de-duplicated set of page/post URLs found. Each
 *     entry's `sourceType` names which kind of sitemap it was found
 *     under ('page' | 'post'), or is undefined when no enclosing
 *     sitemap's filename named one (sprint 4, requirement 5).
 *   - consulted: every sitemap document successfully fetched and parsed.
 *   - skipped: every sitemap that did NOT end up contributing URLs, and
 *     why: excluded by content-type classification, failed to fetch or
 *     parse, or cut off by the cap/budget (reason is prefixed
 *     'excluded-content-type' | 'fetch-failed:<code>' |
 *     'parse-failed:<code>' | 'truncated:cap' | 'truncated:budget' |
 *     'invalid-url' | 'max-depth-exceeded' — see crawl.js). Over-inclusion
 *     is a visible false positive a developer can dismiss; under-inclusion
 *     is silent data loss, so nothing is ever dropped without a record of
 *     why, including a truncated child that was never fetched at all.
 *   - ambiguous: sitemaps that didn't match any known naming convention
 *     AND were actually fetched and consulted (a child classified
 *     ambiguous but then cut off by the cap/budget appears in `skipped`
 *     instead, never here — it was not, in fact, included). Included in
 *     `urls` (never dropped) but flagged here so a caller can surface
 *     "these were included, but unsure — check them" (requirement 6).
 *   - truncated: true if the child-sitemap cap or the overall time budget
 *     was hit before the crawl finished naturally.
 *   - discovery: which strategy found the sitemap ('manual' | 'robots.txt'
 *     | 'candidate'), plus the full attempt log when discovery ran.
 *
 * @throws {errors.SitemapDiscoveryFailedError} when baseUrl-based
 *   discovery exhausts every strategy with nothing found.
 * @throws {errors.SitemapError} (one of its typed subclasses) when a
 *   manualSitemapUrl fails to fetch or parse.
 */
async function discoverAndParseSitemap(options = {}) {
  const {
    baseUrl,
    manualSitemapUrl,
    auth,
    authOrigins,
    timeoutMs = DEFAULTS.timeoutMs,
    budgetMs = DEFAULTS.budgetMs,
    maxChildren = DEFAULTS.maxChildren,
    concurrency = DEFAULTS.concurrency,
    maxRedirects = DEFAULTS.maxRedirects,
    maxSafetyDepth = DEFAULTS.maxSafetyDepth,
    userAgent = DEFAULTS.userAgent,
    fetchImpl = globalThis.fetch,
    dnsLookup = dns.promises.lookup,
  } = options;

  if (!baseUrl && !manualSitemapUrl) {
    throw new TypeError('discoverAndParseSitemap requires baseUrl or manualSitemapUrl');
  }

  // One AbortSignal shared across the ENTIRE call (discovery included),
  // observed by every guardedFetch invocation — see httpClient.js for
  // why admission-time budget checking alone isn't enough (QA1 round 1,
  // finding A: every sibling of a flat index is admitted in the same
  // tick, so nothing re-checks the budget again once a batch is queued).
  const startedAt = Date.now();
  const budgetController = new AbortController();
  const budgetTimer = setTimeout(() => budgetController.abort(), budgetMs);

  try {
    const guardedFetch = createGuardedFetch({
      fetchImpl,
      dnsLookup,
      timeoutMs,
      auth,
      authOrigins,
      userAgent,
      maxRedirects,
      budgetSignal: budgetController.signal,
    });

    let roots;
    let discovery;

    if (manualSitemapUrl) {
      const res = await guardedFetch(manualSitemapUrl);
      const parsedDoc = parseSitemapXml(res.body, { contentType: res.contentType, sourceUrl: manualSitemapUrl });
      roots = [{ url: manualSitemapUrl, parsedDoc }];
      discovery = { method: 'manual' };
    } else {
      const discovered = await discoverSitemapRoots(baseUrl, { guardedFetch });
      roots = discovered.roots;
      discovery = { method: discovered.method, attempts: discovered.attempts };
    }

    const ctx = {
      guardedFetch,
      limit: createLimiter(concurrency),
      budgetMs,
      maxChildren,
      maxSafetyDepth,
      startedAt,
      fetchedCount: 0,
      truncated: false,
      visited: new Set(),
      consulted: [],
      skipped: [],
      ambiguous: [],
      ambiguousRecorded: new Set(), // Sprint 4 carry-forward fix (J) — see crawl.js
      urls: new Map(),
    };

    await crawlSitemapTree(roots, ctx);

    return {
      urls: Array.from(ctx.urls.values()),
      consulted: ctx.consulted,
      skipped: ctx.skipped,
      ambiguous: ctx.ambiguous,
      truncated: ctx.truncated,
      discovery,
    };
  } finally {
    clearTimeout(budgetTimer);
  }
}

module.exports = { discoverAndParseSitemap, errors, DEFAULTS };

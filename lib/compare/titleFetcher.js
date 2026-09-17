'use strict';

const dns = require('node:dns');

const { createGuardedFetch } = require('../sitemap/httpClient');
const { createLimiter } = require('../sitemap/concurrencyLimit');
const { DEFAULTS: SITEMAP_DEFAULTS } = require('../sitemap/constants');
const { extractTitleFromHtml } = require('./extractTitle');
const { stripTitleSuffix } = require('./titleSuffix');
const { deriveSlugTitle } = require('./slug');

const TITLE_FETCH_DEFAULTS = Object.freeze({
  concurrency: 5, // requirement 7
  timeoutMs: 10000, // requirement 7
  maxItems: 100, // requirement 7 — the overall cap
});

/**
 * Resolves a real `<title>` for each differing item, falling back to a
 * slug-derived label whenever a real title can't be had (requirement 8).
 * NEVER fetches for the on-both set — this only ever runs on items a
 * caller has already filtered down to the diff (requirement 6); it takes
 * no opinion on which set that is.
 *
 * Requirement 12's HTTP boundary, followed exactly: this reuses
 * lib/sitemap's own createGuardedFetch and createLimiter rather than
 * building a second HTTP client — the same SSRF defence, redirect
 * handling, and origin-scoped Authorization forwarding apply here for
 * free, with nothing to get subtly wrong a second time. Credentials are
 * a plaintext `{username, password}` object supplied by the caller
 * (requirement 12) — this module never touches Sprint 2's storage or its
 * decrypt helper, and imports neither.
 *
 * Sprint 7 fix-loop, QA1 round 1 finding B: `item.url` for a 'staging'
 * item comes from the STAGING SITEMAP's own content — exactly the kind
 * of untrusted input a compromised or malicious site controls. Passing
 * `authOrigins` through to createGuardedFetch (rather than letting it
 * fall back to trusting item.url's own origin, which was the bug) is
 * what stops a title fetch to a third-party host named in that sitemap
 * from ever carrying the staging credential.
 *
 * Each item MUST carry a `side: 'live' | 'staging'` field, set by the
 * caller (see lib/compare/index.js) from which comparison group it came
 * from — `auth` is only ever sent on a 'staging' item's fetch (a live
 * site has no staging credentials to send), which is why this can't be
 * decided from the URL alone. Two guardedFetch instances are built once
 * and reused across every item — one with `auth`, one without — rather
 * than constructing per-item, so the redirect/SSRF/timeout machinery is
 * genuinely shared work, not re-created per URL.
 *
 * The cap (`maxItems`, default 100) applies to the COMBINED item list in
 * whatever order it's given: the first `maxItems` get an actual fetch
 * attempt, everything after that is slug-derived immediately without
 * ever making a request — "beyond which items fall back... rather than
 * blocking the scan" (requirement 7). Concurrency (default 5) is one
 * shared limit across live AND staging fetches together, not per side.
 *
 * @param {Array<{url: string, side: 'live'|'staging'}>} items
 * @param {object} [options]
 * @param {{username: string, password: string}} [options.auth] - sent
 *   only on 'staging'-side fetches.
 * @param {Set<string>} [options.authOrigins] - Sprint 7 fix-loop (QA1
 *   round 1 finding B): the only origins `auth` may be sent to, forwarded
 *   to createGuardedFetch unchanged. See lib/sitemap/originScope.js.
 * @param {number} [options.concurrency]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.maxItems]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {Function} [options.dnsLookup]
 * @param {string} [options.userAgent]
 * @param {number} [options.maxRedirects]
 * @returns {Promise<Array<object>>} each input item, augmented with
 *   `title` (string) and `titleSource` ('fetched' | 'slug') — requirement 9.
 */
async function resolveTitles(items, options = {}) {
  const {
    auth,
    authOrigins,
    concurrency = TITLE_FETCH_DEFAULTS.concurrency,
    timeoutMs = TITLE_FETCH_DEFAULTS.timeoutMs,
    maxItems = TITLE_FETCH_DEFAULTS.maxItems,
    fetchImpl = globalThis.fetch,
    dnsLookup = dns.promises.lookup,
    userAgent = SITEMAP_DEFAULTS.userAgent,
    maxRedirects = SITEMAP_DEFAULTS.maxRedirects,
  } = options;

  const limit = createLimiter(concurrency);
  const sharedGuardedFetchOptions = { fetchImpl, dnsLookup, timeoutMs, userAgent, maxRedirects };
  const liveFetch = createGuardedFetch({ ...sharedGuardedFetchOptions, auth: undefined });
  const stagingFetch = createGuardedFetch({ ...sharedGuardedFetchOptions, auth, authOrigins });

  return Promise.all(
    items.map((item, index) =>
      limit(async () => {
        if (index >= maxItems) {
          return withSlugFallback(item);
        }

        const guardedFetch = item.side === 'staging' ? stagingFetch : liveFetch;

        let res;
        try {
          res = await guardedFetch(item.url);
        } catch {
          return withSlugFallback(item);
        }

        if (res.contentType && !/html/i.test(res.contentType)) {
          return withSlugFallback(item); // requirement 8: non-HTML response
        }

        const rawTitle = extractTitleFromHtml(res.body);
        if (!rawTitle) {
          return withSlugFallback(item); // fetched fine, but no usable <title>
        }

        return { ...item, title: stripTitleSuffix(rawTitle), titleSource: 'fetched' };
      })
    )
  );
}

function withSlugFallback(item) {
  return { ...item, title: deriveSlugTitle(item.url), titleSource: 'slug' };
}

module.exports = { resolveTitles, TITLE_FETCH_DEFAULTS };

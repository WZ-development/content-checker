'use strict';

const { compareSitemaps } = require('./compare');
const { resolveTitles } = require('./titleFetcher');

/**
 * The end-to-end Sprint 4 entry point Sprint 5 is expected to call:
 * compares live vs staging (pure, requirement 1), then resolves a title
 * for every differing item only (requirement 6) — never for the on-both
 * set, which compareSitemaps doesn't even materialize as a list.
 *
 * compareSitemaps() and resolveTitles() are both exported individually
 * too (see module.exports) for a caller that wants the pure comparison
 * on its own — e.g. a UI that renders the diff first and resolves titles
 * lazily/incrementally — or wants to test either half in isolation,
 * which is exactly how this module's own tests are structured (compare.js
 * has no HTTP in its test path at all; titleFetcher.js's tests inject a
 * fake fetch and never touch compareSitemaps).
 *
 * @param {object} options
 * @param {object} options.live - a discoverAndParseSitemap() result.
 * @param {object} options.staging - a discoverAndParseSitemap() result.
 * @param {{username: string, password: string}} [options.auth] - plaintext
 *   staging credentials, forwarded to resolveTitles untouched. This
 *   module never decrypts anything itself (requirement 12) — the caller
 *   is responsible for having already decrypted a stored password via
 *   Sprint 2's decrypt helper before calling this function.
 * @param {Set<string>} [options.authOrigins] - Sprint 7 fix-loop (QA1
 *   round 1 finding B): the only origins `auth` may be sent to, forwarded
 *   to resolveTitles untouched. See lib/sitemap/originScope.js.
 * @param {object} [options.titleOptions] - forwarded to resolveTitles
 *   (concurrency, timeoutMs, maxItems, fetchImpl, dnsLookup, userAgent,
 *   maxRedirects).
 */
async function compareAndResolveTitles({ live, staging, auth, authOrigins, titleOptions = {} }) {
  const comparison = compareSitemaps({ live, staging });

  const combined = [
    ...comparison.onLiveOnly.map((item) => ({ ...item, side: 'live' })),
    ...comparison.onStagingOnly.map((item) => ({ ...item, side: 'staging' })),
  ];

  const titled = await resolveTitles(combined, { ...titleOptions, auth, authOrigins });

  return {
    ...comparison,
    onLiveOnly: titled.filter((item) => item.side === 'live'),
    onStagingOnly: titled.filter((item) => item.side === 'staging'),
  };
}

module.exports = { compareAndResolveTitles, compareSitemaps, resolveTitles };

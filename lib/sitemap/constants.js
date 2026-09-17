'use strict';

/**
 * Defaults for the sitemap engine. All are overridable per-call via
 * discoverAndParseSitemap's options object (sprint 3, requirements 8-9).
 */
const DEFAULTS = Object.freeze({
  /** Per-request timeout, requirement 8. */
  timeoutMs: 15000,
  /** Overall operation budget, requirement 8. */
  budgetMs: 90000,
  /** Cap on child sitemaps fetched during recursion, requirement 8. */
  maxChildren: 50,
  /** Max in-flight fetches, requirement 9. */
  concurrency: 5,
  /** Redirect hops allowed per single request before giving up. */
  maxRedirects: 5,
  /** Not a feature limit — requirement 4 only requires depth >= 3, and
   * cycle detection (not depth) is the real guard against runaway
   * recursion. This is a generous belt-and-suspenders safety valve for a
   * pathologically deep but non-cyclic chain, set far above any real
   * WordPress site's sitemap nesting. */
  maxSafetyDepth: 20,
  /** Descriptive User-Agent identifying the tool, requirement 9. Sprint 7,
   * requirement 5: updated to the confirmed production path, decided
   * 2026-09-16 (Sprint 1 had shipped with an earlier placeholder path
   * one letter shorter). This UA is identification only, for client
   * logs — it grants nothing; it is never checked by anything in this
   * codebase. The actual non-spoofable allow mechanism lives entirely
   * in lib/net/pinnedFetch.js. */
  userAgent: 'ContentCheckerBot/1.0 (+https://tools.wordzite.com/content-checker)',
});

/** Discovery candidate paths, tried in this order, per requirement 2(b). */
const CANDIDATE_SITEMAP_PATHS = Object.freeze([
  '/sitemap_index.xml',
  '/wp-sitemap.xml',
  '/sitemap.xml',
]);

module.exports = { DEFAULTS, CANDIDATE_SITEMAP_PATHS };

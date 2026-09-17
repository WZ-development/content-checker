'use strict';

/**
 * Sprint 7 fix-loop (QA1 round 1 findings A and B): origin-scoping shared
 * by BOTH secret headers this codebase ever sends — HTTP Basic Auth
 * (httpClient.js, requirement 7) and the outbound identification token
 * (lib/net/pinnedFetch.js, sprint 7 requirement 1). "Origin" means
 * scheme+host+port, exactly URL's own `.origin` — a scheme or port change
 * counts as a DIFFERENT origin (sprint 4 carry-forward fix H's rule,
 * generalized here to cover every secret, not just Authorization).
 *
 * The critical property, the one QA1's audit found missing: `allowedOrigins`
 * must always be derived from something OUTSIDE the content being fetched —
 * the project's own configured liveUrl/stagingUrl — never from the URL
 * being checked itself, and never from a URL discovered inside fetched
 * content (a sitemap `<loc>`, a robots.txt `Sitemap:` directive, a redirect
 * target). All of those are attacker-influenceable the moment a scanned
 * site is compromised or malicious; comparing a URL's origin against
 * itself (what httpClient.js did before this fix) always passes, which is
 * exactly how a staging credential ended up being sent to a third-party
 * host named by that host's own sitemap content.
 */

/** The lowercased origin (scheme+host+port) of a URL string. */
function originOf(url) {
  return new URL(url).origin.toLowerCase();
}

/**
 * True when `url`'s origin is a member of `allowedOrigins` (a Set of
 * already-lowercased origin strings). Never throws on a malformed URL —
 * treated as "not allowed," the safe default, rather than propagating a
 * parse error into what call sites treat as a simple boolean gate.
 */
function isAllowedOrigin(url, allowedOrigins) {
  if (!allowedOrigins) return false;
  try {
    return allowedOrigins.has(originOf(url));
  } catch {
    return false;
  }
}

module.exports = { originOf, isAllowedOrigin };

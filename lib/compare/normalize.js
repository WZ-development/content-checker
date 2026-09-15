'use strict';

/**
 * Normalizes an absolute URL to a comparison key (sprint 4, requirements
 * 2-3). Live and staging URLs never match as raw strings — live is
 * `clientdomain.com/about/`, staging is `staging.clientdomain.com/about/`
 * — so every URL is reduced to the parts that actually identify the same
 * piece of content across both hosts:
 *
 *   - scheme: dropped entirely.
 *   - host: dropped ENTIRELY, not mapped or fuzzy-matched. This is
 *     requirement 3's central design choice — an arbitrary staging host
 *     (`staging.clientdomain.com`, `client.wpengine.com`,
 *     `dev-client.kinsta.cloud`, anything) compares correctly against
 *     live with zero configuration, because the comparison never looks
 *     at the host at all. Folding `www.` specifically would be a no-op
 *     once the host is gone entirely, which is exactly why dropping the
 *     host outright is the stronger fix, not a companion to it.
 *   - path: lowercased, trailing slash normalized to absent UNLESS the
 *     path is bare "/" (kept, not reduced to an empty string).
 *   - fragment: dropped — `#team` never identifies a different page.
 *   - query string: PRESERVED (unlike scheme/host/fragment) but with its
 *     parameters re-ordered by key so `?a=1&b=2` and `?b=2&a=1` compare
 *     equal; not lowercased — a parameter's VALUE can be a case-sensitive
 *     token or id, so only the path itself is case-folded.
 *
 * Returns the comparison key as a string, or the trimmed input unchanged
 * if it isn't a parseable absolute URL — comparison degrades to a
 * literal-string compare for that one entry rather than throwing and
 * aborting the whole diff; Sprint 3's own inputs are already validated
 * absolute URLs, so this is a defensive fallback, not an expected path.
 */
function normalizeUrlForComparison(rawUrl) {
  const trimmed = typeof rawUrl === 'string' ? rawUrl.trim() : '';

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return trimmed;
  }

  const path = normalizePath(parsed.pathname);
  const query = normalizeQuery(parsed.search);

  return `${path}${query}`;
}

function normalizePath(pathname) {
  const lower = pathname.toLowerCase();
  if (lower === '/') return lower;
  return lower.endsWith('/') ? lower.slice(0, -1) : lower;
}

function normalizeQuery(search) {
  if (!search) return '';
  const params = new URLSearchParams(search);
  const sorted = Array.from(params.entries()).sort(([keyA, valueA], [keyB, valueB]) => {
    if (keyA !== keyB) return keyA < keyB ? -1 : 1;
    return valueA < valueB ? -1 : valueA > valueB ? 1 : 0;
  });
  if (sorted.length === 0) return '';
  return `?${new URLSearchParams(sorted).toString()}`;
}

module.exports = { normalizeUrlForComparison };

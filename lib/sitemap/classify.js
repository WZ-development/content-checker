'use strict';

/**
 * Classifies a child sitemap URL as 'include', 'exclude', or 'ambiguous'
 * (sprint 3, requirements 5-6), WITHOUT relying on exact filenames — real
 * sites use at least three different naming conventions for the same
 * content (`page-sitemap.xml`, `post-sitemap2.xml`, `sitemap-page-1.xml`,
 * WordPress core's `wp-sitemap-posts-post-1.xml`), and inventing a fourth
 * is only a matter of time.
 *
 * Approach: take the filename, strip the `.xml` extension and any
 * trailing digits used for pagination (`sitemap2` -> `sitemap`,
 * `page-1` -> `page-`), split on separators, and drop noise tokens
 * (`sitemap`, `wp`, empty strings left over from stripped digits). What's
 * left are the semantic tokens the filename is actually built from.
 *
 *   'post-sitemap2.xml'          -> ['post']            -> include
 *   'sitemap-page-1.xml'         -> ['page']             -> include
 *   'wp-sitemap-posts-post-1.xml'-> ['posts', 'post']    -> include
 *   'product-sitemap.xml'        -> ['product']          -> exclude
 *   'wp-sitemap-users-1.xml'     -> ['users']             -> exclude
 *   'gallery-sitemap.xml'        -> ['gallery']           -> ambiguous
 *
 * Exclusion is checked first and wins over inclusion — a filename that
 * clearly names an excluded content type (per PRD §4.4) should never be
 * pulled in just because it also contains a plausible-looking token.
 * Anything that matches neither list is 'ambiguous': requirement 6 says
 * to include it and flag it, never drop it silently, because
 * under-inclusion here is the highest-severity risk in the project.
 */

const EXCLUDE_KEYWORDS = [
  'product',
  'products',
  'category',
  'categories',
  'author',
  'authors',
  'tag',
  'tags',
  'media',
  'attachment',
  'attachments',
  'taxonomy',
  'taxonomies',
  'user',
  'users',
];

const PAGE_KEYWORDS = ['page', 'pages'];
const POST_KEYWORDS = ['post', 'posts'];
const INCLUDE_KEYWORDS = [...PAGE_KEYWORDS, ...POST_KEYWORDS];

const NOISE_TOKENS = new Set(['sitemap', 'wp', '']);

function classifyChildSitemap(url) {
  const tokens = semanticTokens(url);

  if (tokens.some((token) => matchesKeyword(token, EXCLUDE_KEYWORDS))) {
    return 'exclude';
  }
  if (tokens.some((token) => matchesKeyword(token, INCLUDE_KEYWORDS))) {
    return 'include';
  }
  return 'ambiguous';
}

/**
 * Sprint 4, requirement 5: which specific content type ('page' or 'post')
 * a sitemap's filename names, for a caller that already knows (via
 * classifyChildSitemap) that it should be included. Same tokenization,
 * but reports which keyword matched rather than the coarser include/
 * exclude/ambiguous decision — 'include' covers both page and post
 * sitemaps, and Sprint 4 needs to know which so the comparison output
 * can group results by type. Returns undefined for a sitemap whose
 * filename doesn't clearly name page or post content (an 'exclude' or
 * 'ambiguous' sitemap, or an unrecognized convention) — the caller
 * decides how to label URLs of unknown type; this never guesses.
 */
function classifySitemapContentType(url) {
  const tokens = semanticTokens(url);
  if (tokens.some((token) => matchesKeyword(token, PAGE_KEYWORDS))) return 'page';
  if (tokens.some((token) => matchesKeyword(token, POST_KEYWORDS))) return 'post';
  return undefined;
}

/**
 * Sprint 4 carry-forward fix (G, QA1's Sprint 3 audit): matched by
 * PREFIX (token.startsWith(keyword)), so a token that merely shared a
 * leading substring with a keyword — e.g. 'producthunt' starting with
 * 'product' — was wrongly excluded despite naming unrelated content.
 * Every real naming convention this module needs to recognize already
 * produces an EXACT token after semanticTokens' tokenization (pagination
 * digits and separators stripped, 'sitemap'/'wp' dropped as noise) — see
 * the worked examples in the module doc comment above — so prefix
 * matching was never buying real coverage, only false positives on
 * tokens that happen to start the same way.
 */
function matchesKeyword(token, keywords) {
  return keywords.some((keyword) => token === keyword);
}

function semanticTokens(url) {
  const filename = getFilename(url).toLowerCase();
  const stem = filename.replace(/\.xml$/, '');
  return stem
    .split(/[-_]/)
    .map((part) => part.replace(/\d+$/, '')) // strip trailing pagination digits
    .filter((part) => !NOISE_TOKENS.has(part));
}

function getFilename(url) {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split('/').filter(Boolean);
    return decodeURIComponent(segments[segments.length - 1] || '');
  } catch {
    // Not a parseable absolute URL — fall back to the raw string's last
    // path-like segment so classification degrades gracefully rather
    // than throwing.
    const segments = String(url).split('/').filter(Boolean);
    return segments[segments.length - 1] || '';
  }
}

module.exports = { classifyChildSitemap, classifySitemapContentType };

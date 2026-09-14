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

const INCLUDE_KEYWORDS = ['page', 'pages', 'post', 'posts'];

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

function matchesKeyword(token, keywords) {
  return keywords.some((keyword) => token === keyword || token.startsWith(keyword));
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

module.exports = { classifyChildSitemap };

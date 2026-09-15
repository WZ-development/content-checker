'use strict';

const FALLBACK_LABEL = 'Home';

/**
 * Derives a readable label from a URL's last path segment (requirement
 * 8) — the fallback used whenever an actual `<title>` fetch fails, times
 * out, returns non-HTML, or is skipped by the concurrency cap. A failed
 * title fetch must never fail the scan or drop the item from the
 * results; this is what keeps the item presentable regardless.
 *
 *   /news/q3-earnings/    -> "Q3 Earnings"   (hyphens)
 *   /about_our_team/      -> "About Our Team" (underscores)
 *   /blog/caf%C3%A9-guide/ -> "Café Guide"    (percent-encoding)
 *
 * Never throws: an unparseable URL or a root path with no segment at
 * all falls back to a fixed label rather than producing an empty or
 * broken string.
 */
function deriveSlugTitle(rawUrl) {
  const segment = lastPathSegment(rawUrl);
  if (!segment) return FALLBACK_LABEL;

  const decoded = safeDecode(segment);
  const words = decoded.split(/[-_]+/).filter(Boolean);
  if (words.length === 0) return FALLBACK_LABEL;

  return words.map(capitalizeFirst).join(' ');
}

function lastPathSegment(rawUrl) {
  let pathname;
  try {
    pathname = new URL(rawUrl).pathname;
  } catch {
    pathname = String(rawUrl || '');
  }
  const segments = pathname.split('/').filter(Boolean);
  return segments[segments.length - 1] || '';
}

function safeDecode(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    // Malformed percent-encoding (e.g. a lone '%') — use the raw
    // segment rather than throwing away the whole title.
    return segment;
  }
}

function capitalizeFirst(word) {
  if (word.length === 0) return word;
  return word.charAt(0).toUpperCase() + word.slice(1);
}

module.exports = { deriveSlugTitle };

'use strict';

// Spaces required on both sides deliberately — a bare hyphen inside a
// compound word ("co-op", "well-known") has no surrounding spaces and
// must never be mistaken for a site-name separator.
const SEPARATORS = [' - ', ' | '];

/**
 * Strips a trailing site-name suffix from a fetched `<title>` (e.g.
 * "Q3 Earnings Report - Acme Inc" -> "Q3 Earnings Report"), requirement
 * 6. There is no known site name to match against — only the raw title
 * string — so this is necessarily a heuristic, and a conservative one:
 * it only acts when a separator (" - " or " | ") appears EXACTLY ONCE in
 * the title. Real `<title>` tags overwhelmingly follow "Page Title -
 * Site Name" with the site name last and the separator appearing once;
 * a title with the separator appearing more than once is ambiguous about
 * which occurrence (if any) is the real site-name boundary, and guessing
 * wrong there risks truncating content that legitimately contains that
 * punctuation mid-sentence — the exact failure mode the acceptance
 * criterion names. Left untouched in that case, on the principle that
 * under-stripping (an ugly but intact title) is far less harmful than
 * over-stripping (silently losing part of a real title).
 */
function stripTitleSuffix(title) {
  if (typeof title !== 'string') return title;

  for (const separator of SEPARATORS) {
    const firstIndex = title.indexOf(separator);
    if (firstIndex === -1) continue;
    if (title.indexOf(separator, firstIndex + 1) !== -1) continue; // appears more than once — ambiguous, don't touch

    return title.slice(0, firstIndex).trim();
  }

  return title;
}

module.exports = { stripTitleSuffix };

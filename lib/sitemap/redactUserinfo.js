'use strict';

/**
 * Sprint 4 carry-forward fix (I, QA1's Sprint 3 audit): a manualSitemapUrl
 * (or, less commonly, a baseUrl) containing userinfo
 * (https://user:pass@host/...) was echoed verbatim into error text and
 * discovery's attempts log. Strips userinfo from every URL-shaped
 * substring found anywhere in `text` — not just from a string that IS a
 * single bare URL. That's deliberate: the actual leak this closes runs
 * through fetch()'s own TypeError ("Request cannot be constructed from a
 * URL that includes credentials: <url>"), whose message is a longer
 * sentence with the credential URL embedded partway through it, not the
 * URL alone — a check that only handled `new URL(text)` parsing cleanly
 * would miss exactly the case that matters.
 *
 * Used at every point in this module where a URL or an error's message
 * text is about to be stored somewhere a caller might log or render it:
 * errors.js's typed error classes, and discovery.js's attempts log.
 */
function redactUserinfo(text) {
  if (typeof text !== 'string') return text;
  return text.replace(/\/\/[^\s/@]+@/g, '//');
}

module.exports = { redactUserinfo };

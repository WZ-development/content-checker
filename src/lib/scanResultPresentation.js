'use strict';

const { deriveSlugTitle } = require('../../lib/compare/slug');

/**
 * Splits a list of items (from either a full comparison group or a raw
 * single-side listing) by their sourceType — requirement 4: "pages and
 * posts are grouped separately within each [section]." An item with no
 * determinable sourceType (an unenclosed root urlset — see lib/sitemap/
 * crawl.js) goes in `other` rather than being silently dropped from
 * either bucket.
 */
function groupBySourceType(items) {
  const pages = [];
  const posts = [];
  const other = [];
  for (const item of items) {
    if (item.sourceType === 'page') pages.push(item);
    else if (item.sourceType === 'post') posts.push(item);
    else other.push(item);
  }
  return { pages, posts, other };
}

/**
 * Builds display-ready items for the PARTIAL-result path (requirement
 * 11): the successful side's raw discovered URLs, never a computed
 * diff — a diff needs both sides, and treating an entirely-failed side
 * as "zero URLs" would falsely flag every one of the other side's pages
 * as "at risk." No title was ever fetched here (title resolution only
 * runs once both sides succeed), so every item is slug-derived and
 * marked that way, same as any other approximate title in the app.
 */
function buildRawSideItems(sitemapResult) {
  return sitemapResult.urls.map((entry) => ({
    url: entry.loc,
    sourceType: entry.sourceType,
    title: deriveSlugTitle(entry.loc),
    titleSource: 'slug',
  }));
}

// QA1's Sprint 5 audit, finding C: a sitemap that was skipped for one of
// these reasons means real content may never have been examined at
// all — the comparison (or the zero-difference "safe to push" message)
// can be silently wrong. 'excluded-content-type' is deliberately NOT
// here: every normal WordPress site produces several (product/category/
// author/tag/media sitemaps), and a warning that always fires trains
// nobody to read it. 'invalid-url-scheme' (this same sprint's finding
// A) is also excluded — that's a deliberate security drop, not missing
// data.
const CONCERNING_SKIP_PREFIXES = ['fetch-failed:', 'parse-failed:', 'truncated:'];
const CONCERNING_SKIP_REASONS = new Set(['invalid-url', 'max-depth-exceeded']);

function isConcerningSkipReason(reason) {
  if (typeof reason !== 'string') return false;
  if (CONCERNING_SKIP_REASONS.has(reason)) return true;
  return CONCERNING_SKIP_PREFIXES.some((prefix) => reason.startsWith(prefix));
}

/**
 * Summarizes every "this comparison might not be the full picture"
 * signal from one or two sitemap sides (requirement 8) — truncation,
 * concerning skips, AND ambiguous sitemaps (Sprint 3 requirement 6's
 * "included, but unsure — check it" list, which was being carried all
 * the way to `completeness.*.ambiguous` and then never rendered). All
 * three must render ALONGSIDE results, never instead of them — including
 * alongside an otherwise-clean zero-difference message, which must
 * never stand alone when one of these fired.
 *
 * `sides`: `{ live?: {truncated, skipped, ambiguous}, staging?: {...} }`
 * — accepts either a full sitemapResult or just the completeness slice
 * of one (both carry the same three fields). Only sides actually
 * present are summarized, so the partial-result path (only one side
 * ran) works the same way as the full success path.
 */
function summarizeCompleteness(sides) {
  const truncatedSides = [];
  const skippedWarnings = {};
  const ambiguousNotes = {};

  for (const [side, result] of Object.entries(sides)) {
    if (!result) continue;

    if (result.truncated) truncatedSides.push(side);

    const concerning = (result.skipped || []).filter((entry) => isConcerningSkipReason(entry.reason));
    if (concerning.length > 0) skippedWarnings[side] = concerning;

    if ((result.ambiguous || []).length > 0) ambiguousNotes[side] = result.ambiguous;
  }

  const hasConcern =
    truncatedSides.length > 0 || Object.keys(skippedWarnings).length > 0 || Object.keys(ambiguousNotes).length > 0;

  return { hasConcern, truncatedSides, skippedWarnings, ambiguousNotes };
}

module.exports = { groupBySourceType, buildRawSideItems, summarizeCompleteness, isConcerningSkipReason };

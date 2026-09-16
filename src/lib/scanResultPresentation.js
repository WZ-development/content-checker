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

module.exports = { groupBySourceType, buildRawSideItems };

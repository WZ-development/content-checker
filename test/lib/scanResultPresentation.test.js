'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { groupBySourceType, buildRawSideItems, summarizeCompleteness, isConcerningSkipReason } = require('../../src/lib/scanResultPresentation');

describe('groupBySourceType', () => {
  test('splits items into pages, posts, and other', () => {
    const items = [
      { url: 'https://x.test/a/', sourceType: 'page' },
      { url: 'https://x.test/b/', sourceType: 'post' },
      { url: 'https://x.test/c/', sourceType: undefined },
    ];
    const grouped = groupBySourceType(items);
    assert.equal(grouped.pages.length, 1);
    assert.equal(grouped.posts.length, 1);
    assert.equal(grouped.other.length, 1);
    assert.equal(grouped.pages[0].url, 'https://x.test/a/');
  });

  test('an empty list produces three empty groups, not an error', () => {
    const grouped = groupBySourceType([]);
    assert.deepEqual(grouped, { pages: [], posts: [], other: [] });
  });
});

describe('buildRawSideItems', () => {
  test('derives a slug title for every URL and marks it as slug-derived', () => {
    const sitemapResult = {
      urls: [
        { loc: 'https://x.test/news/q3-earnings/', sourceType: 'post' },
        { loc: 'https://x.test/about/', sourceType: 'page' },
      ],
    };
    const items = buildRawSideItems(sitemapResult);
    assert.equal(items.length, 2);
    assert.equal(items[0].title, 'Q3 Earnings');
    assert.equal(items[0].titleSource, 'slug');
    assert.equal(items[0].sourceType, 'post');
    assert.equal(items[1].title, 'About');
  });

  test('an empty urls array produces an empty list', () => {
    assert.deepEqual(buildRawSideItems({ urls: [] }), []);
  });
});

describe('isConcerningSkipReason (QA1 Sprint 5 audit, finding C)', () => {
  test('flags fetch-failed, parse-failed, truncated, invalid-url, and max-depth-exceeded', () => {
    assert.equal(isConcerningSkipReason('fetch-failed:HTTP_404'), true);
    assert.equal(isConcerningSkipReason('parse-failed:MALFORMED_XML'), true);
    assert.equal(isConcerningSkipReason('truncated:cap'), true);
    assert.equal(isConcerningSkipReason('truncated:budget'), true);
    assert.equal(isConcerningSkipReason('invalid-url'), true);
    assert.equal(isConcerningSkipReason('max-depth-exceeded'), true);
  });

  test('does NOT flag excluded-content-type — it always fires on a normal site and would train nobody to read it', () => {
    assert.equal(isConcerningSkipReason('excluded-content-type'), false);
  });

  test('does NOT flag invalid-url-scheme — a deliberate security drop, not missing data', () => {
    assert.equal(isConcerningSkipReason('invalid-url-scheme'), false);
  });

  test('handles non-string / missing reasons without throwing', () => {
    assert.equal(isConcerningSkipReason(undefined), false);
    assert.equal(isConcerningSkipReason(null), false);
  });
});

describe('summarizeCompleteness (QA1 Sprint 5 audit, finding C)', () => {
  test('no concern when both sides are clean', () => {
    const summary = summarizeCompleteness({
      live: { truncated: false, skipped: [], ambiguous: [] },
      staging: { truncated: false, skipped: [], ambiguous: [] },
    });
    assert.equal(summary.hasConcern, false);
    assert.deepEqual(summary.truncatedSides, []);
    assert.deepEqual(summary.skippedWarnings, {});
    assert.deepEqual(summary.ambiguousNotes, {});
  });

  test('reports truncated sides', () => {
    const summary = summarizeCompleteness({
      live: { truncated: true, skipped: [], ambiguous: [] },
      staging: { truncated: false, skipped: [], ambiguous: [] },
    });
    assert.equal(summary.hasConcern, true);
    assert.deepEqual(summary.truncatedSides, ['live']);
  });

  test('a fetch-failed skip produces a concern — the exact false-alarm/silent-loss scenario QA1 demonstrated', () => {
    const summary = summarizeCompleteness({
      staging: {
        truncated: false,
        skipped: [{ url: 'https://staging.test/post-sitemap2.xml', reason: 'fetch-failed:HTTP_404' }],
        ambiguous: [],
      },
    });
    assert.equal(summary.hasConcern, true);
    assert.equal(summary.skippedWarnings.staging.length, 1);
    assert.equal(summary.skippedWarnings.staging[0].url, 'https://staging.test/post-sitemap2.xml');
  });

  test('excluded-content-type skips alone do NOT trigger a concern', () => {
    const summary = summarizeCompleteness({
      live: {
        truncated: false,
        skipped: [
          { url: 'https://live.test/product-sitemap.xml', reason: 'excluded-content-type' },
          { url: 'https://live.test/media-sitemap.xml', reason: 'excluded-content-type' },
        ],
        ambiguous: [],
      },
    });
    assert.equal(summary.hasConcern, false);
    assert.deepEqual(summary.skippedWarnings, {});
  });

  test('an ambiguous sitemap alone triggers a concern, even with zero truncation/skips', () => {
    const summary = summarizeCompleteness({
      live: { truncated: false, skipped: [], ambiguous: [{ url: 'https://live.test/gallery-sitemap.xml', reason: 'unrecognized-naming-convention' }] },
      staging: { truncated: false, skipped: [], ambiguous: [{ url: 'https://staging.test/gallery-sitemap.xml', reason: 'unrecognized-naming-convention' }] },
    });
    assert.equal(summary.hasConcern, true);
    assert.equal(summary.ambiguousNotes.live.length, 1);
    assert.equal(summary.ambiguousNotes.staging.length, 1);
  });

  test('only sides actually present are summarized (the partial-result path has just one)', () => {
    const summary = summarizeCompleteness({
      live: { truncated: true, skipped: [], ambiguous: [] },
    });
    assert.deepEqual(summary.truncatedSides, ['live']);
    assert.equal(summary.hasConcern, true);
  });
});

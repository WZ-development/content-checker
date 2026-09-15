'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { compareSitemaps } = require('../../lib/compare/compare');

function sitemapResult(urls, overrides = {}) {
  return { urls, truncated: false, ambiguous: [], skipped: [], consulted: [], ...overrides };
}

describe('compareSitemaps is pure — no network of any kind', () => {
  test('the module imports nothing that could perform I/O', () => {
    // QA1's own stated check is "run the comparison tests with
    // networking unavailable" — this is the structural guarantee that
    // makes that possible at all: no fetch, no dns, no node:http/https
    // anywhere in the module's own source.
    const contents = fs.readFileSync(path.join(__dirname, '..', '..', 'lib', 'compare', 'compare.js'), 'utf8');
    assert.ok(!/require\(['"]node:(dns|http|https|net)['"]\)/.test(contents));
    assert.ok(!/\bfetch\(/.test(contents));
  });
});

describe('classification into exactly three groups (requirement 4)', () => {
  test('a fixture with all three groups non-empty', () => {
    const live = sitemapResult([
      { loc: 'https://live.test/only-on-live/', sourceType: 'page' },
      { loc: 'https://live.test/shared-1/' },
      { loc: 'https://live.test/shared-2/' },
    ]);
    const staging = sitemapResult([
      { loc: 'https://staging.test/shared-1/' },
      { loc: 'https://staging.test/shared-2/' },
      { loc: 'https://staging.test/only-on-staging/', sourceType: 'post' },
    ]);

    const result = compareSitemaps({ live, staging });

    assert.equal(result.onLiveOnly.length, 1);
    assert.equal(result.onLiveOnly[0].url, 'https://live.test/only-on-live/');
    assert.equal(result.onStagingOnly.length, 1);
    assert.equal(result.onStagingOnly[0].url, 'https://staging.test/only-on-staging/');
    assert.equal(result.onBothCount, 2);
  });

  test('the on-both set is counted but never materialized as a displayable list', () => {
    const live = sitemapResult([{ loc: 'https://live.test/shared/' }]);
    const staging = sitemapResult([{ loc: 'https://staging.test/shared/' }]);
    const result = compareSitemaps({ live, staging });

    assert.equal(result.onBothCount, 1);
    assert.ok(!('onBoth' in result), 'no onBoth array should exist on the result at all');
  });

  test('empty staging set: everything on live is onLiveOnly', () => {
    const live = sitemapResult([{ loc: 'https://live.test/a/' }, { loc: 'https://live.test/b/' }]);
    const staging = sitemapResult([]);
    const result = compareSitemaps({ live, staging });

    assert.equal(result.onLiveOnly.length, 2);
    assert.equal(result.onStagingOnly.length, 0);
    assert.equal(result.onBothCount, 0);
  });

  test('empty live set: everything on staging is onStagingOnly', () => {
    const live = sitemapResult([]);
    const staging = sitemapResult([{ loc: 'https://staging.test/a/' }]);
    const result = compareSitemaps({ live, staging });

    assert.equal(result.onLiveOnly.length, 0);
    assert.equal(result.onStagingOnly.length, 1);
    assert.equal(result.onBothCount, 0);
  });

  test('both sets empty: no error, all zeros', () => {
    const result = compareSitemaps({ live: sitemapResult([]), staging: sitemapResult([]) });
    assert.deepEqual(result.onLiveOnly, []);
    assert.deepEqual(result.onStagingOnly, []);
    assert.equal(result.onBothCount, 0);
  });

  test('matching uses the normalized comparison key, not the raw URL — different hosts, same content', () => {
    const live = sitemapResult([{ loc: 'https://clientdomain.com/About/' }]);
    const staging = sitemapResult([{ loc: 'https://staging.clientdomain.com/about/#team' }]);
    const result = compareSitemaps({ live, staging });

    assert.equal(result.onBothCount, 1, 'these must match despite differing host, case, and fragment');
    assert.equal(result.onLiveOnly.length, 0);
    assert.equal(result.onStagingOnly.length, 0);
  });
});

describe('sourceType passthrough (requirement 5)', () => {
  test('each item carries the sourceType from its sitemap entry', () => {
    const live = sitemapResult([{ loc: 'https://live.test/a/', sourceType: 'page' }]);
    const staging = sitemapResult([{ loc: 'https://staging.test/b/', sourceType: 'post' }]);
    const result = compareSitemaps({ live, staging });

    assert.equal(result.onLiveOnly[0].sourceType, 'page');
    assert.equal(result.onStagingOnly[0].sourceType, 'post');
  });

  test('an entry with no sourceType (unknown) carries through as undefined, not a guess', () => {
    const live = sitemapResult([{ loc: 'https://live.test/a/' }]);
    const staging = sitemapResult([]);
    const result = compareSitemaps({ live, staging });

    assert.equal(result.onLiveOnly[0].sourceType, undefined);
  });
});

describe('completeness signals survive into the comparison output (requirement 10)', () => {
  test('truncated is true when EITHER side was truncated', () => {
    const live = sitemapResult([], { truncated: true });
    const staging = sitemapResult([], { truncated: false });
    assert.equal(compareSitemaps({ live, staging }).truncated, true);
  });

  test('truncated is false only when BOTH sides completed fully', () => {
    const live = sitemapResult([], { truncated: false });
    const staging = sitemapResult([], { truncated: false });
    assert.equal(compareSitemaps({ live, staging }).truncated, false);
  });

  test('ambiguous and skipped are carried through per side, not merged or dropped', () => {
    const live = sitemapResult([], { ambiguous: [{ url: 'https://live.test/gallery.xml' }] });
    const staging = sitemapResult([], { skipped: [{ url: 'https://staging.test/broken.xml', reason: 'fetch-failed' }] });
    const result = compareSitemaps({ live, staging });

    assert.equal(result.completeness.live.ambiguous.length, 1);
    assert.equal(result.completeness.staging.ambiguous.length, 0);
    assert.equal(result.completeness.staging.skipped.length, 1);
    assert.equal(result.completeness.live.skipped.length, 0);
  });

  test('a truncated result never presents with truncated: false', () => {
    // The direct statement of the risk requirement 10 exists to
    // mitigate: a partial live crawl compared against a complete
    // staging crawl must never look like a clean, complete diff.
    const live = sitemapResult([{ loc: 'https://live.test/a/' }], { truncated: true });
    const staging = sitemapResult([{ loc: 'https://staging.test/a/' }], { truncated: false });
    const result = compareSitemaps({ live, staging });

    assert.equal(result.truncated, true);
  });
});

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { groupBySourceType, buildRawSideItems } = require('../../src/lib/scanResultPresentation');

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

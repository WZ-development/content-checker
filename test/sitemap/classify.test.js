'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { classifyChildSitemap, classifySitemapContentType } = require('../../lib/sitemap/classify');

describe('classifyChildSitemap', () => {
  describe('include — page/post content under any observed naming convention', () => {
    const includeCases = [
      'https://example.test/page-sitemap.xml',
      'https://example.test/post-sitemap.xml',
      'https://example.test/post-sitemap2.xml', // Yoast pagination
      'https://example.test/page-sitemap12.xml',
      'https://example.test/sitemap-page-1.xml', // TechCrunch style
      'https://example.test/sitemap-page-2057.xml',
      'https://example.test/wp-sitemap-posts-post-1.xml', // WordPress core
      'https://example.test/wp-sitemap-posts-page-1.xml',
    ];
    for (const url of includeCases) {
      test(`includes ${url}`, () => {
        assert.equal(classifyChildSitemap(url), 'include');
      });
    }
  });

  describe('exclude — other content types per PRD §4.4', () => {
    const excludeCases = [
      'https://example.test/product-sitemap.xml',
      'https://example.test/product-sitemap2.xml',
      'https://example.test/category-sitemap.xml',
      'https://example.test/author-sitemap.xml',
      'https://example.test/tag-sitemap.xml',
      'https://example.test/media-sitemap.xml',
      'https://example.test/attachment-sitemap.xml',
      'https://example.test/wp-sitemap-taxonomies-category-1.xml',
      'https://example.test/wp-sitemap-users-1.xml',
    ];
    for (const url of excludeCases) {
      test(`excludes ${url}`, () => {
        assert.equal(classifyChildSitemap(url), 'exclude');
      });
    }
  });

  test('flags an unrecognized naming convention as ambiguous rather than dropping it', () => {
    assert.equal(classifyChildSitemap('https://example.test/gallery-sitemap.xml'), 'ambiguous');
  });

  test('exclusion wins over inclusion when a filename could plausibly match either', () => {
    // Defensive: a hypothetical filename combining an excluded and an
    // included token must not be pulled in just because it also
    // contains a plausible-looking token.
    assert.equal(classifyChildSitemap('https://example.test/author-post-sitemap.xml'), 'exclude');
  });

  test('is case-insensitive', () => {
    assert.equal(classifyChildSitemap('https://example.test/POST-Sitemap.XML'), 'include');
  });

  test('degrades gracefully on an unparseable URL rather than throwing', () => {
    assert.doesNotThrow(() => classifyChildSitemap('not a url at all'));
  });

  describe('exact-token matching (sprint 4 carry-forward fix G)', () => {
    // Previously matched by PREFIX (token.startsWith(keyword)), so a
    // token that merely shares a leading substring with a keyword was
    // wrongly excluded/included despite naming unrelated content.
    test('does not exclude a token that only shares a prefix with an exclude keyword', () => {
      // 'producthunt' starts with 'product' but is not the token
      // 'product' or 'products' — must not be excluded on that basis.
      // No other token matches either list, so this lands as ambiguous:
      // included, and flagged for a human to check, never silently
      // dropped as if it were confidently known to be product content.
      assert.equal(classifyChildSitemap('https://example.test/producthunt-sitemap.xml'), 'ambiguous');
    });

    test('does not include a token that only shares a prefix with an include keyword', () => {
      // 'pageant' starts with 'page' but is not the token 'page' or
      // 'pages' — must not be pulled in as page content on that basis.
      assert.equal(classifyChildSitemap('https://example.test/pageant-sitemap.xml'), 'ambiguous');
    });

    test('still matches the real keyword exactly once pagination digits and separators are stripped', () => {
      // Confirms the fix didn't overcorrect into never matching
      // anything — 'post' alone still matches 'post' exactly.
      assert.equal(classifyChildSitemap('https://example.test/post-sitemap.xml'), 'include');
    });
  });
});

describe('classifySitemapContentType (sprint 4, requirement 5)', () => {
  test('names "page" for a page sitemap, under any naming convention', () => {
    assert.equal(classifySitemapContentType('https://example.test/page-sitemap.xml'), 'page');
    assert.equal(classifySitemapContentType('https://example.test/sitemap-page-1.xml'), 'page');
    assert.equal(classifySitemapContentType('https://example.test/wp-sitemap-posts-page-1.xml'), 'page');
  });

  test('names "post" for a post sitemap, under any naming convention', () => {
    assert.equal(classifySitemapContentType('https://example.test/post-sitemap.xml'), 'post');
    assert.equal(classifySitemapContentType('https://example.test/post-sitemap2.xml'), 'post');
    assert.equal(classifySitemapContentType('https://example.test/wp-sitemap-posts-post-1.xml'), 'post');
  });

  test('returns undefined for an excluded sitemap', () => {
    assert.equal(classifySitemapContentType('https://example.test/product-sitemap.xml'), undefined);
  });

  test('returns undefined for an ambiguous sitemap', () => {
    assert.equal(classifySitemapContentType('https://example.test/gallery-sitemap.xml'), undefined);
  });

  test('is exact-token matched, same as classifyChildSitemap (fix G applies here too)', () => {
    assert.equal(classifySitemapContentType('https://example.test/pageant-sitemap.xml'), undefined);
  });
});

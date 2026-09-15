'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { classifyChildSitemap } = require('../../lib/sitemap/classify');

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
});

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { parseSitemapXml } = require('../../lib/sitemap/xml');
const { NonXmlResponseError, MalformedXmlError } = require('../../lib/sitemap/errors');
const { loadFixture } = require('./testHarness');

describe('parseSitemapXml', () => {
  test('parses a sitemap index into type "index" with child URLs', () => {
    const result = parseSitemapXml(loadFixture('sitemap-index-basic.xml'));
    assert.equal(result.type, 'index');
    assert.deepEqual(result.entries, [
      'https://example.test/page-sitemap.xml',
      'https://example.test/post-sitemap.xml',
    ]);
  });

  test('parses a urlset into type "urlset" with loc + lastmod, handling the XML declaration, a processing instruction, namespaces, and image: children', () => {
    const result = parseSitemapXml(loadFixture('page-sitemap.xml'));
    assert.equal(result.type, 'urlset');
    assert.deepEqual(result.entries, [
      { loc: 'https://example.test/about/', lastmod: '2026-01-05T12:00:00+00:00' },
      { loc: 'https://example.test/contact/', lastmod: '2026-01-06T09:30:00+00:00' },
    ]);
  });

  test('parses an empty urlset as zero entries, not an error', () => {
    const result = parseSitemapXml(loadFixture('empty-urlset.xml'));
    assert.equal(result.type, 'urlset');
    assert.deepEqual(result.entries, []);
  });

  test('throws MalformedXmlError on truncated/broken XML', () => {
    assert.throws(() => parseSitemapXml(loadFixture('malformed.xml')), (err) => {
      assert.ok(err instanceof MalformedXmlError);
      assert.equal(err.code, 'MALFORMED_XML');
      return true;
    });
  });

  test('throws NonXmlResponseError on an HTML body (a 404 page mislabeled or not)', () => {
    assert.throws(() => parseSitemapXml(loadFixture('not-found.html')), (err) => {
      assert.ok(err instanceof NonXmlResponseError);
      assert.equal(err.code, 'NON_XML_RESPONSE');
      return true;
    });
  });

  test('throws NonXmlResponseError on a plain-text body', () => {
    assert.throws(() => parseSitemapXml('Not Found'), (err) => {
      assert.ok(err instanceof NonXmlResponseError);
      return true;
    });
  });

  test('throws NonXmlResponseError on an empty body', () => {
    assert.throws(() => parseSitemapXml(''), (err) => {
      assert.ok(err instanceof NonXmlResponseError);
      return true;
    });
  });

  test('throws NonXmlResponseError on well-formed XML with an unrecognized root element', () => {
    assert.throws(() => parseSitemapXml('<?xml version="1.0"?><rss><channel/></rss>'), (err) => {
      assert.ok(err instanceof NonXmlResponseError);
      return true;
    });
  });

  test('treats an unparseable-shaped body as non-XML even under an HTML content-type', () => {
    assert.throws(
      () => parseSitemapXml('<div>oops</div>', { contentType: 'text/html; charset=utf-8' }),
      (err) => {
        assert.ok(err instanceof NonXmlResponseError);
        return true;
      }
    );
  });

  test('a VALID sitemap body is accepted regardless of a misleading content-type header (QA1 round 1, finding E)', () => {
    // A misconfigured server can send a legitimate urlset with the wrong
    // Content-Type. Content-type must never veto a body that actually
    // parses — doing so drops a good sitemap, the highest-severity
    // failure direction this project defends against.
    const result = parseSitemapXml(loadFixture('empty-urlset.xml'), { contentType: 'text/html; charset=UTF-8' });
    assert.equal(result.type, 'urlset');
  });

  test('uses content-type only as a tiebreaker when the body fails to validate at all', () => {
    // Truncated XML that ALSO claims an HTML content-type is classified
    // as non-XML (more likely a mislabeled HTML error page) rather than
    // malformed XML.
    assert.throws(
      () => parseSitemapXml(loadFixture('malformed.xml'), { contentType: 'text/html; charset=UTF-8' }),
      (err) => {
        assert.ok(err instanceof NonXmlResponseError);
        return true;
      }
    );
    // The SAME broken body, without the HTML content-type, is still
    // reported as malformed XML, not non-XML.
    assert.throws(() => parseSitemapXml(loadFixture('malformed.xml')), (err) => {
      assert.ok(err instanceof MalformedXmlError);
      return true;
    });
  });

  test('strips a leading BOM before parsing', () => {
    const withBom = '﻿' + loadFixture('empty-urlset.xml');
    const result = parseSitemapXml(withBom);
    assert.equal(result.type, 'urlset');
  });

  test('handles a single <sitemap> entry without an array wrapper', () => {
    const xml = `<?xml version="1.0"?><sitemapindex><sitemap><loc>https://example.test/only.xml</loc></sitemap></sitemapindex>`;
    const result = parseSitemapXml(xml);
    assert.equal(result.type, 'index');
    assert.deepEqual(result.entries, ['https://example.test/only.xml']);
  });

  test('handles a single <url> entry without an array wrapper', () => {
    const xml = `<?xml version="1.0"?><urlset><url><loc>https://example.test/solo/</loc></url></urlset>`;
    const result = parseSitemapXml(xml);
    assert.equal(result.type, 'urlset');
    assert.deepEqual(result.entries, [{ loc: 'https://example.test/solo/', lastmod: undefined }]);
  });
});

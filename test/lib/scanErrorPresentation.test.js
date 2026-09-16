'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { describeSitemapError } = require('../../src/lib/scanErrorPresentation');
const { errors } = require('../../lib/sitemap/index');

describe('describeSitemapError', () => {
  test('a 401/403 on the staging side names .htaccess and includes the edit link (requirement 10)', () => {
    const result = describeSitemapError(new errors.HttpAuthError('https://staging.test/sitemap.xml', 401), {
      side: 'staging',
      editUrl: '/projects/abc/edit',
    });
    assert.match(result.message, /\.htaccess/);
    assert.equal(result.editUrl, '/projects/abc/edit');
  });

  test('a 403 on the staging side is treated the same as 401', () => {
    const result = describeSitemapError(new errors.HttpAuthError('https://staging.test/sitemap.xml', 403), {
      side: 'staging',
      editUrl: '/projects/abc/edit',
    });
    assert.match(result.message, /\.htaccess/);
  });

  test('a 401 on the live side does not offer an edit link (no live credential field exists)', () => {
    const result = describeSitemapError(new errors.HttpAuthError('https://live.test/sitemap.xml', 401), {
      side: 'live',
    });
    assert.doesNotMatch(result.message, /\.htaccess/);
    assert.equal(result.editUrl, undefined);
  });

  test('discovery failure with no auth-coded attempts prompts for a manual sitemap URL', () => {
    const result = describeSitemapError(new errors.SitemapDiscoveryFailedError([]), { side: 'live' });
    assert.match(result.message, /paste a sitemap url/i);
  });

  describe('QA1 Sprint 5 audit, finding B — a 401/403 buried in the discovery attempts log', () => {
    test('staging discovery where every attempt 401s produces the .htaccess message and edit link, not the generic prompt', () => {
      const attempts = [
        { url: 'https://staging.test/robots.txt', method: 'robots.txt', ok: false, error: 'HTTP_401' },
        { url: 'https://staging.test/sitemap_index.xml', method: 'candidate', ok: false, error: 'HTTP_401' },
        { url: 'https://staging.test/wp-sitemap.xml', method: 'candidate', ok: false, error: 'HTTP_401' },
        { url: 'https://staging.test/sitemap.xml', method: 'candidate', ok: false, error: 'HTTP_401' },
      ];
      const result = describeSitemapError(new errors.SitemapDiscoveryFailedError(attempts), {
        side: 'staging',
        editUrl: '/projects/abc/edit',
      });
      assert.match(result.message, /\.htaccess/);
      assert.equal(result.editUrl, '/projects/abc/edit');
      assert.doesNotMatch(result.message, /paste a sitemap url/i);
    });

    test('a SINGLE auth-coded attempt among otherwise-generic failures is enough — the more permissive, catching rule', () => {
      // e.g. robots.txt is public but the sitemap itself is protected.
      const attempts = [
        { url: 'https://staging.test/robots.txt', method: 'robots.txt', ok: false, error: 'ENOTFOUND' },
        { url: 'https://staging.test/sitemap_index.xml', method: 'candidate', ok: false, error: 'HTTP_401' },
        { url: 'https://staging.test/wp-sitemap.xml', method: 'candidate', ok: false, error: 'HTTP_404' },
      ];
      const result = describeSitemapError(new errors.SitemapDiscoveryFailedError(attempts), {
        side: 'staging',
        editUrl: '/projects/abc/edit',
      });
      assert.match(result.message, /\.htaccess/);
    });

    test('a 403-coded attempt is treated the same as 401', () => {
      const attempts = [{ url: 'https://staging.test/sitemap.xml', method: 'candidate', ok: false, error: 'HTTP_403' }];
      const result = describeSitemapError(new errors.SitemapDiscoveryFailedError(attempts), {
        side: 'staging',
        editUrl: '/projects/abc/edit',
      });
      assert.match(result.message, /\.htaccess/);
    });

    test('an auth-coded discovery failure on the LIVE side does not offer an edit link', () => {
      const attempts = [{ url: 'https://live.test/sitemap.xml', method: 'candidate', ok: false, error: 'HTTP_401' }];
      const result = describeSitemapError(new errors.SitemapDiscoveryFailedError(attempts), { side: 'live' });
      assert.doesNotMatch(result.message, /\.htaccess/);
      assert.equal(result.editUrl, undefined);
    });

    test('discovery failure with NO auth-coded attempts still gets the generic prompt, not a false credentials claim', () => {
      const attempts = [
        { url: 'https://staging.test/robots.txt', method: 'robots.txt', ok: false, error: 'ENOTFOUND' },
        { url: 'https://staging.test/sitemap_index.xml', method: 'candidate', ok: false, error: 'HTTP_404' },
      ];
      const result = describeSitemapError(new errors.SitemapDiscoveryFailedError(attempts), {
        side: 'staging',
        editUrl: '/projects/abc/edit',
      });
      assert.doesNotMatch(result.message, /\.htaccess/);
      assert.match(result.message, /paste a sitemap url/i);
    });
  });

  test('every named lib/sitemap error type produces a non-empty message', () => {
    const cases = [
      new errors.HttpNotFoundError('https://x.test/sitemap.xml'),
      new errors.DnsResolutionError('https://x.test/sitemap.xml', new Error('boom')),
      new errors.SsrfBlockedError('https://x.test/sitemap.xml', '127.0.0.1'),
      new errors.SitemapTimeoutError('https://x.test/sitemap.xml', 15000),
      new errors.BudgetExceededError('https://x.test/sitemap.xml'),
      new errors.TooManyRedirectsError('https://x.test/sitemap.xml', 5),
      new errors.NonXmlResponseError('https://x.test/sitemap.xml', 'text/plain', 'oops'),
      new errors.MalformedXmlError('https://x.test/sitemap.xml', new Error('bad xml')),
      new errors.ConnectionError('https://x.test/sitemap.xml', new Error('ECONNREFUSED')),
    ];
    for (const err of cases) {
      const result = describeSitemapError(err, { side: 'live' });
      assert.ok(result.message && result.message.length > 0, `expected a message for ${err.constructor.name}`);
    }
  });

  test('an unrecognized (non-SitemapError) exception still produces a generic, non-empty message rather than throwing', () => {
    const result = describeSitemapError(new Error('something totally unexpected'), { side: 'live' });
    assert.ok(result.message && result.message.length > 0);
  });

  test('never throws regardless of input shape', () => {
    assert.doesNotThrow(() => describeSitemapError(null, { side: 'live' }));
    assert.doesNotThrow(() => describeSitemapError(undefined, { side: 'staging' }));
  });
});

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { createGuardedFetch } = require('../../lib/sitemap/httpClient');
const {
  HttpAuthError,
  HttpNotFoundError,
  HttpResponseError,
  ConnectionError,
  SitemapTimeoutError,
  SsrfBlockedError,
  TooManyRedirectsError,
} = require('../../lib/sitemap/errors');
const { createFakeFetch, createFakeDnsLookup } = require('./testHarness');

const PUBLIC_DNS = { 'good.test': '93.184.216.34', 'other.test': '93.184.216.35', 'evil.test': '127.0.0.1' };

function makeGuardedFetch(routes, overrides = {}) {
  const fetchImpl = createFakeFetch(routes);
  const dnsLookup = overrides.dnsLookup || createFakeDnsLookup(overrides.dnsMap || PUBLIC_DNS);
  const guardedFetch = createGuardedFetch({
    fetchImpl,
    dnsLookup,
    timeoutMs: overrides.timeoutMs || 1000,
    auth: overrides.auth,
    userAgent: 'TestBot/1.0',
    maxRedirects: overrides.maxRedirects ?? 5,
  });
  return { guardedFetch, fetchImpl, log: fetchImpl.log };
}

describe('createGuardedFetch', () => {
  test('returns the body on a plain 200', async () => {
    const { guardedFetch } = makeGuardedFetch({ 'https://good.test/x.xml': { body: '<urlset></urlset>' } });
    const res = await guardedFetch('https://good.test/x.xml');
    assert.equal(res.body, '<urlset></urlset>');
    assert.equal(res.status, 200);
  });

  test('sends a descriptive User-Agent', async () => {
    const { guardedFetch, log } = makeGuardedFetch({ 'https://good.test/x.xml': { body: 'ok' } });
    await guardedFetch('https://good.test/x.xml');
    assert.equal(log[0].headers['User-Agent'], 'TestBot/1.0');
  });

  test('sends Authorization: Basic when auth is supplied', async () => {
    const { guardedFetch, log } = makeGuardedFetch(
      { 'https://good.test/x.xml': { body: 'ok' } },
      { auth: { username: 'dev', password: 'hunter2' } }
    );
    await guardedFetch('https://good.test/x.xml');
    const expected = `Basic ${Buffer.from('dev:hunter2').toString('base64')}`;
    assert.equal(log[0].headers.Authorization, expected);
  });

  test('does not send Authorization when auth is not supplied', async () => {
    const { guardedFetch, log } = makeGuardedFetch({ 'https://good.test/x.xml': { body: 'ok' } });
    await guardedFetch('https://good.test/x.xml');
    assert.equal(log[0].headers.Authorization, undefined);
  });

  describe('typed failures (requirement 11)', () => {
    test('401 is distinguishable from 404', async () => {
      const { guardedFetch } = makeGuardedFetch({
        'https://good.test/secure.xml': { status: 401 },
        'https://good.test/missing.xml': { status: 404 },
      });
      await assert.rejects(() => guardedFetch('https://good.test/secure.xml'), (err) => {
        assert.ok(err instanceof HttpAuthError);
        assert.equal(err.code, 'HTTP_401');
        return true;
      });
      await assert.rejects(() => guardedFetch('https://good.test/missing.xml'), (err) => {
        assert.ok(err instanceof HttpNotFoundError);
        assert.equal(err.code, 'HTTP_404');
        return true;
      });
    });

    test('403 is an HttpAuthError too', async () => {
      const { guardedFetch } = makeGuardedFetch({ 'https://good.test/forbidden.xml': { status: 403 } });
      await assert.rejects(() => guardedFetch('https://good.test/forbidden.xml'), (err) => {
        assert.ok(err instanceof HttpAuthError);
        assert.equal(err.code, 'HTTP_403');
        return true;
      });
    });

    test('other non-2xx statuses produce HttpResponseError', async () => {
      const { guardedFetch } = makeGuardedFetch({ 'https://good.test/broken.xml': { status: 500 } });
      await assert.rejects(() => guardedFetch('https://good.test/broken.xml'), (err) => {
        assert.ok(err instanceof HttpResponseError);
        assert.equal(err.status, 500);
        return true;
      });
    });

    test('a connection-level failure produces ConnectionError', async () => {
      const fetchImpl = async () => {
        throw Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' });
      };
      const guardedFetch = createGuardedFetch({
        fetchImpl,
        dnsLookup: createFakeDnsLookup(PUBLIC_DNS),
        timeoutMs: 1000,
        userAgent: 'TestBot/1.0',
        maxRedirects: 5,
      });
      await assert.rejects(() => guardedFetch('https://good.test/x.xml'), ConnectionError);
    });

    test('a request that exceeds the per-request timeout produces SitemapTimeoutError', async () => {
      const { guardedFetch } = makeGuardedFetch(
        { 'https://good.test/slow.xml': { body: 'ok', delayMs: 200 } },
        { timeoutMs: 20 }
      );
      await assert.rejects(() => guardedFetch('https://good.test/slow.xml'), (err) => {
        assert.ok(err instanceof SitemapTimeoutError);
        assert.equal(err.code, 'TIMEOUT');
        return true;
      });
    });
  });

  describe('redirects', () => {
    test('follows a redirect and returns the final body', async () => {
      const { guardedFetch } = makeGuardedFetch({
        'https://good.test/old.xml': { status: 301, headers: { location: 'https://good.test/new.xml' } },
        'https://good.test/new.xml': { body: 'final body' },
      });
      const res = await guardedFetch('https://good.test/old.xml');
      assert.equal(res.body, 'final body');
      assert.equal(res.url, 'https://good.test/new.xml');
    });

    test('forwards Authorization on a redirect to the SAME host', async () => {
      const { guardedFetch, log } = makeGuardedFetch(
        {
          'https://good.test/old.xml': { status: 302, headers: { location: 'https://good.test/new.xml' } },
          'https://good.test/new.xml': { body: 'ok' },
        },
        { auth: { username: 'dev', password: 'pw' } }
      );
      await guardedFetch('https://good.test/old.xml');
      assert.equal(log.length, 2);
      assert.ok(log[0].headers.Authorization, 'first request should carry auth');
      assert.ok(log[1].headers.Authorization, 'same-host redirect should carry auth too');
    });

    test('drops Authorization on a redirect to a DIFFERENT host', async () => {
      const { guardedFetch, log } = makeGuardedFetch(
        {
          'https://good.test/old.xml': { status: 302, headers: { location: 'https://other.test/new.xml' } },
          'https://other.test/new.xml': { body: 'ok' },
        },
        { auth: { username: 'dev', password: 'pw' } }
      );
      await guardedFetch('https://good.test/old.xml');
      assert.ok(log[0].headers.Authorization, 'first request should carry auth');
      assert.equal(log[1].headers.Authorization, undefined, 'cross-host redirect must not carry auth');
    });

    test('re-runs the SSRF check on the redirect target, not only the initial URL', async () => {
      const { guardedFetch } = makeGuardedFetch({
        'https://good.test/old.xml': { status: 302, headers: { location: 'https://evil.test/new.xml' } },
        'https://evil.test/new.xml': { body: 'should never be reached' },
      });
      await assert.rejects(() => guardedFetch('https://good.test/old.xml'), (err) => {
        assert.ok(err instanceof SsrfBlockedError);
        return true;
      });
    });

    test('gives up after too many redirect hops', async () => {
      const routes = {};
      for (let i = 0; i < 10; i += 1) {
        routes[`https://good.test/hop${i}.xml`] = {
          status: 302,
          headers: { location: `https://good.test/hop${i + 1}.xml` },
        };
      }
      const { guardedFetch } = makeGuardedFetch(routes, { maxRedirects: 3 });
      await assert.rejects(() => guardedFetch('https://good.test/hop0.xml'), TooManyRedirectsError);
    });
  });

  test('rejects the initial URL up front when it resolves to a private address', async () => {
    const { guardedFetch } = makeGuardedFetch({ 'https://evil.test/x.xml': { body: 'nope' } });
    await assert.rejects(() => guardedFetch('https://evil.test/x.xml'), SsrfBlockedError);
  });
});

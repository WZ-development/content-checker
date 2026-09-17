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
  CdnChallengeError,
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
    // Sprint 7 fix-loop (QA1 round 1 finding B): authOrigins must now be
    // supplied explicitly by every caller — see httpClient.js's doc
    // comment. Each auth-using test below passes the origin it actually
    // means to trust, rather than relying on any implicit default here.
    authOrigins: overrides.authOrigins,
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

  test('sends Authorization: Basic when auth is supplied and the URL is within authOrigins', async () => {
    const { guardedFetch, log } = makeGuardedFetch(
      { 'https://good.test/x.xml': { body: 'ok' } },
      { auth: { username: 'dev', password: 'hunter2' }, authOrigins: new Set(['https://good.test']) }
    );
    await guardedFetch('https://good.test/x.xml');
    const expected = `Basic ${Buffer.from('dev:hunter2').toString('base64')}`;
    assert.equal(log[0].headers.Authorization, expected);
  });

  test('Sprint 7 fix-loop, QA1 finding B: does NOT send Authorization when the URL is outside authOrigins, even though auth is supplied', async () => {
    // This is the actual vulnerability QA1 demonstrated: a guardedFetch
    // call whose FIRST/only URL is not the trusted origin — exactly what
    // happens when a title fetch or child-sitemap fetch is handed a URL
    // discovered inside untrusted content. authOrigins is now the only
    // thing that can authorize sending the credential, never targetUrl's
    // own origin.
    const { guardedFetch, log } = makeGuardedFetch(
      { 'https://attacker.example/harvest': { body: 'ok' } },
      {
        auth: { username: 'dev', password: 'hunter2' },
        authOrigins: new Set(['https://good.test']),
        dnsMap: { ...PUBLIC_DNS, 'attacker.example': '93.184.216.36' },
      }
    );
    await guardedFetch('https://attacker.example/harvest');
    assert.equal(log[0].headers.Authorization, undefined);
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

    test('a response carrying cf-mitigated: challenge is CdnChallengeError, not HttpAuthError (requirement 6)', async () => {
      const { guardedFetch } = makeGuardedFetch({
        'https://good.test/challenged.xml': {
          status: 403,
          headers: { server: 'cloudflare', 'cf-mitigated': 'challenge' },
        },
      });
      await assert.rejects(() => guardedFetch('https://good.test/challenged.xml'), (err) => {
        assert.ok(err instanceof CdnChallengeError, `expected CdnChallengeError, got ${err.constructor.name}`);
        assert.ok(!(err instanceof HttpAuthError), 'must not ALSO be an HttpAuthError');
        assert.equal(err.code, 'CDN_CHALLENGE');
        assert.equal(err.status, 403);
        return true;
      });
    });

    test('a plain 403 with no cf-mitigated header is unchanged — still HttpAuthError (no regression)', async () => {
      const { guardedFetch } = makeGuardedFetch({
        'https://good.test/plain-403.xml': { status: 403 },
      });
      await assert.rejects(() => guardedFetch('https://good.test/plain-403.xml'), (err) => {
        assert.ok(err instanceof HttpAuthError);
        assert.ok(!(err instanceof CdnChallengeError));
        assert.equal(err.code, 'HTTP_403');
        return true;
      });
    });

    test('a 403 carrying cf-mitigated with some OTHER value is not treated as a challenge (matches the header value, not just its presence)', async () => {
      const { guardedFetch } = makeGuardedFetch({
        'https://good.test/other-mitigation.xml': {
          status: 403,
          headers: { 'cf-mitigated': 'something-else' },
        },
      });
      await assert.rejects(() => guardedFetch('https://good.test/other-mitigation.xml'), (err) => {
        assert.ok(err instanceof HttpAuthError);
        assert.ok(!(err instanceof CdnChallengeError));
        return true;
      });
    });

    test('a plain 401 is still HttpAuthError, unaffected by the challenge check (no regression)', async () => {
      const { guardedFetch } = makeGuardedFetch({
        'https://good.test/plain-401.xml': { status: 401 },
      });
      await assert.rejects(() => guardedFetch('https://good.test/plain-401.xml'), (err) => {
        assert.ok(err instanceof HttpAuthError);
        assert.equal(err.code, 'HTTP_401');
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

    test('a connection-time SSRF rejection from a pinned fetchImpl (sprint 5, requirement 14) surfaces as SsrfBlockedError', async () => {
      // Mirrors exactly what undici's fetch does when lib/net/pinnedFetch
      // .js's Agent connect.lookup rejects: a "fetch failed" TypeError
      // whose .cause is the original PINNED_SSRF_BLOCKED-coded error.
      const fetchImpl = async () => {
        const cause = Object.assign(new Error('Refusing to connect: disallowed address (169.254.169.254)'), {
          code: 'PINNED_SSRF_BLOCKED',
          address: '169.254.169.254',
        });
        throw Object.assign(new TypeError('fetch failed'), { cause });
      };
      const guardedFetch = createGuardedFetch({
        fetchImpl,
        dnsLookup: createFakeDnsLookup(PUBLIC_DNS),
        timeoutMs: 1000,
        userAgent: 'TestBot/1.0',
        maxRedirects: 5,
      });
      await assert.rejects(() => guardedFetch('https://good.test/x.xml'), (err) => {
        assert.ok(err instanceof SsrfBlockedError);
        assert.equal(err.address, '169.254.169.254');
        return true;
      });
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
        { auth: { username: 'dev', password: 'pw' }, authOrigins: new Set(['https://good.test']) }
      );
      await guardedFetch('https://good.test/old.xml');
      assert.equal(log.length, 2);
      assert.ok(log[0].headers.Authorization, 'first request should carry auth');
      assert.ok(log[1].headers.Authorization, 'same-host redirect should carry auth too');
    });

    test('drops Authorization on a same-host https->http redirect (sprint 4 carry-forward fix H)', async () => {
      // QA1's Sprint 3 audit: comparing only .hostname let a same-host
      // scheme downgrade still forward Authorization — the credential
      // then travels in cleartext even though the "same host" check
      // passed. This is the case requirement 13/14 specifically calls
      // out as "the most important of the four."
      const { guardedFetch, log } = makeGuardedFetch(
        {
          'https://good.test/old.xml': { status: 302, headers: { location: 'http://good.test/new.xml' } },
          'http://good.test/new.xml': { body: 'ok' },
        },
        { auth: { username: 'dev', password: 'pw' }, authOrigins: new Set(['https://good.test']) }
      );
      await guardedFetch('https://good.test/old.xml');
      assert.equal(log.length, 2);
      assert.ok(log[0].headers.Authorization, 'first request (https) should carry auth');
      assert.equal(
        log[1].headers.Authorization,
        undefined,
        'the downgraded http hop must NOT carry auth, even though the host is identical'
      );
    });

    test('drops Authorization on a same-host http->https redirect too (port/scheme change either direction)', async () => {
      const { guardedFetch, log } = makeGuardedFetch(
        {
          'http://good.test/old.xml': { status: 302, headers: { location: 'https://good.test:8443/new.xml' } },
          'https://good.test:8443/new.xml': { body: 'ok' },
        },
        { auth: { username: 'dev', password: 'pw' }, authOrigins: new Set(['http://good.test']) }
      );
      await guardedFetch('http://good.test/old.xml');
      assert.ok(log[0].headers.Authorization, 'first request (http, matching authOrigins) should carry auth');
      assert.equal(log[1].headers.Authorization, undefined, 'a port change must also read as a different origin');
    });

    test('drops Authorization on a redirect to a DIFFERENT host', async () => {
      const { guardedFetch, log } = makeGuardedFetch(
        {
          'https://good.test/old.xml': { status: 302, headers: { location: 'https://other.test/new.xml' } },
          'https://other.test/new.xml': { body: 'ok' },
        },
        { auth: { username: 'dev', password: 'pw' }, authOrigins: new Set(['https://good.test']) }
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

  describe('bracketed IPv6 literals, end to end (QA1 round 1, finding D)', () => {
    test('blocks a bracketed loopback literal, dotted-quad-mapped spelling', async () => {
      const { guardedFetch } = makeGuardedFetch({ 'http://[::ffff:127.0.0.1]/x.xml': { body: 'nope' } });
      await assert.rejects(() => guardedFetch('http://[::ffff:127.0.0.1]/x.xml'), SsrfBlockedError);
    });

    test('blocks a bracketed loopback literal, hex-group-mapped spelling', async () => {
      const { guardedFetch } = makeGuardedFetch({ 'http://[::ffff:7f00:1]/x.xml': { body: 'nope' } });
      await assert.rejects(() => guardedFetch('http://[::ffff:7f00:1]/x.xml'), SsrfBlockedError);
    });

    test('blocks a bare bracketed ::1 literal', async () => {
      const { guardedFetch } = makeGuardedFetch({ 'http://[::1]/x.xml': { body: 'nope' } });
      await assert.rejects(() => guardedFetch('http://[::1]/x.xml'), SsrfBlockedError);
    });

    test('allows a bracketed PUBLIC IPv6 literal through (must not be misreported as DNS_ERROR)', async () => {
      const { guardedFetch } = makeGuardedFetch({
        'http://[2606:2800:220:1:248:1893:25c8:1946]/x.xml': { body: '<urlset></urlset>' },
      });
      const res = await guardedFetch('http://[2606:2800:220:1:248:1893:25c8:1946]/x.xml');
      assert.equal(res.body, '<urlset></urlset>');
    });
  });
});

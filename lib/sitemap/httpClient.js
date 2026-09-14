'use strict';

const { assertHostIsSafe } = require('./ssrf');
const {
  SitemapError,
  SitemapTimeoutError,
  ConnectionError,
  HttpAuthError,
  HttpNotFoundError,
  HttpResponseError,
  TooManyRedirectsError,
} = require('./errors');

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Builds a guarded fetch function bound to one set of options
 * (auth/timeout/User-Agent/dnsLookup/fetchImpl). The returned function
 * fetches a single logical request, following redirects itself (never
 * delegating to the underlying fetch's redirect handling) so it can:
 *
 *  - re-run the SSRF address check after every redirect hop, not only on
 *    the initial URL (requirement 10) — an open redirect or DNS
 *    rebinding attack that only appears after the first hop must not
 *    slip through;
 *  - only forward the Authorization header to hosts matching the
 *    ORIGINALLY requested host (requirement 7 asks for auth "on every
 *    request in the chain including redirects to the same host" — the
 *    corollary, and the safe default, is dropping it the moment a
 *    redirect leaves that host, so credentials are never handed to an
 *    arbitrary third party a redirect happens to point at);
 *  - enforce a per-request timeout across the whole chain, not reset on
 *    each hop, so a server that redirects in a loop just inside the
 *    per-hop timeout can't turn one "request" into an unbounded stall.
 *
 * Throws a typed error (see errors.js) for every failure mode instead of
 * ever resolving with a "not ok" response — callers always get either a
 * body or a specific reason they don't.
 */
function createGuardedFetch({
  fetchImpl,
  dnsLookup,
  timeoutMs,
  auth,
  userAgent,
  maxRedirects,
}) {
  return async function guardedFetch(targetUrl) {
    const originalHost = new URL(targetUrl).hostname.toLowerCase();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      let currentUrl = targetUrl;

      for (let hop = 0; ; hop += 1) {
        if (hop > maxRedirects) {
          throw new TooManyRedirectsError(targetUrl, maxRedirects);
        }

        const parsed = new URL(currentUrl);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          throw new SitemapError(
            `Refusing to fetch ${currentUrl}: unsupported protocol ${parsed.protocol}`,
            'UNSUPPORTED_PROTOCOL',
            { url: currentUrl, protocol: parsed.protocol }
          );
        }

        await assertHostIsSafe(parsed.hostname, dnsLookup, currentUrl);

        const headers = { 'User-Agent': userAgent };
        const sendAuth = Boolean(auth) && parsed.hostname.toLowerCase() === originalHost;
        if (sendAuth) {
          const token = Buffer.from(`${auth.username}:${auth.password}`).toString('base64');
          headers.Authorization = `Basic ${token}`;
        }

        let response;
        try {
          response = await fetchImpl(currentUrl, {
            headers,
            redirect: 'manual',
            signal: controller.signal,
          });
        } catch (cause) {
          if (cause.name === 'AbortError') {
            throw new SitemapTimeoutError(targetUrl, timeoutMs);
          }
          throw new ConnectionError(currentUrl, cause);
        }

        if (REDIRECT_STATUSES.has(response.status)) {
          const location = response.headers.get('location');
          if (!location) {
            throw new HttpResponseError(currentUrl, response.status);
          }
          currentUrl = new URL(location, currentUrl).href;
          continue;
        }

        if (response.status === 401 || response.status === 403) {
          throw new HttpAuthError(currentUrl, response.status);
        }
        if (response.status === 404) {
          throw new HttpNotFoundError(currentUrl);
        }
        if (response.status < 200 || response.status >= 300) {
          throw new HttpResponseError(currentUrl, response.status);
        }

        const body = await response.text();
        return {
          status: response.status,
          url: currentUrl,
          contentType: response.headers.get('content-type'),
          body,
        };
      }
    } finally {
      clearTimeout(timer);
    }
  };
}

module.exports = { createGuardedFetch };

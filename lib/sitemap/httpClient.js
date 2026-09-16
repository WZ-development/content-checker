'use strict';

const { assertHostIsSafe } = require('./ssrf');
const {
  SitemapError,
  SitemapTimeoutError,
  BudgetExceededError,
  ConnectionError,
  HttpAuthError,
  HttpNotFoundError,
  HttpResponseError,
  SsrfBlockedError,
  TooManyRedirectsError,
} = require('./errors');

// Sprint 5, requirement 14: when the injected fetchImpl is a
// lib/net/pinnedFetch.js pair, a connection-time SSRF rejection (the
// TOCTOU fix — see that module) surfaces here as a generic "fetch
// failed" whose .cause carries this code. Recognizing it lets a
// same-host-DNS-rebinding block still come out as the same typed
// SsrfBlockedError the pre-connection check (assertHostIsSafe, just
// above) already throws for the common case — one error type for
// "this was an SSRF block," regardless of which of the two checks
// actually caught it.
const PINNED_SSRF_BLOCKED_CODE = 'PINNED_SSRF_BLOCKED';

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
 *  - only forward the Authorization header to requests matching the
 *    ORIGINALLY requested origin — scheme, host, AND port, not host
 *    alone (requirement 7 asks for auth "on every request in the chain
 *    including redirects to the same host"; the corollary, and the safe
 *    default, is dropping it the moment a redirect leaves that origin.
 *    Sprint 4 carry-forward fix H: comparing only hostname let a
 *    same-host https->http redirect keep sending Authorization — a
 *    credential downgrade, since the same header that was fine over TLS
 *    is now on the wire in cleartext. Comparing the full origin closes
 *    that gap the same way it already closes cross-host redirects);
 *  - enforce a per-request timeout across the whole chain, not reset on
 *    each hop, so a server that redirects in a loop just inside the
 *    per-hop timeout can't turn one "request" into an unbounded stall.
 *
 * `budgetSignal`, when supplied, is one AbortSignal shared across an
 * entire discoverAndParseSitemap() call (see index.js). QA1 (round 1)
 * caught that the overall budget was only ever checked at the moment a
 * sitemap was ADMITTED for fetching — every sibling of a flat index is
 * admitted in the same tick, so once a batch is queued behind the
 * concurrency limiter, nothing re-checked the budget again no matter how
 * long the queue actually took to drain. Combining budgetSignal into the
 * fetch's own AbortSignal means a fetch that is already in flight (or
 * that only starts once a concurrency slot frees up) is cut off the
 * moment the budget actually expires, not just at admission time.
 * Aborting via budgetSignal is reported as BudgetExceededError, kept
 * distinct from a per-request SitemapTimeoutError so crawl.js can tell
 * "the whole operation ran out of time" apart from "this one request was
 * slow" and record the right thing.
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
  budgetSignal,
}) {
  return async function guardedFetch(targetUrl) {
    if (budgetSignal && budgetSignal.aborted) {
      throw new BudgetExceededError(targetUrl);
    }

    // Sprint 4 carry-forward fix (H, QA1's Sprint 3 audit): comparing only
    // .hostname let a same-host https->http redirect still forward
    // Authorization — a credential downgrade, since the header then
    // travels in cleartext even though the "same host" check passed.
    // .origin includes scheme and port, so a scheme (or port) change on
    // an otherwise same-host redirect now correctly reads as a different
    // origin and drops the header, exactly like a cross-host redirect
    // already did.
    const originalOrigin = new URL(targetUrl).origin.toLowerCase();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const signal = budgetSignal ? AbortSignal.any([controller.signal, budgetSignal]) : controller.signal;

    try {
      let currentUrl = targetUrl;

      for (let hop = 0; ; hop += 1) {
        if (hop > maxRedirects) {
          throw new TooManyRedirectsError(targetUrl, maxRedirects);
        }
        if (budgetSignal && budgetSignal.aborted) {
          throw new BudgetExceededError(targetUrl);
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
        const sendAuth = Boolean(auth) && parsed.origin.toLowerCase() === originalOrigin;
        if (sendAuth) {
          const token = Buffer.from(`${auth.username}:${auth.password}`).toString('base64');
          headers.Authorization = `Basic ${token}`;
        }

        let response;
        try {
          response = await fetchImpl(currentUrl, {
            headers,
            redirect: 'manual',
            signal,
          });
        } catch (cause) {
          if (cause.name === 'AbortError') {
            if (budgetSignal && budgetSignal.aborted) {
              throw new BudgetExceededError(targetUrl);
            }
            throw new SitemapTimeoutError(targetUrl, timeoutMs);
          }
          if (cause.cause && cause.cause.code === PINNED_SSRF_BLOCKED_CODE) {
            throw new SsrfBlockedError(currentUrl, cause.cause.address);
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

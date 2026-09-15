'use strict';

/**
 * Typed, distinguishable failure classes for lib/sitemap (sprint 3,
 * requirement 11). Every failure a caller might need to branch on — "add
 * credentials" vs "URL is wrong" vs "server is unreachable" — is its own
 * class with a stable `.code` string, so callers can use either
 * `instanceof` or a `switch (err.code)` without parsing message text.
 *
 * All classes extend SitemapError so a caller who only wants "was this a
 * lib/sitemap failure at all" can do a single instanceof check.
 */

class SitemapError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    Object.assign(this, details);
  }
}

/** DNS lookup for the target host failed (NXDOMAIN, resolver error, etc). */
class DnsResolutionError extends SitemapError {
  constructor(url, cause) {
    super(`DNS resolution failed for ${url}`, 'DNS_ERROR', { url, cause });
  }
}

/** TCP connection could not be established (refused, reset, unreachable). */
class ConnectionError extends SitemapError {
  constructor(url, cause) {
    super(`Connection failed for ${url}: ${cause && cause.message}`, 'CONNECTION_ERROR', {
      url,
      cause,
    });
  }
}

/** A single request exceeded its per-request timeout budget. */
class SitemapTimeoutError extends SitemapError {
  constructor(url, timeoutMs) {
    super(`Request to ${url} timed out after ${timeoutMs}ms`, 'TIMEOUT', { url, timeoutMs });
  }
}

/** A request was aborted because the OVERALL operation budget expired —
 * distinct from SitemapTimeoutError (a single request running long) so a
 * caller, and crawl.js's own bookkeeping, can tell "this one request was
 * slow" apart from "the whole operation's time ran out mid-flight". */
class BudgetExceededError extends SitemapError {
  constructor(url) {
    super(`Aborted ${url}: overall operation budget exceeded`, 'BUDGET_EXCEEDED', { url });
  }
}

/** HTTP 401 or 403 — credentials missing or wrong. The single most common
 * real-world case per the sprint file: this must be distinguishable from
 * a 404 so the caller can prompt for Basic Auth credentials specifically. */
class HttpAuthError extends SitemapError {
  constructor(url, status) {
    super(`Authentication required or rejected for ${url} (HTTP ${status})`, `HTTP_${status}`, {
      url,
      status,
    });
  }
}

/** HTTP 404 — the resource genuinely does not exist at that path. */
class HttpNotFoundError extends SitemapError {
  constructor(url) {
    super(`Not found: ${url}`, 'HTTP_404', { url, status: 404 });
  }
}

/** Any other non-2xx HTTP status (500, 503, unexpected 3xx shape, etc). */
class HttpResponseError extends SitemapError {
  constructor(url, status) {
    super(`Unexpected HTTP status ${status} for ${url}`, 'HTTP_ERROR', { url, status });
  }
}

/** The response body is not XML at all (HTML error page, plain text,
 * empty body) — distinct from MalformedXmlError, which means the body
 * looks like XML but fails to parse. */
class NonXmlResponseError extends SitemapError {
  constructor(url, contentType, snippet) {
    super(`Response from ${url} is not XML (content-type: ${contentType || 'unknown'})`, 'NON_XML_RESPONSE', {
      url,
      contentType,
      snippet,
    });
  }
}

/** The response looks like XML but fails to parse, or parses but has
 * neither a <sitemapindex> nor a <urlset> root element. */
class MalformedXmlError extends SitemapError {
  constructor(url, cause) {
    super(`Malformed XML from ${url}${cause ? `: ${cause.message || cause}` : ''}`, 'MALFORMED_XML', {
      url,
      cause,
    });
  }
}

/** Request-time SSRF defence tripped: the resolved address is loopback,
 * link-local, or in a private range. */
class SsrfBlockedError extends SitemapError {
  constructor(url, address) {
    super(`Refusing to fetch ${url}: resolves to a disallowed address (${address})`, 'SSRF_BLOCKED', {
      url,
      address,
    });
  }
}

/** Too many redirect hops in a single request chain. */
class TooManyRedirectsError extends SitemapError {
  constructor(url, maxRedirects) {
    super(`Too many redirects fetching ${url} (limit ${maxRedirects})`, 'TOO_MANY_REDIRECTS', {
      url,
      maxRedirects,
    });
  }
}

/** All automatic discovery strategies (robots.txt, then candidate paths)
 * were exhausted with no valid sitemap found. Carries `attempts`, a log
 * of every URL tried and why it failed, so the UI can turn this into a
 * useful manual-entry prompt rather than a bare "failed" message. */
class SitemapDiscoveryFailedError extends SitemapError {
  constructor(attempts) {
    super('Could not discover a sitemap automatically', 'DISCOVERY_FAILED', { attempts });
  }
}

module.exports = {
  SitemapError,
  DnsResolutionError,
  ConnectionError,
  SitemapTimeoutError,
  BudgetExceededError,
  HttpAuthError,
  HttpNotFoundError,
  HttpResponseError,
  NonXmlResponseError,
  MalformedXmlError,
  SsrfBlockedError,
  TooManyRedirectsError,
  SitemapDiscoveryFailedError,
};

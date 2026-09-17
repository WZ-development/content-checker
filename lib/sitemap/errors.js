'use strict';

const { redactUserinfo } = require('./redactUserinfo');

/**
 * Typed, distinguishable failure classes for lib/sitemap (sprint 3,
 * requirement 11). Every failure a caller might need to branch on — "add
 * credentials" vs "URL is wrong" vs "server is unreachable" — is its own
 * class with a stable `.code` string, so callers can use either
 * `instanceof` or a `switch (err.code)` without parsing message text.
 *
 * All classes extend SitemapError so a caller who only wants "was this a
 * lib/sitemap failure at all" can do a single instanceof check.
 *
 * Every class here redacts the `url` it's given, and any `cause.message`
 * it embeds, before building `.message` or storing either in `details`
 * (sprint 4 carry-forward fix I). This is the ONE place that needs to —
 * every caller in this module constructs its errors through one of these
 * classes, so redacting here covers every url/cause that ever flows
 * through httpClient.js, xml.js, or ssrf.js without each of them having
 * to remember to sanitize before throwing. `cause` itself is replaced
 * with a redacted stand-in (same name/code, sanitized message) rather
 * than stored raw: Node's default error inspection prints a `.cause`
 * property's own message even when nothing explicitly logs it, so a raw
 * cause would leak the same credential a sanitized outer `.message` had
 * already hidden.
 */

function safeUrl(url) {
  return redactUserinfo(String(url));
}

function safeCause(cause) {
  if (!cause) return cause;
  const safe = new Error(redactUserinfo(String(cause.message || cause)));
  safe.name = cause.name || 'Error';
  if (cause.code) safe.code = cause.code;
  return safe;
}

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
    const url_ = safeUrl(url);
    super(`DNS resolution failed for ${url_}`, 'DNS_ERROR', { url: url_, cause: safeCause(cause) });
  }
}

/** TCP connection could not be established (refused, reset, unreachable). */
class ConnectionError extends SitemapError {
  constructor(url, cause) {
    const url_ = safeUrl(url);
    const cause_ = safeCause(cause);
    super(`Connection failed for ${url_}: ${cause_ && cause_.message}`, 'CONNECTION_ERROR', {
      url: url_,
      cause: cause_,
    });
  }
}

/** A single request exceeded its per-request timeout budget. */
class SitemapTimeoutError extends SitemapError {
  constructor(url, timeoutMs) {
    const url_ = safeUrl(url);
    super(`Request to ${url_} timed out after ${timeoutMs}ms`, 'TIMEOUT', { url: url_, timeoutMs });
  }
}

/** A request was aborted because the OVERALL operation budget expired —
 * distinct from SitemapTimeoutError (a single request running long) so a
 * caller, and crawl.js's own bookkeeping, can tell "this one request was
 * slow" apart from "the whole operation's time ran out mid-flight". */
class BudgetExceededError extends SitemapError {
  constructor(url) {
    const url_ = safeUrl(url);
    super(`Aborted ${url_}: overall operation budget exceeded`, 'BUDGET_EXCEEDED', { url: url_ });
  }
}

/** HTTP 401 or 403 — credentials missing or wrong. The single most common
 * real-world case per the sprint file: this must be distinguishable from
 * a 404 so the caller can prompt for Basic Auth credentials specifically. */
class HttpAuthError extends SitemapError {
  constructor(url, status) {
    const url_ = safeUrl(url);
    super(`Authentication required or rejected for ${url_} (HTTP ${status})`, `HTTP_${status}`, {
      url: url_,
      status,
    });
  }
}

/** HTTP 404 — the resource genuinely does not exist at that path. */
class HttpNotFoundError extends SitemapError {
  constructor(url) {
    const url_ = safeUrl(url);
    super(`Not found: ${url_}`, 'HTTP_404', { url: url_, status: 404 });
  }
}

/** Any other non-2xx HTTP status (500, 503, unexpected 3xx shape, etc). */
class HttpResponseError extends SitemapError {
  constructor(url, status) {
    const url_ = safeUrl(url);
    super(`Unexpected HTTP status ${status} for ${url_}`, 'HTTP_ERROR', { url: url_, status });
  }
}

/** The response body is not XML at all (HTML error page, plain text,
 * empty body) — distinct from MalformedXmlError, which means the body
 * looks like XML but fails to parse. */
class NonXmlResponseError extends SitemapError {
  constructor(url, contentType, snippet) {
    const url_ = safeUrl(url);
    super(`Response from ${url_} is not XML (content-type: ${contentType || 'unknown'})`, 'NON_XML_RESPONSE', {
      url: url_,
      contentType,
      snippet,
    });
  }
}

/** The response looks like XML but fails to parse, or parses but has
 * neither a <sitemapindex> nor a <urlset> root element. */
class MalformedXmlError extends SitemapError {
  constructor(url, cause) {
    const url_ = safeUrl(url);
    const cause_ = safeCause(cause);
    super(`Malformed XML from ${url_}${cause_ ? `: ${cause_.message}` : ''}`, 'MALFORMED_XML', {
      url: url_,
      cause: cause_,
    });
  }
}

/** Request-time SSRF defence tripped: the resolved address is loopback,
 * link-local, or in a private range. */
class SsrfBlockedError extends SitemapError {
  constructor(url, address) {
    const url_ = safeUrl(url);
    super(`Refusing to fetch ${url_}: resolves to a disallowed address (${address})`, 'SSRF_BLOCKED', {
      url: url_,
      address,
    });
  }
}

/** Too many redirect hops in a single request chain. */
class TooManyRedirectsError extends SitemapError {
  constructor(url, maxRedirects) {
    const url_ = safeUrl(url);
    super(`Too many redirects fetching ${url_} (limit ${maxRedirects})`, 'TOO_MANY_REDIRECTS', {
      url: url_,
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

/** Sprint 7, requirement 6: a CDN/WAF issued a managed challenge instead of
 * serving the request — detected in httpClient.js by the presence of a
 * response header naming its own mitigation action, never by inspecting
 * body text (a challenge page's HTML is free to change; the header is the
 * CDN's own declaration of what it did). Kept distinct from HttpAuthError
 * even though the underlying HTTP status is typically 403, because the
 * remedy is entirely different — an allow-list rule, not credentials —
 * and conflating the two produces exactly the misleading "check your
 * password" message this sprint exists to fix. The presentation layer
 * (src/lib/scanErrorPresentation.js) is what turns this into the
 * actionable allow-rule guidance; this class only records that a
 * challenge, specifically, is what happened. */
class CdnChallengeError extends SitemapError {
  constructor(url, status) {
    const url_ = safeUrl(url);
    super(`CDN/firewall challenge encountered fetching ${url_} (HTTP ${status})`, 'CDN_CHALLENGE', {
      url: url_,
      status,
    });
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
  CdnChallengeError,
};

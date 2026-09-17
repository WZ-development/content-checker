'use strict';

const net = require('node:net');
const dns = require('node:dns');
const { fetch: undiciFetch, Agent } = require('undici');

const { isDisallowedAddress, stripBrackets } = require('../sitemap/ssrf');
const { isAllowedOrigin } = require('../sitemap/originScope');

const SSRF_BLOCKED_CODE = 'PINNED_SSRF_BLOCKED';

// Sprint 7, requirement 1. The single name used everywhere this header
// is either set (mergeOutboundTokenHeader, below) or referenced (the
// CDN-challenge message and docs/cdn-allow-rule.md) — exported so
// nothing else hardcodes its own spelling that could drift from this
// one.
const OUTBOUND_TOKEN_HEADER_NAME = 'X-ContentCheck-Token';

/**
 * Resolves `hostname` and returns only the addresses that pass the SSRF
 * range check — reusing lib/sitemap/ssrf.js's isDisallowedAddress
 * directly rather than a second copy of the range list, so there is one
 * definition of "disallowed" for both the pre-connection check
 * (assertHostIsSafe) and the connection-time check this module adds.
 * Throws (marked with `.code = 'PINNED_SSRF_BLOCKED'`) when a literal IP
 * is disallowed, or when every resolved address is.
 */
async function resolveSafeAddresses(hostname, dnsLookup) {
  const literal = stripBrackets(hostname);

  if (net.isIP(literal)) {
    if (isDisallowedAddress(literal)) {
      throw Object.assign(
        new Error(`Refusing to connect to ${hostname}: disallowed address (${literal})`),
        { code: SSRF_BLOCKED_CODE, address: literal }
      );
    }
    return [{ address: literal, family: net.isIP(literal) }];
  }

  const results = await dnsLookup(hostname, { all: true, verbatim: true });
  const addresses = (Array.isArray(results) ? results : [results]).map((entry) =>
    typeof entry === 'string' ? { address: entry, family: net.isIP(entry) } : entry
  );

  const safe = addresses.filter((entry) => !isDisallowedAddress(entry.address));
  if (safe.length === 0) {
    const disallowed = addresses[0];
    throw Object.assign(
      new Error(`Refusing to connect to ${hostname}: no resolved address is allowed`),
      { code: SSRF_BLOCKED_CODE, address: disallowed && disallowed.address }
    );
  }
  return safe;
}

/**
 * Sprint 5, requirement 14. QA1 flagged (Sprint 3, item F) that
 * lib/sitemap's pre-connection SSRF check (assertHostIsSafe) resolves
 * DNS once to validate a host, and then the underlying fetch resolves
 * DNS *again*, independently, to actually open the connection — a
 * window between the two in which DNS can answer differently (a
 * rebinding attack, or simple propagation) and the address that gets
 * connected to was never the one that was checked.
 *
 * The fix: an undici Agent whose `connect.lookup` IS
 * resolveSafeAddresses() above — the exact same validation
 * assertHostIsSafe uses — so the address undici actually opens a socket
 * to is never one that failed the check. There's no second, unvalidated
 * resolution happening anywhere in the chain; the lookup and the
 * connection are the same operation, not a check followed by a
 * separately-resolved connect.
 *
 * Returns `{ fetchImpl, dnsLookup }` — the exact shape both
 * lib/sitemap's createGuardedFetch and lib/compare's resolveTitles
 * already accept as constructor options. Call this ONCE per app
 * lifetime (see src/app.js) and pass the SAME pair into both.
 *
 * Purely about SSRF-safe connection pinning — outbound token injection
 * (sprint 7) is a deliberately SEPARATE wrapping layer, see
 * wrapFetchWithOutboundToken below, composed once per SCAN REQUEST (not
 * once per app instance — see src/routes/scan.js and its own doc comment
 * for why the fix-loop moved this) rather than folded in here. Keeping
 * them apart means a test that injects its own fake fetchImpl (bypassing
 * pinning entirely, for a hermetic test with no real network) still
 * exercises the exact same token-injection path production uses —
 * pinning and token injection are independently testable instead of only
 * provable together.
 */
function createPinnedFetch({ dnsLookup = dns.promises.lookup } = {}) {
  const agent = new Agent({
    connect: {
      lookup(hostname, options, callback) {
        resolveSafeAddresses(hostname, dnsLookup).then(
          (addresses) => callback(null, addresses),
          (err) => callback(err)
        );
      },
    },
  });

  function fetchImpl(url, init) {
    return undiciFetch(url, { ...init, dispatcher: agent });
  }

  return { fetchImpl, dnsLookup };
}

/**
 * Pure header-merge logic, factored out so it's directly unit-testable
 * without any network call at all. Returns `baseHeaders` UNCHANGED (not
 * even a shallow copy) when no token is configured — requirement 2's
 * "omitted entirely," not an empty-string header some servers would
 * still see.
 */
function mergeOutboundTokenHeader(baseHeaders, outboundToken) {
  if (!outboundToken) return baseHeaders;
  return { ...(baseHeaders || {}), [OUTBOUND_TOKEN_HEADER_NAME]: outboundToken };
}

/**
 * Sprint 7, requirement 1: wraps ANY fetchImpl — the real pinned one
 * from createPinnedFetch, or a test's fake one — so every call through
 * the result carries the outbound token header on requests to an allowed
 * origin, via mergeOutboundTokenHeader above. This is the ONE place the
 * header gets added; neither lib/sitemap's crawler nor lib/compare's
 * title fetcher ever sets this header themselves — they just call
 * whatever fetchImpl they were handed, same as always. Because
 * httpClient.js's redirect loop calls fetchImpl fresh on every hop, and
 * this wrapping is beneath that loop, every request type requirement 1
 * names (initial fetch, every child sitemap, every title fetch, every
 * redirect hop) carries it automatically — for URLs on an allowed origin.
 *
 * `allowedOrigins` (sprint 7 fix-loop, QA1 round 1 finding A): a Set of
 * already-lowercased origin strings — the project's OWN configured
 * live/staging origins, supplied fresh per scan request by
 * src/routes/scan.js, never derived from the URL being fetched itself.
 * Without this, a compromised or malicious site's sitemap can name any
 * host it likes (<loc>https://attacker.example/…</loc>, a redirect
 * target) and this wrapper would have sent the agency's one shared
 * outbound-identification secret there unconditionally — demonstrated in
 * QA1's round 1 audit. A request to a URL outside `allowedOrigins` still
 * goes out (a sitemap may legitimately reference a CDN host for assets),
 * it just never carries the secret. See lib/sitemap/originScope.js for
 * why this must come from outside the fetched content.
 *
 * Returns `fetchImpl` completely unwrapped when no token is configured —
 * requirement 2 — so "not configured" has zero runtime cost or
 * behavioural difference beyond the header's absence.
 */
function wrapFetchWithOutboundToken(fetchImpl, outboundToken, allowedOrigins) {
  if (!outboundToken) return fetchImpl;
  return function outboundTokenFetch(url, init = {}) {
    if (!isAllowedOrigin(url, allowedOrigins)) return fetchImpl(url, init);
    return fetchImpl(url, { ...init, headers: mergeOutboundTokenHeader(init.headers, outboundToken) });
  };
}

module.exports = {
  createPinnedFetch,
  resolveSafeAddresses,
  mergeOutboundTokenHeader,
  wrapFetchWithOutboundToken,
  SSRF_BLOCKED_CODE,
  OUTBOUND_TOKEN_HEADER_NAME,
};

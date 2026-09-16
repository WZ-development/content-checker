'use strict';

const net = require('node:net');
const dns = require('node:dns');
const { fetch: undiciFetch, Agent } = require('undici');

const { isDisallowedAddress, stripBrackets } = require('../sitemap/ssrf');

const SSRF_BLOCKED_CODE = 'PINNED_SSRF_BLOCKED';

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
 * already accept as constructor options (see their own `fetchImpl`/
 * `dnsLookup` parameters). Call this ONCE per app lifetime (see
 * src/app.js) and pass the SAME pair into both — that's what makes
 * "exactly one outbound fetch implementation is constructed... and
 * both the crawler and the title fetcher receive that same instance by
 * injection" true, not just documented.
 *
 * Note `dnsLookup` here is returned unchanged (plain dns.promises.lookup
 * by default, or whatever was passed in) — it is NOT itself the
 * validating function. assertHostIsSafe's pre-check and this Agent's
 * connect-time check both independently validate whatever `dnsLookup`
 * resolves, at their own respective moments — which is the point: the
 * connect-time check runs again, right before the socket opens, so a
 * result that changed since the pre-check is still caught.
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

module.exports = { createPinnedFetch, resolveSafeAddresses, SSRF_BLOCKED_CODE };

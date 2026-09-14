'use strict';

const net = require('node:net');
const dns = require('node:dns');

const { isPrivateOrReservedAddress } = require('./ipRangeCheck');

const INVALID_URL_ERROR = 'Enter a full URL starting with http:// or https://.';
const PRIVATE_ADDRESS_ERROR =
  'This URL points to a private, loopback, or link-local address, which this tool cannot fetch.';

/**
 * Strips the brackets new URL().hostname leaves around an IPv6 literal
 * (e.g. "[::1]") — net.isIPv6/isPrivateOrReservedAddress expect the bare
 * form ("::1"), and checking the bracketed string against them would
 * silently never match anything.
 */
function unwrapIPv6Hostname(hostname) {
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    return hostname.slice(1, -1);
  }
  return hostname;
}

/**
 * True if `hostname` is, or resolves to, a loopback/private/link-local
 * address. A literal IP is checked directly; a domain name is resolved
 * via DNS and every returned address is checked — a hostname can have
 * multiple A/AAAA records, and any one of them being private is enough
 * for this to be a real SSRF target.
 *
 * A DNS lookup failure (unresolvable hostname) is treated as "not
 * private" rather than rejected: staging domains genuinely go
 * unresolvable between a client tearing one down and standing the next
 * one up (see sprint context), and a hostname that can't be resolved at
 * all isn't reachable right now regardless. Sprint 3 adds a request-time
 * check as defence in depth for exactly the gap this leaves (DNS can
 * start resolving to a private address after this save-time check runs).
 */
async function resolvesToPrivateAddress(hostname) {
  const bareHostname = unwrapIPv6Hostname(hostname);

  if (net.isIP(bareHostname)) {
    return isPrivateOrReservedAddress(bareHostname);
  }

  let addresses;
  try {
    addresses = await dns.promises.lookup(hostname, { all: true });
  } catch {
    return false;
  }

  return addresses.some((entry) => isPrivateOrReservedAddress(entry.address));
}

/**
 * Validates and normalizes a user-supplied URL for the live/staging URL
 * fields. Returns `{ valid: true, url }` or `{ valid: false, error }` —
 * never throws, so callers can use it directly to build field-level
 * validation errors.
 */
async function normalizeAndValidateUrl(input) {
  const trimmed = typeof input === 'string' ? input.trim() : '';

  if (trimmed === '') {
    return { valid: false, error: 'This field is required.' };
  }

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { valid: false, error: INVALID_URL_ERROR };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { valid: false, error: INVALID_URL_ERROR };
  }

  if (await resolvesToPrivateAddress(parsed.hostname)) {
    return { valid: false, error: PRIVATE_ADDRESS_ERROR };
  }

  // "Stripping any trailing slash from the origin" — normalize the bare
  // "https://example.com/" case to "https://example.com". A URL with a
  // real path is left as parsed; trimming *that* trailing slash could
  // change which resource it names.
  const normalized =
    parsed.pathname === '/' && !parsed.search && !parsed.hash ? parsed.origin : parsed.href;

  return { valid: true, url: normalized };
}

module.exports = { normalizeAndValidateUrl };

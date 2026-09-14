'use strict';

const net = require('node:net');
const { DnsResolutionError, SsrfBlockedError } = require('./errors');

/**
 * Request-time SSRF defence (sprint 3, requirement 10). Resolves a
 * hostname and rejects it if any resolved address is loopback,
 * link-local, or in a private range. Called before the initial request
 * AND again after every redirect hop — see httpClient.js — so a
 * DNS-rebinding or open-redirect trick cannot smuggle a request to
 * internal infrastructure after the first, safe-looking check passes.
 *
 * `dnsLookup` is injectable (defaults to `dns.promises.lookup`) so tests
 * can exercise both "resolves to a public address" and "resolves to a
 * private address" without touching real DNS or the network.
 */
async function assertHostIsSafe(hostname, dnsLookup, contextUrl) {
  let results;
  try {
    results = await dnsLookup(hostname, { all: true, verbatim: true });
  } catch (cause) {
    throw new DnsResolutionError(contextUrl, cause);
  }

  const addresses = Array.isArray(results) ? results : [results];
  if (addresses.length === 0) {
    throw new DnsResolutionError(contextUrl, new Error(`No addresses resolved for ${hostname}`));
  }

  for (const entry of addresses) {
    const address = typeof entry === 'string' ? entry : entry.address;
    const family = typeof entry === 'string' ? undefined : entry.family;
    if (isDisallowedAddress(address, family)) {
      throw new SsrfBlockedError(contextUrl, address);
    }
  }
}

function isDisallowedAddress(address, family) {
  if (!address) return true; // malformed/missing -> block conservatively

  if (family === 6 || (!family && net.isIPv6(address))) {
    const mapped = extractIPv4MappedAddress(address);
    if (mapped) return isPrivateIPv4(mapped);
    return isPrivateIPv6(address);
  }

  if (family === 4 || net.isIPv4(address)) {
    return isPrivateIPv4(address);
  }

  // Unknown/unparseable family — block conservatively rather than let an
  // address we don't understand through.
  return true;
}

function isPrivateIPv4(address) {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    return true; // malformed -> block conservatively
  }
  const [a, b] = octets;
  if (a === 127) return true; // loopback (127.0.0.0/8)
  if (a === 10) return true; // private (10.0.0.0/8)
  if (a === 172 && b >= 16 && b <= 31) return true; // private (172.16.0.0/12)
  if (a === 192 && b === 168) return true; // private (192.168.0.0/16)
  if (a === 169 && b === 254) return true; // link-local (169.254.0.0/16)
  if (a === 0) return true; // "this network", unroutable
  return false;
}

function isPrivateIPv6(address) {
  const normalized = address.toLowerCase();
  if (normalized === '::1') return true; // loopback
  if (normalized === '::') return true; // unspecified

  const firstGroup = normalized.split(':').find((part) => part !== '') || '0';
  const firstHextet = Number.parseInt(firstGroup, 16);
  if (Number.isNaN(firstHextet)) return true; // malformed -> block conservatively

  if (firstHextet >= 0xfe80 && firstHextet <= 0xfebf) return true; // link-local fe80::/10
  if (firstHextet >= 0xfc00 && firstHextet <= 0xfdff) return true; // unique local fc00::/7

  return false;
}

function extractIPv4MappedAddress(address) {
  const match = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address.trim());
  return match ? match[1] : null;
}

module.exports = { assertHostIsSafe, isDisallowedAddress };

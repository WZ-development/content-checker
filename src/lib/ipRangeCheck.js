'use strict';

const net = require('node:net');

/**
 * Checks a literal IPv4 address string against the ranges requirement 7
 * names: loopback, the three private-use blocks, and link-local.
 */
function isPrivateIPv4(ip) {
  const octets = ip.split('.').map(Number);
  if (octets.length !== 4 || octets.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    return false;
  }
  const [a, b] = octets;

  if (a === 127) return true; // 127.0.0.0/8 — loopback
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 — link-local

  return false;
}

/**
 * Checks a literal IPv6 address string. Covers ::1 (the address
 * requirement 7 names) plus IPv4-mapped IPv6 addresses like
 * ::ffff:127.0.0.1 — without this, a hostname resolving only to an
 * IPv4-mapped form would sail through the IPv6 branch untested despite
 * describing exactly the same loopback/private host the IPv4 branch
 * exists to catch. Beyond that, stays to what requirement 7 specifies
 * rather than guessing at a fuller IPv6 private-range list.
 */
function isPrivateIPv6(ip) {
  const normalized = ip.toLowerCase();
  if (normalized === '::1') return true;

  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIPv4(mapped[1]);

  return false;
}

/**
 * True if `ip` (a literal address, not a hostname) falls in a loopback,
 * private-use, or link-local range. Used both on a URL's hostname when
 * it's already a literal IP, and on every address a hostname resolves to.
 */
function isPrivateOrReservedAddress(ip) {
  if (net.isIPv4(ip)) return isPrivateIPv4(ip);
  if (net.isIPv6(ip)) return isPrivateIPv6(ip);
  return false;
}

module.exports = { isPrivateOrReservedAddress };

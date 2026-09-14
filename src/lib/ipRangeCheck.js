'use strict';

const net = require('node:net');

/**
 * Built once at module load from the exact ranges requirement 7 names —
 * not a hand-rolled octet comparison. That distinction is the actual
 * fix here: a prior version of this module matched IPv4-mapped IPv6
 * addresses (::ffff:a.b.c.d) against a regex that only recognized the
 * dotted-quad spelling, but new URL() normalizes a bracketed IPv6 host
 * to its canonical hex-group form (::ffff:7f00:1, not ::ffff:127.0.0.1)
 * before this module ever sees it — so the regex never fired on the
 * actual code path, only on a spelling nothing upstream produces.
 * net.BlockList.check() understands IPv4-mapped addresses in either
 * spelling natively, because it operates on the address's real value
 * rather than its string form, which is the class of bug this fix
 * closes, not just this one instance of it.
 */
const blockList = new net.BlockList();
blockList.addSubnet('127.0.0.0', 8, 'ipv4'); // loopback
blockList.addSubnet('10.0.0.0', 8, 'ipv4');
blockList.addSubnet('172.16.0.0', 12, 'ipv4');
blockList.addSubnet('192.168.0.0', 16, 'ipv4');
blockList.addSubnet('169.254.0.0', 16, 'ipv4'); // link-local
blockList.addAddress('::1', 'ipv6'); // loopback

/**
 * True if `ip` (a literal address, not a hostname) falls in a loopback,
 * private-use, or link-local range — the exact set requirement 7 names
 * (127.0.0.0/8, 10/8, 172.16/12, 192.168/16, 169.254/16, ::1) — including
 * an IPv4-mapped IPv6 form of any of the IPv4 ranges, in either spelling.
 * Used both on a URL's hostname when it's already a literal IP, and on
 * every address a hostname resolves to.
 */
function isPrivateOrReservedAddress(ip) {
  if (net.isIPv4(ip)) return blockList.check(ip, 'ipv4');
  if (net.isIPv6(ip)) return blockList.check(ip, 'ipv6');
  return false;
}

module.exports = { isPrivateOrReservedAddress };

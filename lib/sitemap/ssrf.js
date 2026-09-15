'use strict';

const net = require('node:net');
const { DnsResolutionError, SsrfBlockedError } = require('./errors');

/**
 * Built once at module load from the exact ranges requirement 10 names,
 * plus a few additions that go beyond it (documented inline) — not
 * hand-rolled octet/hextet comparisons.
 *
 * QA1 (round 1) failed an earlier, regex-based version of this check for
 * the same defect class as Sprint 2's own round-1 CONDITIONAL:
 * extractIPv4MappedAddress matched only the dotted-quad spelling
 * (::ffff:127.0.0.1) and missed the hex-group spelling (::ffff:7f00:1)
 * that new URL() and most real resolvers actually produce for a mapped
 * address — so the check never fired on the code path that matters.
 * net.BlockList.check() understands an IPv4-mapped address by its actual
 * value, in EITHER spelling, which closes the whole defect class rather
 * than one instance of it. Sprint 2 made the same fix; this mirrors it
 * (independently — this module does not import Sprint 2's code) with a
 * larger range set appropriate to a module making outbound requests
 * rather than validating a save-time URL.
 */
const blockList = new net.BlockList();
blockList.addSubnet('127.0.0.0', 8, 'ipv4'); // loopback
blockList.addSubnet('10.0.0.0', 8, 'ipv4'); // private
blockList.addSubnet('172.16.0.0', 12, 'ipv4'); // private
blockList.addSubnet('192.168.0.0', 16, 'ipv4'); // private
blockList.addSubnet('169.254.0.0', 16, 'ipv4'); // link-local
blockList.addSubnet('0.0.0.0', 8, 'ipv4'); // "this network", unroutable
blockList.addAddress('::1', 'ipv6'); // loopback
blockList.addAddress('::', 'ipv6'); // unspecified
blockList.addSubnet('fe80::', 10, 'ipv6'); // link-local
blockList.addSubnet('fc00::', 7, 'ipv6'); // unique-local

/**
 * True if `address` (a literal IP, not a hostname) is loopback,
 * link-local, or in a private range — including an IPv4-mapped IPv6
 * form, in either spelling. A malformed/unparseable address blocks
 * conservatively (returns true): this gates an actual outbound request,
 * so the safe default on "I don't understand this" is to refuse it.
 */
function isDisallowedAddress(address) {
  if (!address) return true;
  if (net.isIPv4(address)) return blockList.check(address, 'ipv4');
  if (net.isIPv6(address)) return blockList.check(address, 'ipv6');
  return true;
}

/**
 * new URL(...).hostname keeps brackets around an IPv6 literal
 * ("[::1]") — neither net.isIP() nor dns.lookup() accept that form.
 * QA1 (round 1) caught this causing every legitimate bracketed IPv6 URL
 * to fail as a DNS_ERROR (dns.lookup('[::1]') really does throw
 * ENOTFOUND), which also happened to mask (i) above for every reachable
 * code path — fixing this alone, without also fixing the BlockList
 * check, would have made the masked defect live. Both are fixed here
 * together.
 */
function stripBrackets(hostname) {
  if (hostname.length > 2 && hostname.startsWith('[') && hostname.endsWith(']')) {
    return hostname.slice(1, -1);
  }
  return hostname;
}

/**
 * Request-time SSRF defence (requirement 10). A literal IP in the URL
 * (bracketed IPv6 included) is checked directly with no DNS round trip.
 * A real hostname is resolved via the injectable `dnsLookup` (defaults
 * to dns.promises.lookup) and every returned address is checked.
 *
 * Called before the initial request AND again after every redirect hop
 * (see httpClient.js), so a DNS-rebinding or open-redirect trick cannot
 * smuggle a request to internal infrastructure after the first,
 * safe-looking check passes.
 */
async function assertHostIsSafe(hostname, dnsLookup, contextUrl) {
  const literal = stripBrackets(hostname);

  if (net.isIP(literal)) {
    if (isDisallowedAddress(literal)) {
      throw new SsrfBlockedError(contextUrl, literal);
    }
    return;
  }

  let results;
  try {
    results = await dnsLookup(literal, { all: true, verbatim: true });
  } catch (cause) {
    throw new DnsResolutionError(contextUrl, cause);
  }

  const addresses = Array.isArray(results) ? results : [results];
  if (addresses.length === 0) {
    throw new DnsResolutionError(contextUrl, new Error(`No addresses resolved for ${literal}`));
  }

  for (const entry of addresses) {
    const address = typeof entry === 'string' ? entry : entry.address;
    if (isDisallowedAddress(address)) {
      throw new SsrfBlockedError(contextUrl, address);
    }
  }
}

module.exports = { assertHostIsSafe, isDisallowedAddress, stripBrackets };

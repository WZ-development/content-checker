'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { assertHostIsSafe, isDisallowedAddress } = require('../../lib/sitemap/ssrf');
const { DnsResolutionError, SsrfBlockedError } = require('../../lib/sitemap/errors');
const { createFakeDnsLookup } = require('./testHarness');

describe('isDisallowedAddress', () => {
  test('blocks IPv4 loopback', () => assert.equal(isDisallowedAddress('127.0.0.1', 4), true));
  test('blocks IPv4 10/8', () => assert.equal(isDisallowedAddress('10.1.2.3', 4), true));
  test('blocks IPv4 172.16/12 lower bound', () => assert.equal(isDisallowedAddress('172.16.0.1', 4), true));
  test('blocks IPv4 172.16/12 upper bound', () => assert.equal(isDisallowedAddress('172.31.255.255', 4), true));
  test('allows IPv4 172.32.x (just outside 172.16/12)', () => assert.equal(isDisallowedAddress('172.32.0.1', 4), false));
  test('blocks IPv4 192.168/16', () => assert.equal(isDisallowedAddress('192.168.1.1', 4), true));
  test('blocks IPv4 link-local 169.254/16', () => assert.equal(isDisallowedAddress('169.254.169.254', 4), true));
  test('allows a public IPv4 address', () => assert.equal(isDisallowedAddress('93.184.216.34', 4), false));

  test('blocks IPv6 loopback ::1', () => assert.equal(isDisallowedAddress('::1', 6), true));
  test('blocks IPv6 link-local fe80::/10', () => assert.equal(isDisallowedAddress('fe80::1', 6), true));
  test('blocks IPv6 unique-local fc00::/7', () => assert.equal(isDisallowedAddress('fd12:3456:789a::1', 6), true));
  test('allows a public IPv6 address', () => assert.equal(isDisallowedAddress('2606:2800:220:1:248:1893:25c8:1946', 6), false));
  test('blocks an IPv4-mapped IPv6 loopback (::ffff:127.0.0.1)', () =>
    assert.equal(isDisallowedAddress('::ffff:127.0.0.1', 6), true));

  test('blocks a malformed address conservatively', () => assert.equal(isDisallowedAddress('not-an-ip', undefined), true));
});

describe('assertHostIsSafe', () => {
  test('resolves without throwing for a public address', async () => {
    const dnsLookup = createFakeDnsLookup({ 'good.test': '93.184.216.34' });
    await assert.doesNotReject(() => assertHostIsSafe('good.test', dnsLookup, 'https://good.test/'));
  });

  test('throws SsrfBlockedError for a host resolving to a private address', async () => {
    const dnsLookup = createFakeDnsLookup({ 'evil.test': '127.0.0.1' });
    await assert.rejects(
      () => assertHostIsSafe('evil.test', dnsLookup, 'https://evil.test/'),
      (err) => {
        assert.ok(err instanceof SsrfBlockedError);
        assert.equal(err.code, 'SSRF_BLOCKED');
        return true;
      }
    );
  });

  test('blocks when ANY resolved address (of several) is private', async () => {
    const dnsLookup = createFakeDnsLookup({ 'mixed.test': ['93.184.216.34', '10.0.0.5'] });
    await assert.rejects(() => assertHostIsSafe('mixed.test', dnsLookup, 'https://mixed.test/'), SsrfBlockedError);
  });

  test('wraps a DNS failure as DnsResolutionError', async () => {
    const dnsLookup = createFakeDnsLookup({});
    await assert.rejects(
      () => assertHostIsSafe('nowhere.test', dnsLookup, 'https://nowhere.test/'),
      (err) => {
        assert.ok(err instanceof DnsResolutionError);
        assert.equal(err.code, 'DNS_ERROR');
        return true;
      }
    );
  });
});

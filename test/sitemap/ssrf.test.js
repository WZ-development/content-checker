'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { assertHostIsSafe, isDisallowedAddress, stripBrackets } = require('../../lib/sitemap/ssrf');
const { DnsResolutionError, SsrfBlockedError } = require('../../lib/sitemap/errors');
const { createFakeDnsLookup } = require('./testHarness');

describe('isDisallowedAddress', () => {
  test('blocks IPv4 loopback', () => assert.equal(isDisallowedAddress('127.0.0.1'), true));
  test('blocks IPv4 10/8', () => assert.equal(isDisallowedAddress('10.1.2.3'), true));
  test('blocks IPv4 172.16/12 lower bound', () => assert.equal(isDisallowedAddress('172.16.0.1'), true));
  test('blocks IPv4 172.16/12 upper bound', () => assert.equal(isDisallowedAddress('172.31.255.255'), true));
  test('allows IPv4 172.32.x (just outside 172.16/12)', () => assert.equal(isDisallowedAddress('172.32.0.1'), false));
  test('blocks IPv4 192.168/16', () => assert.equal(isDisallowedAddress('192.168.1.1'), true));
  test('blocks IPv4 link-local 169.254/16', () => assert.equal(isDisallowedAddress('169.254.169.254'), true));
  test('blocks IPv4 0.0.0.0/8', () => assert.equal(isDisallowedAddress('0.0.0.0'), true));
  test('allows a public IPv4 address', () => assert.equal(isDisallowedAddress('93.184.216.34'), false));

  test('blocks IPv6 loopback ::1', () => assert.equal(isDisallowedAddress('::1'), true));
  test('blocks IPv6 unspecified ::', () => assert.equal(isDisallowedAddress('::'), true));
  test('blocks IPv6 link-local fe80::/10', () => assert.equal(isDisallowedAddress('fe80::1'), true));
  test('blocks IPv6 unique-local fc00::/7', () => assert.equal(isDisallowedAddress('fd12:3456:789a::1'), true));
  test('allows a public IPv6 address', () => assert.equal(isDisallowedAddress('2606:2800:220:1:248:1893:25c8:1946'), false));

  describe('IPv4-mapped IPv6, in either spelling (QA1 round 1, finding D)', () => {
    test('blocks the dotted-quad spelling of loopback (::ffff:127.0.0.1)', () =>
      assert.equal(isDisallowedAddress('::ffff:127.0.0.1'), true));
    test('blocks the hex-group spelling of loopback (::ffff:7f00:1) — what new URL()/real resolvers actually produce', () =>
      assert.equal(isDisallowedAddress('::ffff:7f00:1'), true));
    test('blocks the hex-group spelling of a private address (::ffff:c0a8:10a = 192.168.1.10)', () =>
      assert.equal(isDisallowedAddress('::ffff:c0a8:10a'), true));
    test('allows a hex-group-mapped public address', () => assert.equal(isDisallowedAddress('::ffff:5db8:d822'), false));
  });

  test('blocks a malformed address conservatively', () => assert.equal(isDisallowedAddress('not-an-ip'), true));
  test('blocks an empty/falsy address conservatively', () => assert.equal(isDisallowedAddress(''), true));
});

describe('stripBrackets', () => {
  test('strips brackets from an IPv6 literal hostname', () => assert.equal(stripBrackets('[::1]'), '::1'));
  test('leaves a plain hostname untouched', () => assert.equal(stripBrackets('example.test'), 'example.test'));
  test('leaves a bare IPv4 literal untouched', () => assert.equal(stripBrackets('93.184.216.34'), '93.184.216.34'));
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

  describe('bracketed IPv6 literals (QA1 round 1, finding D-ii)', () => {
    test('a bracketed IPv6 loopback literal is blocked as SSRF, not misreported as a DNS failure', async () => {
      const dnsLookup = async () => {
        throw new Error('must not be called for a literal IP');
      };
      await assert.rejects(
        () => assertHostIsSafe('[::1]', dnsLookup, 'https://[::1]/'),
        (err) => {
          assert.ok(err instanceof SsrfBlockedError, `expected SsrfBlockedError, got ${err.constructor.name}`);
          return true;
        }
      );
    });

    test('a bracketed public IPv6 literal is allowed, with no DNS lookup performed', async () => {
      let called = false;
      const dnsLookup = async () => {
        called = true;
        return [];
      };
      await assert.doesNotReject(() => assertHostIsSafe('[2606:2800:220:1:248:1893:25c8:1946]', dnsLookup, 'https://x/'));
      assert.equal(called, false, 'a literal IP must not go through DNS at all');
    });
  });
});

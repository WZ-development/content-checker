'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { isPrivateOrReservedAddress } = require('../../src/lib/ipRangeCheck');

describe('isPrivateOrReservedAddress', () => {
  const privateAddresses = [
    ['127.0.0.1', 'loopback'],
    ['127.255.255.254', 'loopback range edge'],
    ['10.0.0.1', '10/8'],
    ['10.255.255.255', '10/8 range edge'],
    ['172.16.0.1', '172.16/12 lower edge'],
    ['172.31.255.255', '172.16/12 upper edge'],
    ['192.168.1.10', '192.168/16 (the acceptance-criteria example)'],
    ['169.254.0.1', '169.254/16 link-local'],
    ['::1', 'IPv6 loopback'],
    ['::ffff:127.0.0.1', 'IPv4-mapped IPv6 loopback'],
    ['::ffff:192.168.1.1', 'IPv4-mapped IPv6 private'],
  ];

  for (const [ip, label] of privateAddresses) {
    test(`flags ${ip} (${label}) as private/reserved`, () => {
      assert.equal(isPrivateOrReservedAddress(ip), true);
    });
  }

  const publicAddresses = [
    ['8.8.8.8', "a public IPv4 address (not in any listed range)"],
    ['172.15.255.255', 'just below the 172.16/12 range'],
    ['172.32.0.0', 'just above the 172.16/12 range'],
    ['192.167.255.255', 'just below 192.168/16'],
    ['2001:4860:4860::8888', 'a public IPv6 address'],
  ];

  for (const [ip, label] of publicAddresses) {
    test(`does not flag ${ip} (${label})`, () => {
      assert.equal(isPrivateOrReservedAddress(ip), false);
    });
  }

  test('returns false for a non-IP string rather than throwing', () => {
    assert.equal(isPrivateOrReservedAddress('not-an-ip'), false);
  });
});

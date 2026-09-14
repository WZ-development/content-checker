'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { normalizeAndValidateUrl } = require('../../src/lib/urlValidation');

describe('normalizeAndValidateUrl — accept cases', () => {
  test('accepts an absolute https URL', async () => {
    const result = await normalizeAndValidateUrl('https://example.com/path');
    assert.deepEqual(result, { valid: true, url: 'https://example.com/path' });
  });

  test('accepts an absolute http URL', async () => {
    const result = await normalizeAndValidateUrl('http://example.com/');
    assert.equal(result.valid, true);
  });

  test('trims surrounding whitespace', async () => {
    const result = await normalizeAndValidateUrl('  https://example.com/path  ');
    assert.deepEqual(result, { valid: true, url: 'https://example.com/path' });
  });

  test('strips a trailing slash from a bare origin', async () => {
    const result = await normalizeAndValidateUrl('https://example.com/');
    assert.equal(result.url, 'https://example.com');
  });

  test('does not strip a trailing slash from a real path', async () => {
    const result = await normalizeAndValidateUrl('https://example.com/blog/');
    assert.equal(result.url, 'https://example.com/blog/');
  });
});

describe('normalizeAndValidateUrl — reject cases (acceptance criteria)', () => {
  test('rejects ftp://', async () => {
    const result = await normalizeAndValidateUrl('ftp://example.com/');
    assert.equal(result.valid, false);
    assert.ok(result.error);
  });

  test('rejects a bare domain with no scheme', async () => {
    const result = await normalizeAndValidateUrl('clientdomain.com');
    assert.equal(result.valid, false);
    assert.ok(result.error);
  });

  test('rejects an empty string', async () => {
    const result = await normalizeAndValidateUrl('');
    assert.equal(result.valid, false);
    assert.ok(result.error);
  });

  test('rejects whitespace only', async () => {
    const result = await normalizeAndValidateUrl('   ');
    assert.equal(result.valid, false);
    assert.ok(result.error);
  });

  test('rejects a literal private IPv4 address (http://192.168.1.10/)', async () => {
    const result = await normalizeAndValidateUrl('http://192.168.1.10/');
    assert.equal(result.valid, false);
    assert.ok(result.error);
  });

  test('rejects a literal loopback IPv4 address', async () => {
    const result = await normalizeAndValidateUrl('http://127.0.0.1:3000/');
    assert.equal(result.valid, false);
  });

  test('rejects a literal IPv6 loopback address', async () => {
    const result = await normalizeAndValidateUrl('http://[::1]/');
    assert.equal(result.valid, false);
  });

  test('rejects "localhost", which resolves to loopback via DNS (no network required)', async () => {
    const result = await normalizeAndValidateUrl('http://localhost:3000/');
    assert.equal(result.valid, false);
  });

  // QA1's Sprint 2 audit: the IPv4-mapped-IPv6 bracketed forms below all
  // reached the app as VALID before this fix. new URL() normalizes a
  // bracketed IPv6 host to its canonical hex-group form before
  // normalizeAndValidateUrl's SSRF check ever runs — go through
  // normalizeAndValidateUrl itself here, not just isPrivateOrReservedAddress
  // directly, or this exact bypass (the check being individually correct
  // but never receiving the string it actually gets fed) reproduces.
  test('rejects a bracketed IPv4-mapped IPv6 loopback address', async () => {
    const result = await normalizeAndValidateUrl('http://[::ffff:127.0.0.1]/');
    assert.equal(result.valid, false);
  });

  test('rejects a bracketed IPv4-mapped IPv6 address for the acceptance-criteria private IP (192.168.1.10)', async () => {
    const result = await normalizeAndValidateUrl('http://[::ffff:192.168.1.10]/');
    assert.equal(result.valid, false);
  });

  test('rejects a bracketed IPv4-mapped IPv6 address already in new URL()\'s normalized hex-group spelling', async () => {
    // What new URL() actually hands the validator for the two URLs
    // above — asserted directly so this test still catches a
    // regression even if URL's own normalization ever changed.
    const result = await normalizeAndValidateUrl('http://[::ffff:7f00:1]/');
    assert.equal(result.valid, false);
  });

  test('rejects a bracketed IPv4-mapped IPv6 address for 10.0.0.1', async () => {
    const result = await normalizeAndValidateUrl('http://[::ffff:10.0.0.1]/');
    assert.equal(result.valid, false);
  });

  test('non-numeric errors are distinct field-level messages, not just a boolean', async () => {
    const schemeError = await normalizeAndValidateUrl('ftp://example.com/');
    const privateError = await normalizeAndValidateUrl('http://192.168.1.10/');
    assert.notEqual(schemeError.error, privateError.error);
  });
});

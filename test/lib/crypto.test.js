'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { encrypt, decrypt } = require('../../src/lib/crypto');

const KEY = Buffer.from('ab'.repeat(32), 'hex');
const OTHER_KEY = Buffer.from('cd'.repeat(32), 'hex');

describe('encrypt/decrypt', () => {
  test('round-trips a plaintext password', () => {
    const encrypted = encrypt('sup3r-s3cret!', KEY);
    assert.equal(decrypt(encrypted, KEY), 'sup3r-s3cret!');
  });

  test('round-trips an empty string', () => {
    const encrypted = encrypt('', KEY);
    assert.equal(decrypt(encrypted, KEY), '');
  });

  test('round-trips unicode content', () => {
    const encrypted = encrypt('pässwörd-日本語', KEY);
    assert.equal(decrypt(encrypted, KEY), 'pässwörd-日本語');
  });

  test('generates a unique IV on every call, even for identical plaintext and key', () => {
    const first = encrypt('same-password', KEY);
    const second = encrypt('same-password', KEY);
    assert.notEqual(first, second, 'two encryptions of the same input must not be identical');

    const firstIv = first.split('.')[0];
    const secondIv = second.split('.')[0];
    assert.notEqual(firstIv, secondIv, 'IV must differ between calls — reuse breaks GCM');
  });

  test('decrypting with the wrong key throws rather than returning garbage', () => {
    const encrypted = encrypt('sup3r-s3cret!', KEY);
    assert.throws(() => decrypt(encrypted, OTHER_KEY));
  });

  test('decrypting a tampered ciphertext throws (authenticated encryption holds)', () => {
    const encrypted = encrypt('sup3r-s3cret!', KEY);
    const [iv, authTag, ciphertext] = encrypted.split('.');
    // Flip a byte in the ciphertext.
    const tamperedBuf = Buffer.from(ciphertext, 'base64url');
    tamperedBuf[0] ^= 0xff;
    const tampered = [iv, authTag, tamperedBuf.toString('base64url')].join('.');

    assert.throws(() => decrypt(tampered, KEY));
  });

  test('decrypting a malformed value throws', () => {
    assert.throws(() => decrypt('not-a-valid-encrypted-value', KEY));
    assert.throws(() => decrypt('a.b', KEY));
    assert.throws(() => decrypt('', KEY));
  });
});

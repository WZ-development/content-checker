'use strict';

const crypto = require('node:crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // 96-bit nonce, the size GCM is designed for
const AUTH_TAG_BYTES = 16;

/**
 * Encrypts plaintext with AES-256-GCM under `key` (a 32-byte Buffer — see
 * config.js's ENCRYPTION_KEY validation). Generates a fresh random IV on
 * every call: reusing an IV with the same key is the mistake that
 * silently destroys GCM's security property while every functional test
 * still passes, so there is no code path here that accepts a caller-
 * supplied IV.
 *
 * Returns a single string combining iv + authTag + ciphertext (each
 * base64url-encoded, dot-separated) — one opaque value to store, rather
 * than three separate columns to keep in sync.
 */
function encrypt(plaintext, key) {
  if (typeof plaintext !== 'string') {
    throw new TypeError('encrypt() requires a string plaintext');
  }

  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [iv, authTag, ciphertext].map((buf) => buf.toString('base64url')).join('.');
}

/**
 * Decrypts a value produced by encrypt(). Throws if the value is
 * malformed or — the property that matters — if it's been tampered with;
 * GCM's auth tag check fails closed rather than returning garbage
 * plaintext. Callers must not swallow that error.
 */
function decrypt(combined, key) {
  if (typeof combined !== 'string') {
    throw new TypeError('decrypt() requires a string');
  }

  const parts = combined.split('.');
  if (parts.length !== 3) {
    throw new Error('decrypt() received a malformed encrypted value');
  }

  const [ivB64, authTagB64, ciphertextB64] = parts;
  const iv = Buffer.from(ivB64, 'base64url');
  const authTag = Buffer.from(authTagB64, 'base64url');
  const ciphertext = Buffer.from(ciphertextB64, 'base64url');

  if (iv.length !== IV_BYTES || authTag.length !== AUTH_TAG_BYTES) {
    throw new Error('decrypt() received a malformed encrypted value');
  }

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}

module.exports = { encrypt, decrypt };

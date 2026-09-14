#!/usr/bin/env node
'use strict';

/**
 * Generates a value for ENCRYPTION_KEY: 32 random bytes, hex-encoded.
 *
 * Usage:
 *   npm run generate-encryption-key
 *
 * Prints only the key, so it's safe to pipe straight into a .env file:
 *   npm run generate-encryption-key >> .env
 */

const crypto = require('node:crypto');

console.log(`ENCRYPTION_KEY=${crypto.randomBytes(32).toString('hex')}`);

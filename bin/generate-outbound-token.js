#!/usr/bin/env node
'use strict';

/**
 * Generates a value for CONTENTCHECK_OUTBOUND_TOKEN: 32 random bytes,
 * hex-encoded (64 characters — comfortably over the 32-character
 * minimum src/config.js enforces).
 *
 * Usage:
 *   npm run generate-outbound-token
 *
 * Prints only the token, so it's safe to pipe straight into a .env file:
 *   npm run generate-outbound-token >> .env
 */

const crypto = require('node:crypto');

console.log(`CONTENTCHECK_OUTBOUND_TOKEN=${crypto.randomBytes(32).toString('hex')}`);

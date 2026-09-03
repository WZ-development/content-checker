#!/usr/bin/env node
'use strict';

/**
 * Generates a bcrypt hash for TEAM_PASSWORD_HASH.
 *
 * Usage:
 *   npm run hash-password -- 'your-team-password'
 *
 * Prints only the hash to stdout — never the plaintext password — so it's
 * safe to pipe straight into a .env file:
 *   npm run hash-password -- 'your-team-password' >> .env
 */

const bcrypt = require('bcryptjs');

const password = process.argv[2];

if (!password) {
  console.error('Usage: npm run hash-password -- \'your-team-password\'');
  process.exit(1);
}

const hash = bcrypt.hashSync(password, 12);
console.log(`TEAM_PASSWORD_HASH=${hash}`);

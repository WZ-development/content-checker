'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    live_url TEXT NOT NULL,
    staging_url TEXT NOT NULL,
    basic_auth_username TEXT,
    basic_auth_password_encrypted TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`;

/**
 * Opens (creating if needed) the single-file SQLite store and ensures the
 * schema exists. Pass ':memory:' for an isolated, on-disk-free database —
 * what the test suite uses so tests never share or pollute state.
 */
function openDatabase(dbPath) {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA_SQL);
  return db;
}

module.exports = { openDatabase };

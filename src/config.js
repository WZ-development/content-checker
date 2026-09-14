'use strict';

/**
 * Reads and validates all application configuration from environment
 * variables. Nothing in this module has a fallback for a secret — a
 * missing SESSION_SECRET, TEAM_PASSWORD_HASH, or ENCRYPTION_KEY must abort
 * startup with an explicit, named error rather than silently defaulting.
 *
 * Call loadConfig(env) with a plain object (defaults to process.env).
 * Throws a ConfigError naming the missing variable(s) if validation fails.
 */

const ENCRYPTION_KEY_BYTES = 32; // AES-256

const ENCRYPTION_KEY_HELP =
  'ENCRYPTION_KEY must be a 64-character hex string (32 bytes) for AES-256-GCM. ' +
  "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\" " +
  '(or npm run generate-encryption-key).';

class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

function requireNonEmpty(env, key) {
  const value = env[key];
  if (value === undefined || value === null || String(value).trim() === '') {
    throw new ConfigError(
      `Missing required environment variable: ${key}. Set it in your .env file (see .env.example) before starting the app.`
    );
  }
  return value;
}

/**
 * Normalizes a configured base path to a form with no trailing slash and
 * a leading slash, except the root case which normalizes to ''.
 * '/'              -> ''
 * '/content-check' -> '/content-check'
 * 'content-check'  -> '/content-check'
 * '/content-check/' -> '/content-check'
 */
function normalizeBasePath(raw) {
  let value = String(raw || '/').trim();
  if (value === '') value = '/';
  if (!value.startsWith('/')) value = `/${value}`;
  if (value.length > 1 && value.endsWith('/')) value = value.slice(0, -1);
  if (value === '/') return '';
  return value;
}

/**
 * Validates and decodes ENCRYPTION_KEY into the 32-byte Buffer
 * AES-256-GCM needs. Rejects anything that isn't exactly 64 hex
 * characters — including a key that's the right *string* length but the
 * wrong *byte* length because it wasn't valid hex, which a naive
 * `.length === 64` check would miss.
 */
function requireEncryptionKey(env) {
  const raw = requireNonEmpty(env, 'ENCRYPTION_KEY');

  if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
    throw new ConfigError(`Invalid environment variable: ${ENCRYPTION_KEY_HELP}`);
  }

  const key = Buffer.from(raw, 'hex');
  if (key.length !== ENCRYPTION_KEY_BYTES) {
    // Unreachable given the regex above, but this is the property that
    // actually matters for AES-256 — assert it directly rather than
    // trusting the regex to always be the only guard.
    throw new ConfigError(`Invalid environment variable: ${ENCRYPTION_KEY_HELP}`);
  }

  return key;
}

function loadConfig(env = process.env) {
  const sessionSecret = requireNonEmpty(env, 'SESSION_SECRET');
  const teamPasswordHash = requireNonEmpty(env, 'TEAM_PASSWORD_HASH');
  const encryptionKey = requireEncryptionKey(env);

  const port = Number.parseInt(env.PORT, 10);
  if (env.PORT !== undefined && Number.isNaN(port)) {
    throw new ConfigError(
      `Invalid environment variable: PORT must be a number, got "${env.PORT}".`
    );
  }

  return {
    port: Number.isNaN(port) ? 3000 : port,
    sessionSecret,
    teamPasswordHash,
    encryptionKey,
    basePath: normalizeBasePath(env.BASE_PATH),
    nodeEnv: env.NODE_ENV || 'development',
  };
}

module.exports = { loadConfig, normalizeBasePath, ConfigError };

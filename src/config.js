'use strict';

/**
 * Reads and validates all application configuration from environment
 * variables. Nothing in this module has a fallback for a secret — a
 * missing SESSION_SECRET or TEAM_PASSWORD_HASH must abort startup with an
 * explicit, named error rather than silently defaulting.
 *
 * Call loadConfig(env) with a plain object (defaults to process.env).
 * Throws a ConfigError naming the missing variable(s) if validation fails.
 */

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

function loadConfig(env = process.env) {
  const sessionSecret = requireNonEmpty(env, 'SESSION_SECRET');
  const teamPasswordHash = requireNonEmpty(env, 'TEAM_PASSWORD_HASH');

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
    basePath: normalizeBasePath(env.BASE_PATH),
    nodeEnv: env.NODE_ENV || 'development',
  };
}

module.exports = { loadConfig, normalizeBasePath, ConfigError };

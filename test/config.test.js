'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { loadConfig, ConfigError } = require('../src/config');

const VALID_ENV = {
  SESSION_SECRET: 'a-very-secret-value',
  TEAM_PASSWORD_HASH: '$2a$12$abcdefghijklmnopqrstuv',
};

describe('loadConfig', () => {
  test('throws a ConfigError naming SESSION_SECRET when it is missing', () => {
    const env = { TEAM_PASSWORD_HASH: VALID_ENV.TEAM_PASSWORD_HASH };
    assert.throws(
      () => loadConfig(env),
      (err) => {
        assert.ok(err instanceof ConfigError);
        assert.match(err.message, /SESSION_SECRET/);
        return true;
      }
    );
  });

  test('throws a ConfigError naming SESSION_SECRET when it is empty', () => {
    const env = { ...VALID_ENV, SESSION_SECRET: '   ' };
    assert.throws(
      () => loadConfig(env),
      (err) => {
        assert.ok(err instanceof ConfigError);
        assert.match(err.message, /SESSION_SECRET/);
        return true;
      }
    );
  });

  test('throws a ConfigError naming TEAM_PASSWORD_HASH when it is missing', () => {
    const env = { SESSION_SECRET: VALID_ENV.SESSION_SECRET };
    assert.throws(
      () => loadConfig(env),
      (err) => {
        assert.ok(err instanceof ConfigError);
        assert.match(err.message, /TEAM_PASSWORD_HASH/);
        return true;
      }
    );
  });

  test('loads successfully with all required variables present', () => {
    const config = loadConfig(VALID_ENV);
    assert.equal(config.sessionSecret, VALID_ENV.SESSION_SECRET);
    assert.equal(config.teamPasswordHash, VALID_ENV.TEAM_PASSWORD_HASH);
    assert.equal(config.port, 3000);
    assert.equal(config.basePath, '');
  });

  test('defaults BASE_PATH "/" to the empty (root) base path', () => {
    const config = loadConfig({ ...VALID_ENV, BASE_PATH: '/' });
    assert.equal(config.basePath, '');
  });

  test('normalizes a production-style BASE_PATH', () => {
    const config = loadConfig({ ...VALID_ENV, BASE_PATH: '/content-check' });
    assert.equal(config.basePath, '/content-check');
  });

  test('parses a numeric PORT', () => {
    const config = loadConfig({ ...VALID_ENV, PORT: '4321' });
    assert.equal(config.port, 4321);
  });

  test('rejects a non-numeric PORT', () => {
    const env = { ...VALID_ENV, PORT: 'not-a-number' };
    assert.throws(
      () => loadConfig(env),
      (err) => {
        assert.ok(err instanceof ConfigError);
        assert.match(err.message, /PORT/);
        return true;
      }
    );
  });
});

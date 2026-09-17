'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { loadConfig, ConfigError } = require('../src/config');

const VALID_ENCRYPTION_KEY = 'ab'.repeat(32); // 64 hex chars = 32 bytes

const VALID_ENV = {
  SESSION_SECRET: 'a-very-secret-value',
  TEAM_PASSWORD_HASH: '$2a$12$abcdefghijklmnopqrstuv',
  ENCRYPTION_KEY: VALID_ENCRYPTION_KEY,
};

describe('loadConfig', () => {
  test('throws a ConfigError naming SESSION_SECRET when it is missing', () => {
    const env = {
      TEAM_PASSWORD_HASH: VALID_ENV.TEAM_PASSWORD_HASH,
      ENCRYPTION_KEY: VALID_ENV.ENCRYPTION_KEY,
    };
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
    const env = {
      SESSION_SECRET: VALID_ENV.SESSION_SECRET,
      ENCRYPTION_KEY: VALID_ENV.ENCRYPTION_KEY,
    };
    assert.throws(
      () => loadConfig(env),
      (err) => {
        assert.ok(err instanceof ConfigError);
        assert.match(err.message, /TEAM_PASSWORD_HASH/);
        return true;
      }
    );
  });

  test('throws a ConfigError naming ENCRYPTION_KEY when it is missing', () => {
    const env = {
      SESSION_SECRET: VALID_ENV.SESSION_SECRET,
      TEAM_PASSWORD_HASH: VALID_ENV.TEAM_PASSWORD_HASH,
    };
    assert.throws(
      () => loadConfig(env),
      (err) => {
        assert.ok(err instanceof ConfigError);
        assert.match(err.message, /ENCRYPTION_KEY/);
        return true;
      }
    );
  });

  test('throws a ConfigError naming ENCRYPTION_KEY when it is the wrong length', () => {
    const env = { ...VALID_ENV, ENCRYPTION_KEY: 'abcd1234' }; // valid hex, wrong byte length
    assert.throws(
      () => loadConfig(env),
      (err) => {
        assert.ok(err instanceof ConfigError);
        assert.match(err.message, /ENCRYPTION_KEY/);
        return true;
      }
    );
  });

  test('throws a ConfigError naming ENCRYPTION_KEY when it is not valid hex', () => {
    // 64 characters, the right *string* length, but not hex — must not
    // slip past a naive length-only check.
    const env = { ...VALID_ENV, ENCRYPTION_KEY: 'z'.repeat(64) };
    assert.throws(
      () => loadConfig(env),
      (err) => {
        assert.ok(err instanceof ConfigError);
        assert.match(err.message, /ENCRYPTION_KEY/);
        return true;
      }
    );
  });

  test('loads successfully with all required variables present', () => {
    const config = loadConfig(VALID_ENV);
    assert.equal(config.sessionSecret, VALID_ENV.SESSION_SECRET);
    assert.equal(config.teamPasswordHash, VALID_ENV.TEAM_PASSWORD_HASH);
    assert.ok(Buffer.isBuffer(config.encryptionKey));
    assert.equal(config.encryptionKey.length, 32);
    assert.equal(config.encryptionKey.toString('hex'), VALID_ENCRYPTION_KEY);
    assert.equal(config.port, 3000);
    assert.equal(config.basePath, '');
  });

  describe('CONTENTCHECK_OUTBOUND_TOKEN (sprint 7, requirement 2)', () => {
    test('is undefined when unset — optional, not a required variable', () => {
      const config = loadConfig(VALID_ENV);
      assert.equal(config.outboundToken, undefined);
    });

    test('is undefined when set to an empty/whitespace-only string', () => {
      const config = loadConfig({ ...VALID_ENV, CONTENTCHECK_OUTBOUND_TOKEN: '   ' });
      assert.equal(config.outboundToken, undefined);
    });

    test('throws a ConfigError naming the variable when set but shorter than 32 characters', () => {
      const env = { ...VALID_ENV, CONTENTCHECK_OUTBOUND_TOKEN: 'too-short' };
      assert.throws(
        () => loadConfig(env),
        (err) => {
          assert.ok(err instanceof ConfigError);
          assert.match(err.message, /CONTENTCHECK_OUTBOUND_TOKEN/);
          assert.match(err.message, /32/);
          return true;
        }
      );
    });

    test('accepts a value that is exactly 32 characters', () => {
      const token = 'a'.repeat(32);
      const config = loadConfig({ ...VALID_ENV, CONTENTCHECK_OUTBOUND_TOKEN: token });
      assert.equal(config.outboundToken, token);
    });

    test('accepts a longer generated-style token unchanged', () => {
      const token = require('node:crypto').randomBytes(32).toString('hex'); // 64 chars
      const config = loadConfig({ ...VALID_ENV, CONTENTCHECK_OUTBOUND_TOKEN: token });
      assert.equal(config.outboundToken, token);
    });
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

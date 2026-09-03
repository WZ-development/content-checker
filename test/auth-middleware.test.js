'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { createRequireAuth } = require('../src/middleware/auth');
const { createUrlHelper } = require('../src/lib/url');

function makeRes() {
  const calls = { redirects: [] };
  const res = {
    redirect(status, location) {
      calls.redirects.push({ status, location });
    },
  };
  return { res, calls };
}

describe('requireAuth middleware', () => {
  test('calls next() when the session is authenticated', () => {
    const requireAuth = createRequireAuth(createUrlHelper(''));
    const req = { session: { authenticated: true } };
    const { res, calls } = makeRes();
    let nextCalled = false;

    requireAuth(req, res, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, true);
    assert.equal(calls.redirects.length, 0);
  });

  test('redirects to login (302) when there is no session', () => {
    const requireAuth = createRequireAuth(createUrlHelper(''));
    const req = { session: undefined };
    const { res, calls } = makeRes();

    requireAuth(req, res, () => {
      assert.fail('next() should not be called for an unauthenticated request');
    });

    assert.deepEqual(calls.redirects, [{ status: 302, location: '/login' }]);
  });

  test('redirects to login when the session exists but is not authenticated', () => {
    const requireAuth = createRequireAuth(createUrlHelper(''));
    const req = { session: { authenticated: false } };
    const { res, calls } = makeRes();

    requireAuth(req, res, () => {
      assert.fail('next() should not be called for an unauthenticated request');
    });

    assert.deepEqual(calls.redirects, [{ status: 302, location: '/login' }]);
  });

  test('redirect target honours a non-root BASE_PATH', () => {
    const requireAuth = createRequireAuth(createUrlHelper('/content-check'));
    const req = { session: undefined };
    const { res, calls } = makeRes();

    requireAuth(req, res, () => {});

    assert.deepEqual(calls.redirects, [
      { status: 302, location: '/content-check/login' },
    ]);
  });
});

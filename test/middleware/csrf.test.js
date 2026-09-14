'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { attachCsrfToken, verifyCsrfToken } = require('../../src/middleware/csrf');

function makeRes() {
  const calls = { renders: [] };
  const res = {
    locals: {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    render(view, data) {
      calls.renders.push({ view, data, status: this.statusCode });
    },
  };
  return { res, calls };
}

describe('attachCsrfToken', () => {
  test('generates a token when the session has none, and exposes it via res.locals', () => {
    const req = { session: {} };
    const { res } = makeRes();

    attachCsrfToken(req, res, () => {});

    assert.ok(req.session.csrfToken);
    assert.equal(res.locals.csrfToken, req.session.csrfToken);
  });

  test('reuses an existing session token rather than regenerating it', () => {
    const req = { session: { csrfToken: 'existing-token' } };
    const { res } = makeRes();

    attachCsrfToken(req, res, () => {});

    assert.equal(req.session.csrfToken, 'existing-token');
    assert.equal(res.locals.csrfToken, 'existing-token');
  });

  test('calls next()', () => {
    const req = { session: {} };
    const { res } = makeRes();
    let nextCalled = false;

    attachCsrfToken(req, res, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, true);
  });
});

describe('verifyCsrfToken', () => {
  test('calls next() when the submitted token matches the session token', () => {
    const req = { session: { csrfToken: 'the-real-token' }, body: { _csrf: 'the-real-token' } };
    const { res, calls } = makeRes();
    let nextCalled = false;

    verifyCsrfToken(req, res, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, true);
    assert.equal(calls.renders.length, 0);
  });

  test('rejects with a rendered error page (not JSON) when the token is missing from the body', () => {
    const req = { session: { csrfToken: 'the-real-token' }, body: {} };
    const { res, calls } = makeRes();

    verifyCsrfToken(req, res, () => {
      assert.fail('next() should not be called on a missing token');
    });

    assert.equal(calls.renders.length, 1);
    assert.equal(calls.renders[0].status, 403);
    assert.equal(calls.renders[0].view, 'error');
  });

  test('rejects when the submitted token is wrong', () => {
    const req = { session: { csrfToken: 'the-real-token' }, body: { _csrf: 'wrong-token' } };
    const { res, calls } = makeRes();

    verifyCsrfToken(req, res, () => {
      assert.fail('next() should not be called on a wrong token');
    });

    assert.equal(calls.renders[0].status, 403);
  });

  test('rejects when the session has no token at all', () => {
    const req = { session: {}, body: { _csrf: 'anything' } };
    const { res, calls } = makeRes();

    verifyCsrfToken(req, res, () => {
      assert.fail('next() should not be called with no session token');
    });

    assert.equal(calls.renders[0].status, 403);
  });

  test('does not throw on a submitted token of a different length than the real one', () => {
    // A naive crypto.timingSafeEqual call throws on a length mismatch —
    // this must be handled, not left to crash into a 500.
    const req = { session: { csrfToken: 'short' }, body: { _csrf: 'a-much-much-longer-token-value' } };
    const { res, calls } = makeRes();

    assert.doesNotThrow(() => {
      verifyCsrfToken(req, res, () => {
        assert.fail('next() should not be called on a mismatched token');
      });
    });
    assert.equal(calls.renders[0].status, 403);
  });
});

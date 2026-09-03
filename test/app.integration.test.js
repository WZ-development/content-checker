'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const request = require('supertest');

const { createApp } = require('../src/app');

const TEST_PASSWORD = 'correct-horse-battery-staple';
const TEAM_PASSWORD_HASH = bcrypt.hashSync(TEST_PASSWORD, 4); // low cost factor: tests only

function buildConfig(overrides = {}) {
  return {
    port: 0,
    sessionSecret: 'test-session-secret',
    teamPasswordHash: TEAM_PASSWORD_HASH,
    basePath: '',
    nodeEnv: 'test',
    ...overrides,
  };
}

describe('GET /healthz', () => {
  test('is reachable without authentication and returns 200 JSON', async () => {
    const app = createApp(buildConfig());
    const res = await request(app).get('/healthz');
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'ok');
  });

  test('honours a non-root BASE_PATH', async () => {
    const app = createApp(buildConfig({ basePath: '/content-check' }));
    const res = await request(app).get('/content-check/healthz');
    assert.equal(res.status, 200);
  });
});

describe('protected routes', () => {
  test('an unauthenticated request to a protected route redirects to login (302), not 500', async () => {
    const app = createApp(buildConfig());
    const res = await request(app).get('/');
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, '/login');
  });
});

describe('login flow', () => {
  test('wrong password returns a generic failure message, not a 500 or specific reason', async () => {
    const app = createApp(buildConfig());
    const res = await request(app)
      .post('/login')
      .type('form')
      .send({ password: 'definitely-wrong' });

    assert.equal(res.status, 401);
    assert.match(res.text, /Incorrect password/);
    // Never leaks anything about the real password.
    assert.doesNotMatch(res.text, new RegExp(TEST_PASSWORD));
  });

  test('correct password sets an httpOnly, SameSite=Lax session cookie and redirects in', async () => {
    const app = createApp(buildConfig());
    const res = await request(app)
      .post('/login')
      .type('form')
      .send({ password: TEST_PASSWORD });

    assert.equal(res.status, 302);
    assert.equal(res.headers.location, '/');

    const setCookie = res.headers['set-cookie'];
    assert.ok(setCookie, 'expected a Set-Cookie header');
    const sessionCookie = setCookie.find((c) => c.startsWith('content-checker.sid='));
    assert.ok(sessionCookie, 'expected the session cookie to be set');
    assert.match(sessionCookie, /HttpOnly/i);
    assert.match(sessionCookie, /SameSite=Lax/i);
  });

  test('session cookie is scoped to BASE_PATH, not the whole domain', async () => {
    const rootApp = createApp(buildConfig());
    const rootRes = await request(rootApp)
      .post('/login')
      .type('form')
      .send({ password: TEST_PASSWORD });
    const rootCookie = rootRes.headers['set-cookie'].find((c) =>
      c.startsWith('content-checker.sid=')
    );
    assert.match(rootCookie, /Path=\//i);

    const subpathApp = createApp(buildConfig({ basePath: '/content-check' }));
    const subpathRes = await request(subpathApp)
      .post('/content-check/login')
      .type('form')
      .send({ password: TEST_PASSWORD });
    const subpathCookie = subpathRes.headers['set-cookie'].find((c) =>
      c.startsWith('content-checker.sid=')
    );
    assert.match(subpathCookie, /Path=\/content-check/i);
  });

  test('a session established by login can reach the protected landing page', async () => {
    const app = createApp(buildConfig());
    const agent = request.agent(app);

    await agent.post('/login').type('form').send({ password: TEST_PASSWORD });
    const res = await agent.get('/');

    assert.equal(res.status, 200);
    assert.match(res.text, /You're authenticated/);
  });

  test('login rate limiter rejects after the configured ceiling, rendering the login page rather than JSON', async () => {
    const app = createApp(buildConfig());
    const agent = request.agent(app);

    let lastRes;
    for (let i = 0; i < 11; i += 1) {
      lastRes = await agent.post('/login').type('form').send({ password: 'wrong-every-time' });
    }

    assert.equal(lastRes.status, 429);
    assert.match(lastRes.headers['content-type'], /text\/html/);
    assert.ok(lastRes.headers['retry-after'], 'expected a Retry-After header');
    assert.match(lastRes.text, /Too many login attempts/);
    // Never lies to the user by reusing the wrong-password copy.
    assert.doesNotMatch(lastRes.text, /Incorrect password/);
  });

  test('rate limiter never tells a correct password it was wrong', async () => {
    const app = createApp(buildConfig());
    const agent = request.agent(app);

    // Trip the limiter with 10 attempts (any outcome counts against it).
    for (let i = 0; i < 10; i += 1) {
      await agent.post('/login').type('form').send({ password: 'wrong-every-time' });
    }

    // The 11th attempt uses the CORRECT password but is still rate-limited.
    const res = await agent.post('/login').type('form').send({ password: TEST_PASSWORD });

    assert.equal(res.status, 429);
    assert.doesNotMatch(res.text, /Incorrect password/);
    assert.match(res.text, /Too many login attempts/);
  });
});

describe('logout', () => {
  test('destroys the session and the protected route becomes inaccessible again', async () => {
    const app = createApp(buildConfig());
    const agent = request.agent(app);

    await agent.post('/login').type('form').send({ password: TEST_PASSWORD });
    assert.equal((await agent.get('/')).status, 200);

    const logoutRes = await agent.post('/logout');
    assert.equal(logoutRes.status, 302);
    assert.equal(logoutRes.headers.location, '/login');

    const afterLogout = await agent.get('/');
    assert.equal(afterLogout.status, 302);
    assert.equal(afterLogout.headers.location, '/login');
  });

  test('clears the actual session cookie by name, not the express-session default', async () => {
    const app = createApp(buildConfig());
    const agent = request.agent(app);

    await agent.post('/login').type('form').send({ password: TEST_PASSWORD });
    const logoutRes = await agent.post('/logout');

    const cleared = logoutRes.headers['set-cookie'].find((c) =>
      c.startsWith('content-checker.sid=')
    );
    assert.ok(cleared, 'expected a Set-Cookie clearing content-checker.sid');
    assert.match(cleared, /Expires=Thu, 01 Jan 1970/);
    // Never the stale, unused express-session default name.
    assert.ok(
      !logoutRes.headers['set-cookie'].some((c) => c.startsWith('connect.sid=')),
      'should not clear a cookie named connect.sid — this app never sets one'
    );
  });
});

describe('Cache-Control on authenticated responses', () => {
  test('protected pages are sent no-store, so a Back button cannot resurrect them after logout', async () => {
    const app = createApp(buildConfig());
    const agent = request.agent(app);

    await agent.post('/login').type('form').send({ password: TEST_PASSWORD });
    const res = await agent.get('/');

    assert.equal(res.status, 200);
    assert.match(res.headers['cache-control'], /no-store/);
  });
});

describe('BASE_PATH honoured in rendered templates', () => {
  test('every internal href/action/asset src is prefixed with BASE_PATH', async () => {
    const app = createApp(buildConfig({ basePath: '/content-check' }));
    const res = await request(app).get('/content-check/login');

    assert.equal(res.status, 200);
    assert.match(res.text, /href="\/content-check\/style\.css"/);
    assert.match(res.text, /action="\/content-check\/login"/);

    // No absolute internal path escapes the BASE_PATH prefix.
    assert.doesNotMatch(res.text, /href="\/(?!content-check)/);
    assert.doesNotMatch(res.text, /action="\/(?!content-check)/);
  });
});

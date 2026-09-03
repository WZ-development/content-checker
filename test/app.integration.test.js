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

  test('a session established by login can reach the protected landing page', async () => {
    const app = createApp(buildConfig());
    const agent = request.agent(app);

    await agent.post('/login').type('form').send({ password: TEST_PASSWORD });
    const res = await agent.get('/');

    assert.equal(res.status, 200);
    assert.match(res.text, /You're authenticated/);
  });

  test('login rate limiter rejects after the configured ceiling', async () => {
    const app = createApp(buildConfig());
    const agent = request.agent(app);

    let lastStatus;
    for (let i = 0; i < 11; i += 1) {
      const res = await agent
        .post('/login')
        .type('form')
        .send({ password: 'wrong-every-time' });
      lastStatus = res.status;
    }

    assert.equal(lastStatus, 429);
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

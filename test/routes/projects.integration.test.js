'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const request = require('supertest');

const { createApp } = require('../../src/app');
const { openDatabase } = require('../../src/db/database');
const { createProjectsRepository } = require('../../src/db/projectsRepository');

const TEST_PASSWORD = 'correct-horse-battery-staple';
const TEAM_PASSWORD_HASH = bcrypt.hashSync(TEST_PASSWORD, 4); // low cost factor: tests only
const TEST_ENCRYPTION_KEY = Buffer.from('ab'.repeat(32), 'hex');

function buildConfig(overrides = {}) {
  return {
    port: 0,
    sessionSecret: 'test-session-secret',
    teamPasswordHash: TEAM_PASSWORD_HASH,
    encryptionKey: TEST_ENCRYPTION_KEY,
    basePath: '',
    nodeEnv: 'test',
    ...overrides,
  };
}

/** Fresh app + fresh in-memory database per call — no shared state. */
function createTestApp(overrides = {}) {
  const repository = createProjectsRepository(openDatabase(':memory:'), TEST_ENCRYPTION_KEY);
  return createApp(buildConfig(overrides), { repository });
}

async function loginAgent(app) {
  const agent = request.agent(app);
  await agent.post('/login').type('form').send({ password: TEST_PASSWORD });
  return agent;
}

function extractCsrfToken(html) {
  const match = html.match(/name="_csrf" value="([^"]+)"/);
  assert.ok(match, 'expected a _csrf hidden field in the rendered form');
  return match[1];
}

describe('auth gate on project routes', () => {
  test('GET /projects redirects to login when unauthenticated', async () => {
    const app = createTestApp();
    const res = await request(app).get('/projects');
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, '/login');
  });
});

describe('Cache-Control on project screens (requirement 11)', () => {
  test('the project list and edit screens carry Cache-Control: no-store', async () => {
    const app = createTestApp();
    const agent = await loginAgent(app);

    const listRes = await agent.get('/projects');
    assert.match(listRes.headers['cache-control'], /no-store/);

    const newFormHtml = (await agent.get('/projects/new')).text;
    const csrfToken = extractCsrfToken(newFormHtml);
    await agent.post('/projects').type('form').send({
      _csrf: csrfToken,
      name: 'Acme',
      liveUrl: 'https://acme.com',
      stagingUrl: 'https://staging.acme.com',
    });
    const id = (await agent.get('/projects')).text.match(/projects\/([^/]+)\/edit/)[1];

    const editRes = await agent.get(`/projects/${id}/edit`);
    assert.match(editRes.headers['cache-control'], /no-store/);
  });
});

describe('CSRF protection on state-changing routes (requirement 10)', () => {
  test('POST /projects with a missing CSRF token is rejected with a rendered error, not a raw JSON body', async () => {
    const app = createTestApp();
    const agent = await loginAgent(app);

    const res = await agent.post('/projects').type('form').send({
      name: 'No Token',
      liveUrl: 'https://example.com',
      stagingUrl: 'https://staging.example.com',
    });

    assert.equal(res.status, 403);
    assert.match(res.headers['content-type'], /text\/html/);
    assert.doesNotMatch(res.text, /^\{/);
  });

  test('POST /projects with an invalid CSRF token is rejected', async () => {
    const app = createTestApp();
    const agent = await loginAgent(app);

    const res = await agent.post('/projects').type('form').send({
      _csrf: 'not-the-real-token',
      name: 'Bad Token',
      liveUrl: 'https://example.com',
      stagingUrl: 'https://staging.example.com',
    });

    assert.equal(res.status, 403);
  });

  test('POST /projects with a valid CSRF token succeeds', async () => {
    const app = createTestApp();
    const agent = await loginAgent(app);

    const csrfToken = extractCsrfToken((await agent.get('/projects/new')).text);
    const res = await agent.post('/projects').type('form').send({
      _csrf: csrfToken,
      name: 'Valid Token',
      liveUrl: 'https://example.com',
      stagingUrl: 'https://staging.example.com',
    });

    assert.equal(res.status, 302);
    assert.equal(res.headers.location, '/projects');
  });

  test('edit and delete routes are equally protected', async () => {
    const app = createTestApp();
    const agent = await loginAgent(app);

    const csrfToken = extractCsrfToken((await agent.get('/projects/new')).text);
    await agent.post('/projects').type('form').send({
      _csrf: csrfToken,
      name: 'Target',
      liveUrl: 'https://example.com',
      stagingUrl: 'https://staging.example.com',
    });
    const listHtml = (await agent.get('/projects')).text;
    const id = listHtml.match(/projects\/([^/]+)\/edit/)[1];

    const editWithoutToken = await agent.post(`/projects/${id}`).type('form').send({
      name: 'Renamed',
      liveUrl: 'https://example.com',
      stagingUrl: 'https://staging.example.com',
    });
    assert.equal(editWithoutToken.status, 403);

    const deleteWithoutToken = await agent.post(`/projects/${id}/delete`).type('form').send({});
    assert.equal(deleteWithoutToken.status, 403);

    // The project must still exist — neither rejected mutation applied.
    assert.match((await agent.get('/projects')).text, /Target/);
  });
});

describe('URL validation on save (field-level errors, requirement 6/7)', () => {
  async function attemptCreate(agent, overrides) {
    const csrfToken = extractCsrfToken((await agent.get('/projects/new')).text);
    return agent.post('/projects').type('form').send({
      _csrf: csrfToken,
      name: 'Test Project',
      liveUrl: 'https://example.com',
      stagingUrl: 'https://staging.example.com',
      ...overrides,
    });
  }

  test('rejects ftp:// with a field-level error message', async () => {
    const app = createTestApp();
    const agent = await loginAgent(app);
    const res = await attemptCreate(agent, { liveUrl: 'ftp://example.com' });
    assert.equal(res.status, 400);
    assert.match(res.text, /http:\/\/ or https:\/\//);
  });

  test('rejects a bare domain with no scheme', async () => {
    const app = createTestApp();
    const agent = await loginAgent(app);
    const res = await attemptCreate(agent, { liveUrl: 'clientdomain.com' });
    assert.equal(res.status, 400);
  });

  test('rejects an empty URL field', async () => {
    const app = createTestApp();
    const agent = await loginAgent(app);
    const res = await attemptCreate(agent, { stagingUrl: '' });
    assert.equal(res.status, 400);
  });

  test('rejects http://192.168.1.10/ as a private address', async () => {
    const app = createTestApp();
    const agent = await loginAgent(app);
    const res = await attemptCreate(agent, { stagingUrl: 'http://192.168.1.10/' });
    assert.equal(res.status, 400);
    assert.match(res.text, /private|loopback|link-local/);
  });

  test('an invalid submission re-renders the form with the previously entered values intact', async () => {
    const app = createTestApp();
    const agent = await loginAgent(app);
    const res = await attemptCreate(agent, { name: 'Keep Me', liveUrl: 'not-a-url' });
    assert.equal(res.status, 400);
    assert.match(res.text, /value="Keep Me"/);
  });
});

describe('full CRUD flow and the blank-keeps-password rule, end to end over HTTP', () => {
  test('create, list, edit (blank keeps password), edit (new password), clear, delete', async () => {
    const app = createTestApp();
    const agent = await loginAgent(app);

    // Create with a password.
    const createCsrf = extractCsrfToken((await agent.get('/projects/new')).text);
    await agent.post('/projects').type('form').send({
      _csrf: createCsrf,
      name: 'Full Flow Co',
      liveUrl: 'https://fullflow.com/',
      stagingUrl: 'https://staging.fullflow.com/',
      basicAuthUsername: 'deployer',
      basicAuthPassword: 'first-password',
    });

    const listHtml1 = (await agent.get('/projects')).text;
    assert.match(listHtml1, /Full Flow Co/);
    assert.match(listHtml1, /Password stored/);
    // The encrypted value must never leak into any rendered response.
    assert.doesNotMatch(listHtml1, /first-password/);

    const id = listHtml1.match(/projects\/([^/]+)\/edit/)[1];

    // Edit form shows the stored-password indicator, password field empty.
    const editHtml1 = (await agent.get(`/projects/${id}/edit`)).text;
    assert.match(editHtml1, /A password is currently stored/);
    assert.doesNotMatch(editHtml1, /first-password/);
    assert.doesNotMatch(editHtml1, /value="[^"]*first-password/);

    // Save with the password field blank — must keep the original.
    const editCsrf1 = extractCsrfToken(editHtml1);
    await agent.post(`/projects/${id}`).type('form').send({
      _csrf: editCsrf1,
      name: 'Full Flow Co',
      liveUrl: 'https://fullflow.com/',
      stagingUrl: 'https://staging.fullflow.com/',
      basicAuthUsername: 'deployer',
      basicAuthPassword: '',
    });
    assert.equal((await agent.get(`/projects/${id}/edit`)).text.includes('A password is currently stored'), true);

    // Save with a new password — it replaces the old one (verified at
    // the repository/crypto layer in projectsRepository.test.js; here we
    // confirm the HTTP-visible behavior: still shows "stored").
    const editHtml2 = (await agent.get(`/projects/${id}/edit`)).text;
    const editCsrf2 = extractCsrfToken(editHtml2);
    await agent.post(`/projects/${id}`).type('form').send({
      _csrf: editCsrf2,
      name: 'Full Flow Co',
      liveUrl: 'https://fullflow.com/',
      stagingUrl: 'https://staging.fullflow.com/',
      basicAuthUsername: 'deployer',
      basicAuthPassword: 'second-password',
    });

    // Clear credentials.
    const editHtml3 = (await agent.get(`/projects/${id}/edit`)).text;
    assert.match(editHtml3, /Clear stored credentials/);
    const editCsrf3 = extractCsrfToken(editHtml3);
    await agent.post(`/projects/${id}`).type('form').send({
      _csrf: editCsrf3,
      name: 'Full Flow Co',
      liveUrl: 'https://fullflow.com/',
      stagingUrl: 'https://staging.fullflow.com/',
      clearCredentials: 'on',
    });

    const listHtml2 = (await agent.get('/projects')).text;
    assert.match(listHtml2, /No password/);

    // Delete requires the confirmation step.
    const confirmHtml = (await agent.get(`/projects/${id}/delete`)).text;
    assert.match(confirmHtml, /Full Flow Co/);
    assert.match(confirmHtml, /cannot be undone/);
    const deleteCsrf = extractCsrfToken(confirmHtml);

    await agent.post(`/projects/${id}/delete`).type('form').send({ _csrf: deleteCsrf });

    const listHtml3 = (await agent.get('/projects')).text;
    assert.doesNotMatch(listHtml3, /Full Flow Co/);
    assert.match(listHtml3, /No projects yet/);
  });

  test('GET /projects/:id/edit for an unknown id renders a 404, not a crash', async () => {
    const app = createTestApp();
    const agent = await loginAgent(app);
    const res = await agent.get('/projects/does-not-exist/edit');
    assert.equal(res.status, 404);
  });

  test('deleting is a distinct confirmation step, not a one-click action', async () => {
    const app = createTestApp();
    const agent = await loginAgent(app);

    const createCsrf = extractCsrfToken((await agent.get('/projects/new')).text);
    await agent.post('/projects').type('form').send({
      _csrf: createCsrf,
      name: 'Careful Co',
      liveUrl: 'https://careful.com',
      stagingUrl: 'https://staging.careful.com',
    });

    const listHtml = (await agent.get('/projects')).text;
    assert.match(listHtml, /projects\/[^/]+\/delete/, 'the delete link goes to a confirmation GET, not directly to a POST');
  });
});

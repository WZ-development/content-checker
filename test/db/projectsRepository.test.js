'use strict';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { openDatabase } = require('../../src/db/database');
const { createProjectsRepository } = require('../../src/db/projectsRepository');
const { decrypt } = require('../../src/lib/crypto');

const KEY = Buffer.from('ab'.repeat(32), 'hex');

let db;
let repo;

beforeEach(() => {
  db = openDatabase(':memory:');
  repo = createProjectsRepository(db, KEY);
});

function baseValues(overrides = {}) {
  return {
    name: 'Acme',
    liveUrl: 'https://acme.com',
    stagingUrl: 'https://staging.acme.com',
    basicAuthUsername: '',
    passwordAction: 'none',
    rawPassword: '',
    ...overrides,
  };
}

describe('createProject / listProjects / getProjectForEdit', () => {
  test('creates a project and lists it back without exposing any password field', () => {
    repo.createProject(baseValues({ name: 'Acme', passwordAction: 'set', rawPassword: 'hunter2' }));

    const [project] = repo.listProjects();
    assert.equal(project.name, 'Acme');
    assert.equal(project.liveUrl, 'https://acme.com');
    assert.equal(project.stagingUrl, 'https://staging.acme.com');
    assert.equal(project.hasPassword, true);
    assert.equal('basicAuthPasswordEncrypted' in project, false);
    assert.equal('rawPassword' in project, false);
    assert.equal(JSON.stringify(project).toLowerCase().includes('hunter2'), false);
  });

  test('a project created with no password reports hasPassword: false', () => {
    repo.createProject(baseValues({ passwordAction: 'none' }));
    const [project] = repo.listProjects();
    assert.equal(project.hasPassword, false);
  });

  test('getProjectForEdit returns null for an unknown id', () => {
    assert.equal(repo.getProjectForEdit('does-not-exist'), null);
  });
});

describe('the blank-field-keeps-existing-password rule (requirement 5)', () => {
  test('editing with the password field blank keeps the original password', () => {
    const id = repo.createProject(
      baseValues({ passwordAction: 'set', rawPassword: 'original-pw' })
    );

    repo.updateProject(
      id,
      baseValues({ name: 'Acme Renamed', passwordAction: 'keep', rawPassword: '' })
    );

    const updated = repo.getProjectForEdit(id);
    assert.equal(updated.name, 'Acme Renamed');
    assert.equal(updated.hasPassword, true);
    assert.equal(repo.getDecryptedBasicAuthPassword(id), 'original-pw');
  });

  test('editing with a new password replaces the old one', () => {
    const id = repo.createProject(baseValues({ passwordAction: 'set', rawPassword: 'old-pw' }));

    repo.updateProject(id, baseValues({ passwordAction: 'set', rawPassword: 'new-pw' }));

    assert.equal(repo.getDecryptedBasicAuthPassword(id), 'new-pw');
  });

  test('the clear-credentials control removes the password entirely', () => {
    const id = repo.createProject(baseValues({ passwordAction: 'set', rawPassword: 'to-be-cleared' }));

    repo.updateProject(id, baseValues({ passwordAction: 'clear' }));

    const updated = repo.getProjectForEdit(id);
    assert.equal(updated.hasPassword, false);
    assert.equal(repo.getDecryptedBasicAuthPassword(id), null);
  });

  test('all three transitions in sequence, as the acceptance criteria describe', () => {
    const id = repo.createProject(
      baseValues({ basicAuthUsername: 'admin', passwordAction: 'set', rawPassword: 'first-pw' })
    );
    assert.equal(repo.getDecryptedBasicAuthPassword(id), 'first-pw');

    // Save again with password blank — original must still decrypt.
    repo.updateProject(
      id,
      baseValues({ basicAuthUsername: 'admin', passwordAction: 'keep', rawPassword: '' })
    );
    assert.equal(repo.getDecryptedBasicAuthPassword(id), 'first-pw');

    // Save with a new value — it replaces the old one.
    repo.updateProject(
      id,
      baseValues({ basicAuthUsername: 'admin', passwordAction: 'set', rawPassword: 'second-pw' })
    );
    assert.equal(repo.getDecryptedBasicAuthPassword(id), 'second-pw');

    // Use the clear control — it's gone.
    repo.updateProject(id, baseValues({ passwordAction: 'clear' }));
    assert.equal(repo.getDecryptedBasicAuthPassword(id), null);
    assert.equal(repo.getProjectForEdit(id).hasPassword, false);
  });
});

describe('deleteProject', () => {
  test('removes the project row, and its credential entirely, from the store', () => {
    const id = repo.createProject(baseValues({ passwordAction: 'set', rawPassword: 'secret' }));

    const deleted = repo.deleteProject(id);
    assert.equal(deleted, true);

    assert.equal(repo.getProjectForEdit(id), null);
    assert.equal(repo.listProjects().length, 0);

    // Confirm at the raw DB layer, not just through the repository's own
    // read path, that no trace of the row (or its encrypted credential)
    // survives — not merely hidden from a "deleted" flag.
    const rawRow = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
    assert.equal(rawRow, undefined);
  });

  test('deleting an unknown id is a no-op, not a crash', () => {
    assert.equal(repo.deleteProject('does-not-exist'), false);
  });
});

describe('getDecryptedBasicAuthPassword — the outbound-only decrypt helper (requirement 3)', () => {
  test('decrypts the real stored value using the crypto module directly, proving the round trip end to end', () => {
    const id = repo.createProject(baseValues({ passwordAction: 'set', rawPassword: 'verify-me' }));

    const row = db.prepare('SELECT basic_auth_password_encrypted FROM projects WHERE id = ?').get(id);
    assert.equal(decrypt(row.basic_auth_password_encrypted, KEY), 'verify-me');
  });

  test('returns null for a project with no stored password', () => {
    const id = repo.createProject(baseValues({ passwordAction: 'none' }));
    assert.equal(repo.getDecryptedBasicAuthPassword(id), null);
  });
});

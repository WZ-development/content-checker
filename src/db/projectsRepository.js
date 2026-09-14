'use strict';

const crypto = require('node:crypto');

const { encrypt, decrypt } = require('../lib/crypto');

/**
 * Maps a raw DB row to the shape every route/template gets. Deliberately
 * excludes basic_auth_password_encrypted entirely — not just "don't
 * print it," the field never exists on this object, so there's nothing
 * for a template, a JSON response, or a log line to accidentally reach
 * for. Only a boolean survives: whether a password is currently stored.
 */
function rowToProject(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    liveUrl: row.live_url,
    stagingUrl: row.staging_url,
    basicAuthUsername: row.basic_auth_username || '',
    hasPassword: Boolean(row.basic_auth_password_encrypted),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Builds the projects repository bound to one open `db` handle and one
 * `encryptionKey`. This is the only module that reads or writes the
 * `basic_auth_password_encrypted` column — every other layer works
 * through the values this returns (rowToProject) or the single
 * getDecryptedBasicAuthPassword() escape hatch, so there is exactly one
 * place that ever needs to get the encryption right.
 */
function createProjectsRepository(db, encryptionKey) {
  // Every statement prepared once, here, rather than re-parsed on each
  // call — the same "one place, not N" shape as the rest of this module.
  const selectById = db.prepare('SELECT * FROM projects WHERE id = ?');
  const selectAllOrdered = db.prepare(
    'SELECT * FROM projects ORDER BY name COLLATE NOCASE ASC'
  );
  const selectEncryptedPasswordById = db.prepare(
    'SELECT basic_auth_password_encrypted FROM projects WHERE id = ?'
  );
  const insertProject = db.prepare(
    `INSERT INTO projects
      (id, name, live_url, staging_url, basic_auth_username, basic_auth_password_encrypted, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const updateProjectRow = db.prepare(
    `UPDATE projects
     SET name = ?, live_url = ?, staging_url = ?, basic_auth_username = ?,
         basic_auth_password_encrypted = ?, updated_at = ?
     WHERE id = ?`
  );
  const deleteProjectRow = db.prepare('DELETE FROM projects WHERE id = ?');

  /**
   * Resolves what the password column should become, given the
   * validated { passwordAction, rawPassword } from projectValidation.js:
   *   'set'   — encrypt the new password
   *   'clear' — remove it
   *   'keep'  — leave the existing encrypted value untouched (edit only)
   *   'none'  — no password given on create
   */
  function resolveEncryptedPassword(passwordAction, rawPassword, existingRow) {
    switch (passwordAction) {
      case 'set':
        return encrypt(rawPassword, encryptionKey);
      case 'clear':
        return null;
      case 'keep':
        return existingRow ? existingRow.basic_auth_password_encrypted : null;
      default:
        return null;
    }
  }

  function listProjects() {
    return selectAllOrdered.all().map(rowToProject);
  }

  function getProjectForEdit(id) {
    return rowToProject(selectById.get(id));
  }

  function createProject(values) {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const encryptedPassword = resolveEncryptedPassword(values.passwordAction, values.rawPassword, null);

    insertProject.run(
      id,
      values.name,
      values.liveUrl,
      values.stagingUrl,
      values.basicAuthUsername || null,
      encryptedPassword,
      now,
      now
    );

    return id;
  }

  function updateProject(id, values) {
    const existingRow = selectById.get(id);
    if (!existingRow) return false;

    const now = new Date().toISOString();
    const encryptedPassword = resolveEncryptedPassword(
      values.passwordAction,
      values.rawPassword,
      existingRow
    );

    const info = updateProjectRow.run(
      values.name,
      values.liveUrl,
      values.stagingUrl,
      values.basicAuthUsername || null,
      encryptedPassword,
      now,
      id
    );

    return info.changes > 0;
  }

  /** Deletes the row outright — no soft-delete, no tombstone, no trace. */
  function deleteProject(id) {
    return deleteProjectRow.run(id).changes > 0;
  }

  /**
   * The one decrypt path in this module. Returns plaintext for outbound
   * use (a future consumer making an authenticated HTTP request) — never
   * called from any Sprint 2 route or template.
   */
  function getDecryptedBasicAuthPassword(id) {
    const row = selectEncryptedPasswordById.get(id);
    if (!row || !row.basic_auth_password_encrypted) return null;
    return decrypt(row.basic_auth_password_encrypted, encryptionKey);
  }

  return {
    listProjects,
    getProjectForEdit,
    createProject,
    updateProject,
    deleteProject,
    getDecryptedBasicAuthPassword,
  };
}

module.exports = { createProjectsRepository };

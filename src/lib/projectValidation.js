'use strict';

const { normalizeAndValidateUrl } = require('./urlValidation');

/**
 * Validates and normalizes a project create/edit form submission.
 *
 * Returns { errors, values }. `errors` is a field-name -> message map,
 * empty when the submission is valid. `values` always carries back the
 * best-effort normalized/trimmed input (including on failure) so a
 * re-rendered form can show the user what they typed rather than
 * clearing the fields on a validation error.
 *
 * `values.passwordAction` is the tri-state result of requirement 5's
 * blank-field-keeps-existing rule:
 *   'set'   — a new password was submitted; store it (encrypted)
 *   'clear' — the "clear credentials" control was used; remove it
 *   'keep'  — edit only: password field was left blank; leave as-is
 *   'none'  — create only: no password given, nothing to store
 * The repository layer (projectsRepository.js) is what actually
 * interprets this against the existing stored value — this module only
 * classifies user intent from the raw submission.
 */
async function validateProjectInput(body, { isEdit }) {
  const errors = {};

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) {
    errors.name = 'Project name is required.';
  }

  const [liveUrlResult, stagingUrlResult] = await Promise.all([
    normalizeAndValidateUrl(body.liveUrl),
    normalizeAndValidateUrl(body.stagingUrl),
  ]);

  if (!liveUrlResult.valid) errors.liveUrl = liveUrlResult.error;
  if (!stagingUrlResult.valid) errors.stagingUrl = stagingUrlResult.error;

  const clearCredentials = body.clearCredentials === 'on';
  const rawPassword = typeof body.basicAuthPassword === 'string' ? body.basicAuthPassword : '';
  // "Clear credentials" removes the pair, not just the password — a lone
  // stored username with no password isn't a meaningful basic-auth
  // credential, so clearing takes the username with it too.
  const basicAuthUsername = clearCredentials
    ? ''
    : typeof body.basicAuthUsername === 'string'
      ? body.basicAuthUsername.trim()
      : '';

  let passwordAction;
  if (clearCredentials) {
    passwordAction = 'clear';
  } else if (rawPassword.length > 0) {
    passwordAction = 'set';
  } else {
    passwordAction = isEdit ? 'keep' : 'none';
  }

  return {
    errors,
    values: {
      name,
      // Fall back to the raw (trimmed only) input on validation failure
      // so the re-rendered form echoes what the user actually typed
      // rather than losing it.
      liveUrl: liveUrlResult.valid ? liveUrlResult.url : (body.liveUrl || '').trim(),
      stagingUrl: stagingUrlResult.valid ? stagingUrlResult.url : (body.stagingUrl || '').trim(),
      basicAuthUsername,
      passwordAction,
      rawPassword,
    },
  };
}

module.exports = { validateProjectInput };

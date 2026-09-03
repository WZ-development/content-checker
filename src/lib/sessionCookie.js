'use strict';

/**
 * Single source of truth for the session cookie's name. Both where the
 * cookie is set (src/app.js) and where it's cleared (src/routes/auth.js
 * logout) import this constant instead of each hardcoding their own
 * string — that duplication is exactly how the cookie name and the
 * clearCookie() call drifted apart before.
 */
const SESSION_COOKIE_NAME = 'content-checker.sid';

module.exports = { SESSION_COOKIE_NAME };

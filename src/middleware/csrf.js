'use strict';

const crypto = require('node:crypto');

/**
 * Ensures every authenticated session has a CSRF token and exposes it to
 * templates as `csrfToken`, so any form can embed it as a hidden field
 * without each route wiring this up itself. Mounted once, generically,
 * on the authenticated part of the router chain (see app.js) — the same
 * "shared, not re-derived per route" shape as noStore and the url()
 * helper, for the same reason: one place to get right instead of N.
 */
function attachCsrfToken(req, res, next) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  }
  res.locals.csrfToken = req.session.csrfToken;
  next();
}

/**
 * Rejects a state-changing request whose `_csrf` body field doesn't
 * match the session's token. Comparison is constant-time and length-
 * checked first — timingSafeEqual throws on a length mismatch rather
 * than returning false, so a naive call would itself be an oracle (and
 * a crash) for an attacker submitting a token of the wrong length.
 *
 * Renders a real error page on failure (never a bare JSON body) per
 * requirement 10 — the same lesson Sprint 1's rate-limit fix already
 * established: a rejected browser form submission should land a human
 * on a page with a way forward, not a dead end.
 */
function verifyCsrfToken(req, res, next) {
  const sessionToken = req.session && req.session.csrfToken;
  const submittedToken = typeof req.body?._csrf === 'string' ? req.body._csrf : '';

  const sessionBuf = Buffer.from(sessionToken || '', 'utf8');
  const submittedBuf = Buffer.from(submittedToken, 'utf8');

  const isValid =
    Boolean(sessionToken) &&
    sessionBuf.length === submittedBuf.length &&
    crypto.timingSafeEqual(sessionBuf, submittedBuf);

  if (!isValid) {
    res.status(403).render('error', {
      title: 'Request rejected',
      message:
        "This form's session token was missing or expired. Go back, reload the page, and try again.",
    });
    return;
  }

  next();
}

module.exports = { attachCsrfToken, verifyCsrfToken };

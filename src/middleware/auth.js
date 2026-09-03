'use strict';

/**
 * Builds middleware that requires an authenticated session, redirecting
 * to the login screen when one is absent. `urlHelper` is the app's
 * BASE_PATH-aware url() function, so the redirect target itself honours
 * BASE_PATH like every other internal link.
 */
function createRequireAuth(urlHelper) {
  return function requireAuth(req, res, next) {
    if (req.session && req.session.authenticated === true) {
      next();
      return;
    }
    res.redirect(302, urlHelper('/login'));
  };
}

module.exports = { createRequireAuth };

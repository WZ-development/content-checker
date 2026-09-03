'use strict';

const { normalizeBasePath } = require('../config');

/**
 * Builds a `url(path)` helper bound to a given base path. Every internal
 * link, form action, redirect target, and static asset reference in this
 * app must be produced by this helper — never a hardcoded absolute path —
 * so the whole app can be mounted under an arbitrary BASE_PATH (e.g. the
 * production `/content-check`) without any template or route knowing
 * about it directly.
 *
 * createUrlHelper('/content-check')('/login')  -> '/content-check/login'
 * createUrlHelper('')('/login')                -> '/login'
 * createUrlHelper('/content-check')('login')   -> '/content-check/login'
 * createUrlHelper('/content-check')('/')       -> '/content-check/'
 */
function createUrlHelper(basePath) {
  const base = normalizeBasePath(basePath);

  return function url(path = '/') {
    const suffix = String(path).startsWith('/') ? path : `/${path}`;
    return `${base}${suffix}`;
  };
}

module.exports = { createUrlHelper };

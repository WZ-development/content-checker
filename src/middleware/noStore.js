'use strict';

/**
 * Applied to every authenticated response. Without this, a browser's Back
 * button can re-render a protected page from its HTTP cache after logout
 * — harmless while that page is a placeholder, a real data leak once it
 * carries project data and staging credentials (Sprint 2 onward).
 */
function noStore(req, res, next) {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  next();
}

module.exports = { noStore };

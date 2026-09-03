'use strict';

const express = require('express');

/**
 * The protected landing page reached after login. This is a placeholder
 * for the app shell — Sprint 2 onward build the real project list here.
 * Its only job in this sprint is to exist, sit behind requireAuth, and
 * prove the BASE_PATH url() helper works on a real rendered page.
 */
function createLandingRouter({ urlHelper }) {
  const router = express.Router();

  router.get('/', (req, res) => {
    res.render('landing', { url: urlHelper });
  });

  return router;
}

module.exports = { createLandingRouter };

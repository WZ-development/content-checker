'use strict';

const express = require('express');

/**
 * Health check route. Deliberately mounted before the auth middleware so
 * it stays reachable without a session, for deployment health checks.
 */
function createHealthRouter() {
  const router = express.Router();

  router.get('/healthz', (req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  return router;
}

module.exports = { createHealthRouter };

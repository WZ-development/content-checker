'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');

const GENERIC_LOGIN_ERROR = 'Incorrect password. Please try again.';

/**
 * Builds the login/logout router. `urlHelper` is the app's BASE_PATH-aware
 * url() function; `teamPasswordHash` is the bcrypt hash the single shared
 * team password is checked against (never a plaintext comparison).
 */
function createAuthRouter({ urlHelper, teamPasswordHash }) {
  const router = express.Router();

  // 10 attempts per IP per 15 minutes — a sane ceiling for a single
  // shared-password gate sitting behind a public domain.
  const loginRateLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: GENERIC_LOGIN_ERROR },
  });

  router.get('/login', (req, res) => {
    if (req.session && req.session.authenticated === true) {
      res.redirect(302, urlHelper('/'));
      return;
    }
    res.render('login', { error: null, url: urlHelper });
  });

  router.post('/login', loginRateLimiter, async (req, res, next) => {
    try {
      const submittedPassword =
        typeof req.body?.password === 'string' ? req.body.password : '';

      // bcrypt.compare is constant-time relative to the hash and never
      // reveals anything about *why* a comparison failed — that's what
      // keeps the failure message generic downstream.
      const isMatch = await bcrypt.compare(submittedPassword, teamPasswordHash);

      if (!isMatch) {
        res.status(401).render('login', {
          error: GENERIC_LOGIN_ERROR,
          url: urlHelper,
        });
        return;
      }

      // Regenerate the session on privilege change to avoid session
      // fixation, then mark it authenticated.
      req.session.regenerate((regenerateErr) => {
        if (regenerateErr) {
          next(regenerateErr);
          return;
        }
        req.session.authenticated = true;
        res.redirect(302, urlHelper('/'));
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/logout', (req, res, next) => {
    if (!req.session) {
      res.redirect(302, urlHelper('/login'));
      return;
    }
    req.session.destroy((err) => {
      if (err) {
        next(err);
        return;
      }
      res.clearCookie('connect.sid');
      res.redirect(302, urlHelper('/login'));
    });
  });

  return router;
}

module.exports = { createAuthRouter, GENERIC_LOGIN_ERROR };

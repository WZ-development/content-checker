'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');

const { SESSION_COOKIE_NAME } = require('../lib/sessionCookie');

const GENERIC_LOGIN_ERROR = 'Incorrect password. Please try again.';

/**
 * Builds a human-readable rate-limit message from whatever Retry-After
 * (seconds) express-rate-limit has already set on the response — it sets
 * this header before invoking a custom `handler`, so it's always present
 * by the time this runs. Falls back to a generic wait if it's ever absent.
 */
function buildRateLimitedMessage(res) {
  const retryAfterSeconds = Number(res.getHeader('Retry-After'));
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
    const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
    return `Too many login attempts. Please wait about ${minutes} minute${minutes === 1 ? '' : 's'} and try again.`;
  }
  return 'Too many login attempts. Please wait a few minutes and try again.';
}

/**
 * Builds the login/logout router. `urlHelper` is the app's BASE_PATH-aware
 * url() function; `teamPasswordHash` is the bcrypt hash the single shared
 * team password is checked against (never a plaintext comparison);
 * `cookiePath` is the same BASE_PATH-scoped path the session cookie was
 * set with, required here too so logout's clearCookie() actually matches
 * and clears it rather than silently no-op'ing on a path mismatch.
 */
function createAuthRouter({ urlHelper, teamPasswordHash, cookiePath }) {
  const router = express.Router();

  // 10 attempts per IP per 15 minutes — a sane ceiling for a single
  // shared-password gate sitting behind a public domain. A custom
  // handler renders the real login page with a distinct, honest message
  // instead of express-rate-limit's default bare JSON body — a user who
  // gets rate-limited is still a person looking at a browser, not an API
  // client, and they must never be told a correct password was wrong.
  const loginRateLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
      res.status(429).render('login', {
        error: buildRateLimitedMessage(res),
        url: urlHelper,
      });
    },
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
      res.clearCookie(SESSION_COOKIE_NAME, { path: cookiePath });
      res.redirect(302, urlHelper('/login'));
    });
  });

  return router;
}

module.exports = { createAuthRouter, GENERIC_LOGIN_ERROR };

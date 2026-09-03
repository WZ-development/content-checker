'use strict';

const path = require('node:path');
const express = require('express');
const session = require('express-session');

const { createUrlHelper } = require('./lib/url');
const { createRequireAuth } = require('./middleware/auth');
const { createAuthRouter } = require('./routes/auth');
const { createHealthRouter } = require('./routes/health');
const { createLandingRouter } = require('./routes/landing');

/**
 * Builds a mountable Express application. Everything — routes, the
 * session cookie, static assets — lives under `config.basePath`, so the
 * same app runs unmodified at `/` in development and `/content-check` in
 * production.
 */
function createApp(config) {
  const app = express();
  const mountPath = config.basePath === '' ? '/' : config.basePath;
  const urlHelper = createUrlHelper(config.basePath);

  app.set('trust proxy', 1);
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  // Static assets and login pages render user-controlled-looking data
  // (the login error) but nothing here comes from untrusted input beyond
  // the fixed generic error string, so EJS's default HTML escaping is a
  // deliberate defense-in-depth choice, not a requirement of this sprint.

  const appRouter = express.Router();

  appRouter.use(express.urlencoded({ extended: false }));
  appRouter.use(
    session({
      name: 'content-checker.sid',
      secret: config.sessionSecret,
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: 'auto',
      },
    })
  );

  // Reachable without a session, in this order deliberately: health
  // check, static assets, then the login/logout routes.
  appRouter.use(createHealthRouter());
  appRouter.use(express.static(path.join(__dirname, '..', 'public')));
  appRouter.use(createAuthRouter({ urlHelper, teamPasswordHash: config.teamPasswordHash }));

  // Everything registered from here down requires an authenticated
  // session.
  appRouter.use(createRequireAuth(urlHelper));
  appRouter.use(createLandingRouter({ urlHelper }));

  appRouter.use((req, res) => {
    res.status(404).send('Not found');
  });

  // eslint-disable-next-line no-unused-vars
  appRouter.use((err, req, res, next) => {
    // Never swallow the error: log it server-side with full detail, but
    // never leak internals (stack trace, error message) to the client.
    console.error('[content-checker] unhandled error:', err);
    res.status(500).send('Something went wrong. Please try again.');
  });

  app.use(mountPath, appRouter);

  return app;
}

module.exports = { createApp };

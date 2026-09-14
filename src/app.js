'use strict';

const path = require('node:path');
const express = require('express');
const session = require('express-session');

const { createUrlHelper } = require('./lib/url');
const { SESSION_COOKIE_NAME } = require('./lib/sessionCookie');
const { createRequireAuth } = require('./middleware/auth');
const { noStore } = require('./middleware/noStore');
const { attachCsrfToken } = require('./middleware/csrf');
const { createAuthRouter } = require('./routes/auth');
const { createHealthRouter } = require('./routes/health');
const { createLandingRouter } = require('./routes/landing');
const { createProjectsRouter } = require('./routes/projects');
const { openDatabase } = require('./db/database');
const { createProjectsRepository } = require('./db/projectsRepository');

const DEFAULT_DB_PATH = path.join(__dirname, '..', 'data', 'content-checker.db');

/**
 * Builds a mountable Express application. Everything — routes, the
 * session cookie, static assets — lives under `config.basePath`, so the
 * same app runs unmodified at `/` in development and `/content-check` in
 * production.
 *
 * `repository` is injectable so tests can pass one backed by an
 * in-memory database instead of touching disk; server.js's real startup
 * path leaves it unset and gets the real file-backed store.
 */
function createApp(config, { repository } = {}) {
  const app = express();
  const mountPath = config.basePath === '' ? '/' : config.basePath;
  const urlHelper = createUrlHelper(config.basePath);
  const projectsRepository =
    repository || createProjectsRepository(openDatabase(DEFAULT_DB_PATH), config.encryptionKey);

  app.set('trust proxy', 1);
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  // Every template render gets url() for free via app.locals — routes
  // may still pass their own `url` explicitly (Sprint 1's routes do),
  // which simply overrides this with the identical function; new routes
  // don't have to.
  app.locals.url = urlHelper;
  // Static assets and login pages render user-controlled-looking data
  // (the login error) but nothing here comes from untrusted input beyond
  // the fixed generic error string, so EJS's default HTML escaping is a
  // deliberate defense-in-depth choice, not a requirement of this sprint.

  const appRouter = express.Router();

  // Scoping the cookie to BASE_PATH (rather than the express-session
  // default of "/") matters on a shared host: production mounts this app
  // at /content-check alongside sibling tools on the same domain, and an
  // unscoped cookie would be sent to every one of them.
  const cookiePath = config.basePath || '/';

  appRouter.use(express.urlencoded({ extended: false }));
  appRouter.use(
    session({
      name: SESSION_COOKIE_NAME,
      secret: config.sessionSecret,
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: 'auto',
        path: cookiePath,
      },
    })
  );

  // Reachable without a session, in this order deliberately: health
  // check, static assets, then the login/logout routes.
  appRouter.use(createHealthRouter());
  appRouter.use(express.static(path.join(__dirname, '..', 'public')));
  appRouter.use(
    createAuthRouter({ urlHelper, teamPasswordHash: config.teamPasswordHash, cookiePath })
  );

  // Everything registered from here down requires an authenticated
  // session. noStore is deliberately scoped to only this part of the
  // chain — protected content must never be cacheable, so a browser's
  // Back button can't resurrect it after logout. attachCsrfToken is
  // scoped here too, for the same "generic once, not per-route" reason:
  // every authenticated GET that renders a form gets a token without
  // its route needing to know CSRF exists.
  appRouter.use(createRequireAuth(urlHelper));
  appRouter.use(noStore);
  appRouter.use(attachCsrfToken);
  appRouter.use(createLandingRouter({ urlHelper }));
  appRouter.use(createProjectsRouter({ urlHelper, repository: projectsRepository }));

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

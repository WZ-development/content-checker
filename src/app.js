'use strict';

const path = require('node:path');
const dns = require('node:dns');
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
const { createScanRouter } = require('./routes/scan');
const { openDatabase } = require('./db/database');
const { createProjectsRepository } = require('./db/projectsRepository');
const { createPinnedFetch } = require('../lib/net/pinnedFetch');

const DEFAULT_DB_PATH = path.join(__dirname, '..', 'data', 'content-checker.db');

/**
 * Builds a mountable Express application. Everything — routes, the
 * session cookie, static assets — lives under `config.basePath`, so the
 * same app runs unmodified at `/` in development and `/content-checker` in
 * production.
 *
 * `repository` is injectable so tests can pass one backed by an
 * in-memory database instead of touching disk; server.js's real startup
 * path leaves it unset and gets the real file-backed store.
 *
 * `fetchImpl`/`dnsLookup` are injectable the same way, for the same
 * reason: tests get a fixture-driven fake (see test/sitemap/testHarness
 * .js) instead of the real network. Left unset, createPinnedFetch()
 * builds the real connection-pinned pair — sprint 5, requirement 14 —
 * exactly ONCE per app instance, right here, and the identical pair is
 * handed to the scan router, which forwards it (further wrapped
 * per-request with the outbound token — see below) into both
 * lib/sitemap's crawler and lib/compare's title fetcher. No other
 * module ever constructs its own fetch implementation.
 *
 * Sprint 7, requirement 1, THEN its fix-loop (QA1 round 1 finding A): the
 * outbound token used to be wrapped exactly once, right here, around
 * whichever fetchImpl this app instance ends up using — but that wrapping
 * has no way to know which origins are safe to send the token to, because
 * this function runs once per APP INSTANCE, before any particular project
 * (and therefore its live/staging origins) is even known. Scoping the
 * token to a project's own origins therefore has to happen per SCAN
 * REQUEST, not per app instance — see src/routes/scan.js, which now does
 * the actual wrapFetchWithOutboundToken call. This function still builds
 * the connection-pinned pair exactly ONCE per app instance (sprint 5,
 * requirement 14) and hands the UNWRAPPED fetchImpl/dnsLookup, plus the
 * raw `config.outboundToken`, to the scan router — scan.js is the only
 * other place that ever sees the real token value.
 */
function createApp(config, { repository, fetchImpl, dnsLookup } = {}) {
  const app = express();
  const mountPath = config.basePath === '' ? '/' : config.basePath;
  const urlHelper = createUrlHelper(config.basePath);
  const projectsRepository =
    repository || createProjectsRepository(openDatabase(DEFAULT_DB_PATH), config.encryptionKey);
  // fetchImpl presence alone selects test-injection mode — a caller
  // supplying a fake fetch almost always wants its own dnsLookup too
  // (see test/sitemap/testHarness.js), but falls back to the real
  // resolver if it didn't provide one, rather than silently pinning.
  const pinnedFetch = fetchImpl
    ? { fetchImpl, dnsLookup: dnsLookup || dns.promises.lookup }
    : createPinnedFetch({ dnsLookup });

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
  // at /content-checker alongside sibling tools on the same domain, and an
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
  appRouter.use(
    createScanRouter({
      urlHelper,
      repository: projectsRepository,
      fetchImpl: pinnedFetch.fetchImpl,
      dnsLookup: pinnedFetch.dnsLookup,
      outboundToken: config.outboundToken,
    })
  );

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

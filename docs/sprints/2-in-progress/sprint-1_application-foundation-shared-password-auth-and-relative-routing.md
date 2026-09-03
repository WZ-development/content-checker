# Master Controller Sprint Definition — Sprint 1

**Epic:** Foundation & Access — the running Express app, its config surface, and the shared-password gate that every other screen sits behind.
**Sprint Objective:** Stand up a mountable Express application with shared-password authentication, environment-driven config, and a test/lint/build toolchain the remaining four sprints can build on.

### Context
There is no application code in this repository yet — only the sprint framework. Every other sprint in this epic assumes a running Express app with a session, a protected route group, and a config module. Building those four things once, deliberately, is cheaper than having each later sprint invent its own half of them.

The production target is `tools.wordzite.com/content-check` — a subpath, not a domain root. Subpath mounting is the kind of constraint that is nearly free to honour on day one and expensive to retrofit once a dozen templates have hardcoded `/login` and `/projects`. This sprint pays that cost up front even though V1 runs on localhost.

### Requirements
1. Express application, Node 24, served by a single entry point. Server-rendered templates and vanilla JS only — no React, no bundler, no frontend build step.
2. All configuration read from environment variables via a `.env` file: at minimum `PORT`, `SESSION_SECRET`, `TEAM_PASSWORD_HASH`, `BASE_PATH`. A committed `.env.example` documents every variable. `.env` itself is gitignored.
3. Every application route mounts under `BASE_PATH` (default `/`, production `/content-check`). No route path, form action, redirect, or asset reference may be an absolute path that ignores `BASE_PATH`. Provide a single helper (e.g. `url('/projects')`) that templates use to build every internal link.
4. A login screen accepting a single shared team password. The password is verified against a bcrypt (or argon2) hash held in `TEAM_PASSWORD_HASH`. The plaintext password is never stored, logged, or committed.
5. Successful login establishes an HTTP-only, `SameSite=Lax` session cookie. Session secret comes from `SESSION_SECRET`; the app refuses to start with a clear error if that variable is missing or empty rather than falling back to a default secret.
6. All routes except the login screen, the login POST handler, and static assets require an authenticated session. An unauthenticated request to a protected route redirects to login, not a 500 or a blank page.
7. Failed login returns a generic failure message and does not reveal whether the password was close, long, or malformed. Rate-limit login attempts to a sane ceiling (e.g. 10 per IP per 15 minutes).
8. A logout route that destroys the session and redirects to login.
9. `npm test`, `npm run lint`, and `npm start` all exist and exit clean. Unit tests cover the auth middleware and the `BASE_PATH` URL helper.
10. A `GET /healthz` route (also under `BASE_PATH`) returning 200 and a JSON body, reachable **without** authentication, for deployment health checks.

### Acceptance Criteria
- QA1 confirms `.env.example` exists, lists all four variables, and that `.gitignore` excludes `.env`. QA1 greps the diff for hardcoded secrets and finds none.
- QA1 confirms `TEAM_PASSWORD_HASH` is compared using a real password-hashing verify call, not string equality against a plaintext value, and that no plaintext password appears anywhere in the repo.
- QA1 starts the app with `SESSION_SECRET` unset and confirms it exits with an explicit error message naming the missing variable — asserting on the printed error text itself, not merely that the process failed.
- QA1 confirms every internal link in every template routes through the `BASE_PATH` helper. Setting `BASE_PATH=/content-check` and reading the rendered HTML shows every href, form action, and asset src prefixed with `/content-check`. A grep for absolute internal paths (`href="/`, `action="/`) outside the helper returns nothing.
- QA1 confirms the session cookie is set `httpOnly` and `sameSite`, by asserting on the actual `Set-Cookie` header.
- QA1 requests a protected route with no session and confirms a redirect to the login screen (assert the 302 and its `Location`), not a 500.
- QA1 confirms failed login output is generic, by asserting on the rendered message text.
- QA1 runs `npm test` and `npm run lint` and confirms both pass with the auth-middleware and URL-helper tests present and meaningful.
- LiveQA loads the app on localhost, is redirected to login, submits a wrong password and sees a generic failure, submits the correct password and reaches an authenticated landing page, then logs out and confirms the protected route is inaccessible again.

### Out of Scope
- Project CRUD and credential storage — Sprint 2.
- Any sitemap fetching or parsing — Sprint 3.
- Deploying to `tools.wordzite.com` — a later sprint, once the host exists. This sprint only makes that deploy *possible* by honouring `BASE_PATH`.
- Individual user accounts, roles, or registration — explicitly deferred by PRD §4.1.
- Visual design polish. A clean, legible default is enough; the results UI in Sprint 5 sets the visual direction.

### Dependencies
- Blocks: Sprints 2, 3, 4, 5. Nothing else can start until the app and its auth gate exist.
- Blocked by: Nothing.
- External: None. Node 24 confirmed present on the build machine.

### Risks & Mitigations
- **`BASE_PATH` honoured in routing but not in templates**, the classic half-done subpath mount — the app works on localhost and breaks the day it deploys. Mitigated by making it an explicit acceptance criterion tested at `BASE_PATH=/content-check`, not just at the default.
- **A default `SESSION_SECRET` sneaks in for developer convenience**, turning session forgery into a non-event for anyone who reads the repo. Mitigated by requiring hard startup failure, verified by asserting on the error text.
- **Rate limiting deferred as "polish"** on a tool that will sit at a public domain behind one shared password. It is a numbered requirement here, not a nice-to-have.
- **Frontend framework creep** — an engineer reaches for React because six screens "might grow." Mitigated by requirement 1 stating no bundler as a hard constraint. If that constraint is wrong, flag it before building, do not discover it mid-sprint.

# Content Checker

Shared-password-gated Express app. Server-rendered templates, no frontend
build step. Production target: `tools.wordzite.com/content-check`.

## Setup

```bash
npm install
cp .env.example .env
```

Generate a session secret, a password hash, and an encryption key, then
fill them into `.env`:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
npm run hash-password -- 'your-team-password'
npm run generate-encryption-key
```

`.env` at minimum needs `SESSION_SECRET`, `TEAM_PASSWORD_HASH`, and
`ENCRYPTION_KEY` — the app refuses to start without any of them. `PORT`
defaults to `3000`, `BASE_PATH` defaults to `/`.

Note: both `hash-password` and `generate-encryption-key` take/print
secrets through argv/stdout, which land in shell history and scrollback —
fine for local dev, but clear your history or use a leading space (most
shells skip history for a command starting with one) if that matters on
a shared machine.

Projects (name, live/staging URLs, optional HTTP Basic Auth credentials)
are stored in a local SQLite file at `data/content-checker.db`, created
automatically on first run. Basic-auth passwords are encrypted at rest
with `ENCRYPTION_KEY` (AES-256-GCM) — the file itself is gitignored.

Scanning a project (`/projects/:id/scan`) discovers each side's sitemap,
compares the two URL sets, and resolves a title for every differing
page — on demand, nothing is stored. All outbound requests (sitemap
fetches and title fetches alike) go through one connection-pinned fetch
implementation built once per app instance (`lib/net/pinnedFetch.js`):
the DNS lookup used to approve an address is the exact same lookup used
to open the connection, so there's no window between "checked safe" and
"connected to" for an address to change in.

## Run

```bash
npm start        # start the app
npm test         # run the test suite (node's built-in test runner)
npm run lint     # eslint
```

To run mounted under a subpath, the way it's deployed in production:

```bash
BASE_PATH=/content-check npm start
```

Every internal link, form action, redirect, and static asset reference
goes through the `url()` helper (`src/lib/url.js`) so this works
identically at any `BASE_PATH`.

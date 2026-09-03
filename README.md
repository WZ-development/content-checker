# Content Checker

Shared-password-gated Express app. Server-rendered templates, no frontend
build step. Production target: `tools.wordzite.com/content-check`.

## Setup

```bash
npm install
cp .env.example .env
```

Generate a session secret and a password hash, then fill them into `.env`:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
npm run hash-password -- 'your-team-password'
```

`.env` at minimum needs `SESSION_SECRET` and `TEAM_PASSWORD_HASH` — the app
refuses to start without either. `PORT` defaults to `3000`, `BASE_PATH`
defaults to `/`.

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

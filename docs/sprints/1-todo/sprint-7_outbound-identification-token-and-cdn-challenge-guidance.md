# Master Controller Sprint Definition — Sprint 7

**Epic:** Deployment — moving the tool from a developer's localhost to real client sites and the shared internal host where the team actually uses it.
**Sprint Objective:** Make the tool identify itself to client CDNs with a non-spoofable secret header, and turn a CDN bot-challenge into an actionable message containing the exact allow rule to add.

### Context
The first real site this tool ever met — `www.wordzite.com`, during Sprint 5's live test — returned a Cloudflare Managed Challenge on every request, including `robots.txt` and the sitemaps. A server-side crawler cannot pass a JavaScript challenge, and the tool presented the 403 as an authentication error with no next step. LiveQA's suggested fix was a per-zone allow rule matching the `User-Agent`, which the user correctly rejected: a UA match is trivially spoofable, so it would punch a hole in every client's bot protection for anyone who types the same string.

The agreed design has three layers, and this sprint builds the first. **This sprint:** a secret token header sent on every outbound request, and a challenge message that tells the developer exactly which rule to paste. **Sprint 6:** once the tool has a fixed egress IP, the rule tightens to `header AND ip.src`. **Later, optional:** connect-to-origin per project for sites the agency hosts, bypassing the CDN entirely. The per-zone step itself is unavoidable — a WAF has to be told about any client it should not challenge — so the goal here is to make that step non-spoofable and a copy-paste, not to eliminate it. The user's existing Cloudflare API tooling will push the rule across managed accounts; this repo documents the rule spec, it does not automate it.

### Requirements
1. **An outbound identification header on every request the tool makes** — robots.txt, sitemap index, every child sitemap, every title fetch, and every redirect hop the tool follows. Header name `X-ContentCheck-Token`; value from a `CONTENTCHECK_OUTBOUND_TOKEN` environment variable. Sent via the single injected fetch implementation Sprint 5 built, so there is exactly one place it is added.
2. The variable is **optional**: when unset or empty, the header is omitted and the app starts normally, logging a one-line startup notice that outbound identification is not configured. Not every site has a CDN challenge, and local development against unprotected sites must keep working. When set, it must be at least 32 characters, or the app refuses to start naming the variable — the same pattern as `ENCRYPTION_KEY`.
3. **The token is a secret.** Never logged, never rendered into any template, never included in any error message or the attempts log, never in a JSON response. Same handling standard as the encryption key and the session secret.
4. `bin/generate-outbound-token.js` prints a suitable random value, mirroring the existing key generator, and `.env.example` documents the variable, its purpose, and the generator command.
5. The `User-Agent` stays as it is — `ContentCheckerBot/1.0 (+https://tools.wordzite.com/content-check)` — for identification in client logs. It grants nothing and the documentation must say so explicitly.
6. **CDN challenge detection.** A response carrying the header `cf-mitigated: challenge` is classified as a distinct failure type — *CDN challenge* — separate from a 401/403 authentication failure. Verified by hand on 2026-09-16 against `www.wordzite.com`: the challenge response is `HTTP 403`, `server: cloudflare`, `cf-mitigated: challenge`, with a "Just a moment…" HTML body. Match on the header, not the body text. A plain 403 without that header stays classified as it is today.
7. **The challenge message is actionable.** When a scan hits a CDN challenge on either side, the results screen states plainly that the site's CDN or firewall is challenging automated access — not that credentials are wrong — and shows the exact allow rule to add: the header name, a Cloudflare WAF custom-rule expression of the form `(http.request.headers["x-contentcheck-token"][0] eq "<your token>")`, and the action (Skip). It shows the header *name* and a placeholder; it never shows the token value (requirement 3). It links to the documentation in requirement 8. If the token is not configured (requirement 2), the message says so first, because no rule can help until it is.
8. **`docs/cdn-allow-rule.md`** — the rule spec, written so the user's existing Cloudflare API tooling can be pointed at it: the expression, the Skip action and which protection components to skip, the post-deploy tightening (`and ip.src eq <egress IP>`, filled in by Sprint 6), and three caveats verified or reported during Sprint 5: Free-plan Bot Fight Mode cannot be skipped by a custom rule, only disabled — verify on the zone's plan before relying on the rule; the rule must cover the whole host, not just sitemap paths, or title fetches silently fall back to slugs; and WordPress security plugins (Wordfence and similar) have their own bot blocking that needs the same allowance. It states that `User-Agent` must not be used as the match condition, and why.
9. Tests: the header is present on every outbound request type (initial, child sitemap, title fetch, redirect hop) asserting on captured headers; absent when the variable is unset; the too-short value refuses startup with a message naming the variable; the token value appears in no log line, error text, or rendered output on a fixture that triggers every error path; a `cf-mitigated: challenge` fixture yields the CDN-challenge type and message; a plain 403 fixture and a 401 fixture still yield their existing types and messages — no regression on Sprint 5's credentials message.

### Acceptance Criteria
- QA1 confirms the header is added in exactly one place — the injected fetch — and that neither the crawler nor the title fetcher sets it independently.
- QA1 confirms the header is present on every request type in requirement 1, asserting on captured outbound headers for each, including a redirect hop.
- QA1 confirms the optional/unset behaviour and the too-short refusal, asserting on the printed startup notice and the printed refusal text respectively.
- QA1 greps templates, log statements, error constructors, the attempts log, and JSON paths for the token variable and finds it rendered nowhere; and confirms the test in requirement 9 that exercises every error path with a known token value and asserts its absence.
- QA1 confirms the generator prints only the token and takes no secret as input.
- QA1 confirms challenge classification keys on the `cf-mitigated` header, not body text, and that a plain 403 is unchanged.
- QA1 confirms the challenge message names the header, shows the expression with a placeholder rather than the real token, shows the Skip action, links to the doc, and asserts on the message text itself.
- QA1 confirms the not-configured variant of the message renders when the token is unset.
- QA1 reads `docs/cdn-allow-rule.md` and confirms it contains the expression, the action, the post-deploy IP tightening, the three caveats, and the explicit prohibition on UA matching.
- QA1 runs `npm test` and `npm run lint`; both pass.
- **LiveQA**, against `www.wordzite.com` with the temporary UA rule **replaced** by the header rule from the doc: run a scan with the token configured and confirm it completes with real results. Remove the rule (or run with the token unset) and confirm the challenge message appears with the rule text and the doc link, and that it does not read as a credentials error. Then confirm a genuine Basic-Auth 401 on the staging side still produces Sprint 5's credentials message — the two failure types must be visibly distinct on screen.

### Out of Scope
- **Automating the Cloudflare rule push.** The user's existing API tooling does that; this sprint delivers the spec it consumes. A `bin/` script would duplicate tooling that already exists.
- **IP-pinned rule tightening.** Needs the deployed egress IP, which does not exist until Sprint 6. The doc leaves a clearly marked placeholder.
- **Connect-to-origin per project (CDN bypass).** The elegant answer for agency-hosted sites, deliberately deferred until the per-site rule has been used on a few real clients and it is clear whether origins accept direct connections on the agency's hosting. Backlog, not a sprint yet.
- **Detecting non-Cloudflare challenges** (Akamai, Sucuri, AWS WAF). Cloudflare is the one observed; others get the existing generic 403 handling until one is actually seen.
- Any change to the scan UI beyond the challenge message and its not-configured variant.

### Dependencies
- Blocks: Sprint 6 — by sequencing decision, not by code. The deployed build should already send the header so the rule rollout across managed Cloudflare accounts happens once, against the final header, rather than being redone after deploy.
- Blocked by: Sprint 5 complete. This sprint modifies the single fetch implementation Sprint 5 builds and the error presentation Sprint 5 defines.
- External: `www.wordzite.com` with a Cloudflare custom rule the user can add and remove by hand for LiveQA. The user has chosen manual, temporary Cloudflare changes during local testing; the API rollout comes after Sprint 6.

### Team Assignments
- **Dev Team 1, alone, on `main`.** Sequential after Sprint 5 closes.

### Risks & Mitigations
- **The header gets added in the crawler and copied into the title fetcher**, so a later change to one leaves the other unidentified and half the scan gets challenged. Mitigated by requirement 1's single-place rule and a QA1 criterion that checks it.
- **The token leaks through an error message** — the most likely leak path, since the challenge message is *about* the token. Requirement 7 shows a placeholder only; requirement 9 exercises every error path with a known token and asserts its absence.
- **Challenge detection by body text** ("Just a moment…"), which breaks the day Cloudflare changes its copy. Requirement 6 keys on the header, verified by hand.
- **The temporary UA rule on `www.wordzite.com` outlives its purpose.** LiveQA's criterion requires it to be *replaced* by the header rule, not supplemented, so the sprint cannot pass with the spoofable rule still in place.
- **Free-plan Bot Fight Mode makes the rule moot on some zones.** Documented as a caveat with a verify-first instruction; not something this tool can fix.

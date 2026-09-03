# Master Controller Sprint Definition — Sprint 6

**Epic:** Deployment — moving the tool from a developer's localhost to the shared internal host where the team actually uses it.

> ## ⛔ DO NOT RUN `/sprint-start 6` YET
> This sprint is **blocked on a host that does not exist**. It is written now, ahead of time, only to
> capture deferred findings from Sprints 1–5 that both gates warned would otherwise be forgotten.
> It becomes startable when `tools.wordzite.com/content-check` can receive a deploy, and not before.
> See Dependencies.

**Sprint Objective:** Deploy the application to `tools.wordzite.com/content-check` and verify, against the real host, every assumption that localhost testing could not exercise.

### Context
Every sprint before this one was tested on a locally-run instance, which was the right call — waiting on a host would have blocked all V1 development. But it leaves a specific, known gap, and LiveQA said so plainly in Sprint 1's verdict: *"this verdict covers a locally-run instance of the shipped commit, NOT a real deployment. It is not evidence that the app works behind a reverse proxy at a subpath on the real host."*

This sprint exists to close that gap, and to collect the deferred items both gates flagged as "must land before the real deploy." Those findings are recorded below while their reasoning is still fresh, because an item deferred to an undefined future sprint is an item that gets lost. That is the entire reason this file was written early.

### Requirements
1. The application is deployed to `tools.wordzite.com/content-check` with `BASE_PATH=/content-check`, running behind the host's real reverse proxy.
2. Production configuration is supplied by environment, never committed: `SESSION_SECRET`, `TEAM_PASSWORD_HASH`, `ENCRYPTION_KEY`, `BASE_PATH`, `PORT`. Document how each is set on the host.
3. **Verify the `trust proxy` setting against the real proxy topology.** QA1 flagged in Sprint 1 (its issue 4) that `trust proxy, 1` is correct behind exactly one reverse proxy and wrong if the app is ever exposed directly, and demonstrated that a forged `X-Forwarded-For` earns a fresh rate-limit bucket. Confirm the real hop count matches the setting and document the coupling in the README.
4. **Verify the session cookie is scoped to `BASE_PATH`, not `/`, on the live host.** Fixed during Sprint 1's fix loop; this is where it actually matters — `tools.wordzite.com` is a shared domain, and a `Path=/` cookie is sent to every sibling tool on it.
5. **Replace the in-memory session and rate-limit stores** if the deploy is multi-instance or the process restarts routinely. QA1 accepted them as adequate for a single-instance V1 and explicitly noted they need a real store before any multi-instance deploy. If the deploy is single-instance, record that decision rather than silently keeping them.
6. HTTPS enforced; the session cookie is issued `Secure` in production.
7. A documented deploy and rollback procedure, short enough that someone other than its author can follow it.
8. `/content-check/healthz` reachable unauthenticated on the live host for monitoring.
9. **README note on `bin/hash-password.js`:** QA1 observed the password is passed as an argv and lands in the operator's shell history. Document clearing it or using a leading space.

### Acceptance Criteria
- QA1 confirms no secret is committed, and that every variable in requirement 2 is sourced from the host environment.
- QA1 confirms the `trust proxy` value matches the documented real hop count, and that the README states the coupling.
- QA1 confirms the session store choice is deliberate and recorded — either replaced, or single-instance justified in writing.
- **LiveQA tests against the real deployed URL, which is the entire point of this sprint**, and everything below must be exercised at `https://tools.wordzite.com/content-check`, not on localhost:
  - Full login → authenticated → logout flow, and the post-logout Back-button check (Sprint 1's issue 1) on the live host.
  - `Set-Cookie` carries `Path=/content-check`, `HttpOnly`, `SameSite=Lax`, and `Secure` — asserted on the actual header from the live response.
  - Every internal link, form action, and asset resolves correctly behind the real proxy. Stylesheets actually load; no `//` double-slash; no protocol-relative URLs.
  - A full end-to-end scan against a real WordPress site, run through the deployed instance rather than locally, confirming outbound fetches and Basic Auth work from the host's network.
  - `/content-check/healthz` returns 200 unauthenticated.
  - Rate limiting behaves correctly through the proxy — that a single real client is limited, and that the limit is not trivially reset by a forged header.

### Out of Scope
- Any V2 feature (automated transfer, body-text diffing, global elements) — PRD §6.
- CI/CD automation. A documented manual deploy is sufficient for an internal tool; automate it only if deploy frequency justifies it.
- Monitoring, alerting, or log aggregation beyond the healthz endpoint.
- Multi-user accounts — still one shared password per PRD §4.1.

### Dependencies
- Blocks: nothing. This is the last V1 sprint.
- Blocked by: **Sprints 1–5 all complete, AND a provisioned host.** The host is the hard blocker and it is external — do not start this sprint on the assumption it will be ready.
- External: `tools.wordzite.com` provisioned with Node 24, a reverse proxy configured to forward `/content-check`, TLS, and a way to set environment variables. Confirm the real proxy hop count before requirement 3 can be satisfied.

### Risks & Mitigations
- **Subpath mounting works on localhost and breaks behind the real proxy** — the single most likely failure here, because a real proxy may strip or rewrite the path prefix in ways a local run never exercises. Mitigated by Sprint 1's `BASE_PATH` discipline, but it is genuinely unverified until this sprint. Budget for a fix loop.
- **The deferred Sprint 1 items get lost** — the reason this file was written early rather than at deploy time. Requirements 3, 4, 5, and 9 each trace to a specific gate finding with its reasoning attached.
- **Localhost-passing behaviour is assumed to carry over.** LiveQA explicitly refused to make that claim. Every criterion above is re-tested live, not inherited.
- **A shared host means a shared blast radius.** The cookie-scoping and proxy items are not pedantry; they are the difference between this tool being isolated and it leaking session state to every sibling tool on the domain.

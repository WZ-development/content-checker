# Master Controller Sprint Definition — Sprint 2

**Epic:** Foundation & Access — the running Express app, its config surface, and the shared-password gate that every other screen sits behind.
**Sprint Objective:** Let developers create, edit, and delete client projects holding a live URL, a staging URL, and optional HTTP Basic Auth credentials that are encrypted at rest.

### Context
PRD §4.2 requires credentials saved per project and, specifically, *easily* updated — staging sites get destroyed and rebuilt with new logins constantly, and a tool that makes re-entering credentials painful will be abandoned for a manual diff. The edit path is therefore a first-class requirement here, not an afterthought to the create path.

These are real client staging credentials on a box that will eventually answer at a public domain. Plaintext at rest is not acceptable: encrypted with a key from the environment means a leaked database file alone does not hand over client infrastructure. This sprint is deliberately scoped to storage and CRUD only — it stores the URLs and credentials, and does not fetch anything with them.

### Requirements
1. A persistent store for projects (SQLite or an equivalent single-file store). Schema: id, project name, live URL, staging URL, optional basic-auth username, optional encrypted basic-auth password, created/updated timestamps.
2. Basic-auth passwords are encrypted at rest using authenticated symmetric encryption (AES-256-GCM or equivalent), with the key derived from an `ENCRYPTION_KEY` environment variable. The app refuses to start with an explicit error if `ENCRYPTION_KEY` is missing, empty, or the wrong length.
3. A decrypt helper returns the plaintext password for outbound use only. Encrypted values are never rendered into a template, never logged, and never included in any JSON response.
4. Full CRUD: list projects, create a project, edit a project, delete a project (with a confirmation step). All screens sit behind Sprint 1's auth gate and use Sprint 1's `BASE_PATH` URL helper.
5. The edit form pre-fills project name and both URLs. The basic-auth password field renders **empty** with a clear indication of whether a password is currently stored. Submitting the form with that field left blank keeps the existing password; entering a value replaces it; an explicit "clear credentials" control removes it.
6. URL validation on save: live and staging URLs must be absolute `http`/`https` URLs. Reject anything else with a field-level error message. Normalize on save by trimming whitespace and stripping any trailing slash from the origin.
7. Reject URLs that resolve to loopback, link-local, or private address ranges (`127.0.0.0/8`, `::1`, `10/8`, `172.16/12`, `192.168/16`, `169.254/16`) at save time, with a clear field-level error. This tool makes server-side requests to user-supplied URLs; that is an SSRF surface and this is its first line of defence.
8. Deleting a project removes its stored credentials from the store entirely, not just its row's visibility.
9. Unit tests cover: encrypt/decrypt round-trip, the blank-field-keeps-existing-password rule, URL validation accept/reject cases, and the private-range rejection.
10. **CSRF protection on every state-changing route** (create, edit, delete). Raised by QA1 during Sprint 1's audit and deliberately deferred to here: Sprint 1's two forms were adequately covered by `SameSite=Lax`, but this sprint introduces authenticated routes that mutate stored client credentials, which is where a token starts earning its cost. Reject a POST with a missing or invalid token, and render a usable error rather than a raw JSON body.
11. **Every authenticated response that can carry project data or credentials must send `Cache-Control: no-store`** (plus `no-cache, must-revalidate`). Sprint 1's fix loop establishes this for authenticated responses generally; this sprint must confirm it holds for the screens it adds. LiveQA demonstrated on Sprint 1 that without it, the browser Back button re-renders an authenticated page after logout from cache — on these screens that is a client-credential leak on any shared machine.

### Acceptance Criteria
- QA1 confirms the encryption is authenticated (GCM or equivalent), that a unique IV/nonce is generated per encryption rather than reused or hardcoded, and that `ENCRYPTION_KEY` is read from the environment and never has a default fallback.
- QA1 starts the app with `ENCRYPTION_KEY` unset and confirms an explicit startup error naming the variable, asserting on the printed message itself.
- QA1 inspects the store file after saving a project with credentials and confirms the password is not readable as plaintext anywhere in it.
- QA1 greps templates, log statements, and any JSON response path for the decrypted password value and finds it rendered nowhere.
- QA1 verifies the edit-form password rule by test: save a project with a password, edit and save with the password field blank, confirm the original password still decrypts correctly; then edit with a new value and confirm it replaces the old one; then use the clear control and confirm it is gone.
- QA1 confirms URL validation rejects `ftp://`, a bare `clientdomain.com` with no scheme, an empty string, and `http://192.168.1.10/` — asserting on the field-level error message shown in each case, not only that the save failed.
- QA1 confirms deleting a project leaves no trace of its credential row in the store.
- QA1 confirms every state-changing route rejects a POST with a missing or invalid CSRF token, asserting on the rejection response, and that a valid token succeeds.
- QA1 confirms the project list and project edit responses carry `Cache-Control: no-store`, asserting on the actual response header.
- QA1 runs `npm test` and `npm run lint`; both pass, with the four required test areas present.
- **LiveQA repeats Sprint 1's Back-button check on these screens specifically**: log in, open the project list with a saved project, log out, press Back, and confirm the credential-bearing page does not re-render from cache.
- LiveQA creates a project with credentials, edits it leaving the password blank and confirms the "password stored" indicator still shows, edits it with a new password, clears the credentials, and deletes the project — confirming each screen renders correctly and the confirmation step on delete actually blocks an accidental click.

### Out of Scope
- Any use of the stored credentials to fetch anything — Sprint 3 owns the HTTP client and consumes this store's decrypt helper.
- Sitemap URL fields (auto-discovery and the manual override) — Sprint 3 defines what it needs and extends the schema then, once the discovery flow is known. Guessing that shape now would be inventing a column before its consumer exists.
- Per-user ownership of projects. V1 has one shared login; all projects are visible to everyone who can log in.
- Audit history storage — explicitly excluded by PRD §4.5, scans are stateless.

### Dependencies
- Blocks: Sprint 5 (the scan UI selects a project from this store).
- Blocked by: Sprint 1 (auth gate, `BASE_PATH` helper, config module).
- External: None.
- **Runs in parallel with Sprint 3.** Sprint 3 must not modify this store or these routes; this sprint must not touch `lib/sitemap/`.

### Risks & Mitigations
- **The edit-password rule is the single most likely thing to be built wrong**, because "blank means keep" and "blank means clear" are both defensible readings and only one matches PRD §4.2's workflow. Requirement 5 states it explicitly and the acceptance criteria test all three transitions.
- **Encryption implemented with a static IV**, which silently destroys the security property while every test still passes. Called out as an explicit QA1 check rather than left to a general "is the crypto good" judgement.
- **File collision with Sprint 3** running in parallel. Mitigated by the ownership line in Dependencies and by Sprint 3 working in its own worktree.
- **The `Cache-Control` fix regressing on new routes**, because Sprint 1 fixed it on the routes that existed then. Mitigated by requirement 11 and by giving LiveQA its own Back-button check on this sprint's screens rather than assuming inheritance.
- **SSRF filtering treated as Sprint 3's problem** because that is where fetching happens. Save-time rejection belongs here, at the point of entry; Sprint 3 adds request-time checks as defence in depth. Both layers are required — DNS can resolve to a private address after a save-time check passes.

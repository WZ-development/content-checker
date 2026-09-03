# Master Controller Sprint Definition — Sprint 5

**Epic:** Reporting UI — the screens a developer actually uses to decide whether it is safe to push staging live.
**Sprint Objective:** Wire the engine to the interface: run a scan on demand from a saved project and present added and removed content as a scannable, actionable list.

### Context
This sprint makes the tool real. Everything before it is a library; this is the screen a developer looks at with a live push pending and a client's press release on the line. The output has one job — make the risk case impossible to miss and easy to act on.

A deliberate change from PRD §4.5, flagged when this epic was planned. The PRD gives green (on live, missing from staging) and red (on staging, missing from live) equal weight. But only green maps to the problem in §2: content that will be permanently destroyed. Red is usually the dev work about to ship — expected, not dangerous. Equal visual weight teaches developers to ignore both. So green is the alarm and red is informational, and the copy on screen says which is which.

### Requirements
1. A scan screen listing saved projects; selecting one and triggering a scan runs discovery, parse, comparison, and title resolution against both sites and renders the result. Behind Sprint 1's auth gate, using its `BASE_PATH` helper throughout.
2. Scans are stateless and on demand per PRD §4.5 — no history is stored and none is displayed.
3. A visible in-progress state while a scan runs, and the trigger control is disabled during the run so a double-click cannot start two concurrent scans.
4. **Results, grouped and clearly labelled**: a prominent primary section for content on live but missing from staging, framed as the action item ("these will be lost if you push"); a visually secondary section for content on staging but not live, framed as informational. Pages and posts are grouped separately within each. Each item shows its title and its URL as a clickable link opening in a new tab. Live-side items link to the live URL.
5. Items whose title was slug-derived rather than fetched are visually marked as approximate, per Sprint 4's flag.
6. A summary line stating counts for each group and the number compared, so a developer can confirm at a glance the scan actually examined the site rather than finding nothing because it fetched nothing.
7. **A clean, unambiguous zero-difference state** — an explicit "no differences found, safe to push" message, never an empty page that is indistinguishable from a failed scan.
8. **Incompleteness must be surfaced, not swallowed.** If Sprint 3/4 report truncation, ambiguous sitemaps, or skipped children, the results screen shows a clear warning that the comparison may be incomplete, alongside the results rather than instead of them. A truncated scan must never render as a clean pass.
9. **Manual sitemap fallback** per PRD §4.3: when discovery fails for either side, the UI explains which side failed and why, and prompts for a sitemap URL to be pasted. The scan is re-runnable with that URL supplied without re-entering anything else.
10. **Typed error presentation** using Sprint 3's failure types, each with an actionable message. Specifically, a 401/403 on the staging side must say the staging site needs `.htaccess` credentials and link directly to that project's edit screen — the most common real-world failure, and the one where a generic "scan failed" wastes the most time.
11. A failure on one side still renders whatever the other side returned, clearly labelled as a partial result. A staging site that is temporarily down should not discard a successful live scan.
12. Server-rendered, no bundler, per Sprint 1. Progressive enhancement only.
13. Tests cover: the route requires authentication, results render for all three group states, the zero-difference state, the truncation warning, the 401 staging message, and the partial-result path.

### Acceptance Criteria
- QA1 confirms the scan route is authenticated and uses the `BASE_PATH` helper for every link, form action, and asset.
- QA1 confirms no scan result is persisted anywhere.
- QA1 confirms the trigger is disabled during a run and that a repeated submit cannot start a second concurrent scan — the double-submit guard must be server-side, not only a disabled attribute in the browser.
- QA1 confirms the live-missing-from-staging section is rendered with greater prominence than the reverse section, and asserts on the actual framing copy in both, not merely that two sections exist.
- QA1 confirms slug-derived titles are visually marked, asserting on the rendered output.
- QA1 confirms the zero-difference state renders its explicit message, asserting on the message text.
- QA1 confirms a truncated result renders the incompleteness warning **and** the results together, asserting on both being present — a truncated scan rendering as clean is a sprint failure.
- QA1 confirms a 401 on the staging side produces the credentials-specific message and a working link to that project's edit screen, asserting on the message text and the link target.
- QA1 confirms a one-sided failure still renders the successful side, labelled partial.
- QA1 runs `npm test` and `npm run lint`; both pass.
- **LiveQA runs the full workflow live**, and this is the sprint where the engine gets its real-world test: log in, create a project against a genuine WordPress site, run a scan, and confirm results render with working links that open the correct pages. Then run a scan against a site whose staging URL requires Basic Auth with no credentials saved, and confirm the 401 message and its edit link appear. Then a project whose staging URL has no discoverable sitemap, and confirm the manual-entry prompt appears and a pasted sitemap URL completes the scan. Confirm the double-click guard by clicking the trigger twice quickly.

### Out of Scope
- Automated transfer of missing content — V2 per PRD §6.1. This screen produces a list a developer acts on manually, which PRD §4.5 defines as the V1 workflow.
- Exporting or emailing results. Not requested; the screen is the deliverable.
- Scheduled or background scans — on demand only per PRD §4.5.
- Body-text diffing — V2 per PRD §6.2.
- Deploying to `tools.wordzite.com` — a separate sprint once the host exists.

### Dependencies
- Blocks: production deployment (the last V1 sprint, not yet defined).
- Blocked by: Sprint 2 (project store), Sprint 4 (comparison output), and transitively Sprints 1 and 3.
- External: LiveQA needs a real WordPress site to scan, plus one Basic Auth-protected staging site to verify the 401 path. Identify both before this sprint reaches its live gate.

### Risks & Mitigations
- **This is the first sprint where the engine meets reality**, and real WordPress sites will break assumptions the fixtures did not. That is expected and is exactly why LiveQA's criteria here are the most detailed in the epic. Budget for a fix loop rather than treating one as a failure.
- **The incompleteness warning gets built as a small grey note** and is missed on the screen where it matters most. Mitigated by requiring QA1 to assert warning and results render together, and by keeping its prominence an explicit acceptance criterion.
- **Green/red weighting reverting to the PRD's equal treatment** because the PRD says so and the reasoning lives only here. The deviation and its justification are recorded in Context so QA1 audits against this file, not the PRD.
- **Long scans on large sites feeling broken.** Mitigated by requirement 3's progress state and requirement 6's count summary. If real use shows scans routinely exceeding the budget, that is a follow-up sprint, not scope to absorb here.

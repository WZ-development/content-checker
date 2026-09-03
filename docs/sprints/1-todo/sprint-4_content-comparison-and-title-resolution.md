# Master Controller Sprint Definition — Sprint 4

**Epic:** Sitemap Engine — finding, fetching, and reading WordPress sitemaps reliably enough that a "no differences" result can be trusted.
**Sprint Objective:** Compare the live and staging URL sets on normalized paths, classify the differences, and resolve a human-readable title for each differing item.

### Context
Sprint 3 returns two URL sets whose members never match textually — live is `clientdomain.com/about/` and staging is `staging.clientdomain.com/about/`. Compared as raw strings, every single page reports as both added and removed, and the tool is worthless. Normalizing to a comparable key is the requirement that makes the product work, and the PRD does not mention it at all.

Titles are the second gap. WordPress sitemaps carry no titles — verified 2026-09-02 against Yoast output, where a `<url>` entry holds only `<loc>`, `<lastmod>`, and `<image:loc>`. The agreed approach is to fetch `<title>` only for URLs in the computed diff, which is typically a handful of pages rather than the full sitemap, keeping the tool fast and the client's server unbothered.

### Requirements
1. A comparison module taking two URL sets (live, staging) and returning classified results. Pure functions over data — no HTTP inside the comparison itself, so it is fully testable without a network.
2. **Normalization to a comparison key**, applied to every URL before comparison: strip scheme, strip the host entirely, fold `www.`, lowercase the path, normalize the trailing slash consistently, and drop URL fragments. Query strings are preserved but normalized in parameter order.
3. The host is stripped rather than mapped, so an arbitrary staging host (`staging.clientdomain.com`, `client.wpengine.com`, `dev-client.kinsta.cloud`) compares correctly against live without configuration. Document this in the module.
4. Classification into exactly three groups: **on live but not staging** (the risk case — content that will be destroyed by a push), **on staging but not live** (informational — usually the dev work about to ship), and **on both** (not displayed, but counted).
5. The result distinguishes pages from posts, carrying through the source sitemap classification from Sprint 3, so the UI can group them.
6. **Title resolution** for differing items only: fetch each URL, parse the `<title>` element, strip any common site-name suffix (` - Site Name`, ` | Site Name`), and return the cleaned title. Never fetch titles for the on-both set.
7. Title fetching is concurrency-limited (default 5), per-request timeout (default 10s), respects Basic Auth for staging-side URLs, and is subject to an overall cap (default 100 items) beyond which items fall back to slug-derived titles rather than blocking the scan.
8. **Slug fallback**, used whenever a title fetch fails, times out, returns non-HTML, or is skipped by the cap: derive a readable label from the last path segment (`/news/q3-earnings/` → "Q3 Earnings"), handling hyphens, underscores, and percent-encoding. A failed title fetch must **never** fail the scan or drop the item from the results.
9. Each result item records whether its title was fetched or slug-derived, so the UI can distinguish a real title from a guess.
10. The comparison result carries the completeness signals from Sprint 3 (truncated flag, ambiguous or skipped sitemaps) through to its own output, so Sprint 5 can warn that a diff may be incomplete. A truncated scan must never present as a clean, complete result.
11. Unit tests cover: normalization across host, scheme, `www`, case, trailing-slash, and fragment variants; all three classification groups; empty sets on either side; slug derivation including percent-encoded and underscore cases; title-suffix stripping; and title-fetch failure falling back to slug without dropping the item.

### Acceptance Criteria
- QA1 confirms `https://clientdomain.com/About/`, `http://www.clientdomain.com/about`, and `https://staging.clientdomain.com/about/#team` all normalize to the same key — the central correctness test of this sprint.
- QA1 confirms comparison is pure and testable with no network, by running the comparison tests with networking unavailable.
- QA1 confirms the three classification groups are correct against a fixture where all three are non-empty, and correct when either input set is empty.
- QA1 confirms titles are fetched **only** for differing items, by asserting on the number of outbound requests against a fixture whose on-both set is large — this is the performance requirement and a count assertion is the only way to verify it.
- QA1 confirms a failed, timed-out, and non-HTML title fetch each produce a slug-derived title and that the item still appears in the results, asserting on the returned item rather than only on the absence of an exception.
- QA1 confirms slug derivation handles `/news/q3-earnings/`, `/about_our_team/`, and a percent-encoded segment, asserting on the produced label text.
- QA1 confirms site-name suffix stripping works for both ` - ` and ` | ` separators and does not mangle a title that legitimately contains those characters mid-sentence.
- QA1 confirms each item exposes whether its title was fetched or derived, and that the truncated/ambiguous signals from Sprint 3 survive into the comparison output.
- QA1 confirms Basic Auth headers are sent on staging-side title fetches.
- QA1 runs `npm test` and `npm run lint`; both pass.
- LiveQA's live verification of this logic happens in Sprint 5 against the real results screen; this sprint ships with a live smoke test that the app boots and prior screens are unbroken.

### Out of Scope
- Comparing body text or detecting edits to existing pages — explicitly V2 per PRD §6.2. This sprint compares URL presence only. A page present on both sides is "on both" regardless of its content having changed.
- Any UI or rendering — Sprint 5.
- Automated content transfer — V2 per PRD §6.1.
- Detecting moved or renamed pages (a slug change reads as one removal plus one addition). Correct behaviour for V1: the developer sees both and draws the conclusion. Guessing at rename detection risks hiding a genuine deletion.
- Storing comparison results — scans are stateless per PRD §4.5.

### Dependencies
- Blocks: Sprint 5 (renders this module's output).
- Blocked by: Sprint 3 (URL sets and their classification), Sprint 2 (decrypt helper for staging title fetches).
- External: None. All behaviour is testable against fixtures.

### Risks & Mitigations
- **Normalization that is nearly right** — trailing slash handled, `www` missed — producing a diff full of false positives that trains developers to distrust the tool. Mitigated by requirement 2 enumerating every transform and by the multi-variant acceptance test.
- **Rename detection creeping in** as a "helpful" improvement, which can hide a real deletion behind a guessed pairing. Explicitly out of scope with the reasoning recorded.
- **Title fetching quietly expanded to the full URL set** because it is simpler to write. Mitigated by an acceptance criterion that counts outbound requests rather than trusting the code path.
- **A truncated Sprint 3 result presented as complete**, which reintroduces the silent-data-loss failure one layer up. Requirement 10 forces the signal through; Sprint 5 must display it.

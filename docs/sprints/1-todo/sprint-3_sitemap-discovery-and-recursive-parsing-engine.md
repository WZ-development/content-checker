# Master Controller Sprint Definition — Sprint 3

**Epic:** Sitemap Engine — finding, fetching, and reading WordPress sitemaps reliably enough that a "no differences" result can be trusted.
**Sprint Objective:** Deliver a standalone, well-tested module that discovers a site's sitemap, recursively resolves nested sitemap indexes behind optional HTTP Basic Auth, and returns the complete set of page and post URLs.

### Context
This is the sprint the product lives or dies on. Every requirement downstream assumes the URL set handed to it is complete; if this module silently drops a sitemap, the tool reports "no differences" and a developer pushes staging live over a client's press release. A missing-content bug here is invisible at every later layer, which is why the requirements below are unusually specific about completeness.

PRD §4.3's stated approach — fetch `/sitemap_index.xml`, then target `page-sitemap.xml` and `post-sitemap.xml` — was checked against real sites before this sprint was written, and it does not hold. Findings, all verified by hand on 2026-09-02: `wordpress.org` returns 404 for a guessed path while its `robots.txt` advertises the correct one; `techcrunch.com` answers at `sitemap_index.xml` but advertises `sitemap.xml`; Yoast paginates, serving both `post-sitemap.xml` **and** `post-sitemap2.xml`; and TechCrunch's index holds **2,057** children named `sitemap-page-N.xml`, a scheme the PRD's filename rule matches not at all. The requirements below are written against those observations rather than against the PRD's assumption.

### Requirements
1. A standalone module (`lib/sitemap/`) exporting a discovery-and-parse function taking a base URL and optional Basic Auth credentials, returning a structured result. It registers **no Express routes and no UI**; Sprint 5 wires it up.
2. **Discovery order**, tried in sequence until one yields a valid sitemap: (a) fetch `/robots.txt` and use every `Sitemap:` directive it declares; (b) fall back to candidate paths `/sitemap_index.xml`, `/wp-sitemap.xml`, `/sitemap.xml`; (c) report discovery failure in a form the UI can turn into a manual-entry prompt.
3. An explicit manual sitemap URL, when supplied by the caller, bypasses discovery entirely and is used directly.
4. **Recursive resolution** of `<sitemapindex>` documents into their child `<urlset>` documents, to a depth of at least 3, with cycle detection — a sitemap that references itself, directly or through a chain, must terminate rather than loop.
5. **Child sitemap selection must not rely on exact filenames.** Select children whose URL indicates pages or posts under either observed convention (`page-sitemap.xml`, `post-sitemap2.xml`, `sitemap-page-1.xml`, and equivalents), including numeric pagination suffixes. Explicitly exclude children clearly identifying other content types (`product-`, `category-`, `author-`, `tag-`, `media-`, `attachment-`) per PRD §4.4.
6. When a child sitemap cannot be confidently classified, **include it and record that it was ambiguous.** Over-inclusion produces a visible false positive a developer can dismiss; under-inclusion produces silent data loss. The result must carry the list of sitemaps consulted and any that were skipped or unclassifiable, so callers can surface it.
7. Outgoing requests send `Authorization: Basic <base64>` when credentials are supplied, on every request in the chain including redirects to the same host, and consume Sprint 2's decrypt helper rather than reimplementing decryption.
8. Per-request timeout (default 15s) and an overall operation budget (default 90s). Cap the number of child sitemaps fetched (default 50, configurable) and return a clear "truncated" flag when the cap is hit — a 2,057-child index must degrade honestly, never hang or silently take the first few.
9. Concurrency-limited fetching (default 5 in flight) with a descriptive `User-Agent` identifying the tool.
10. **Request-time SSRF defence**: after DNS resolution and again after any redirect, reject loopback, link-local, and private-range addresses. Do not follow redirects to a different host than the one requested without re-running the check.
11. **Typed, distinguishable failures**, not a generic error: DNS failure, connection refused, timeout, 401/403 (credentials missing or wrong), 404 (not found), non-XML response body, and malformed XML must each be separately identifiable by the caller. A 401 in particular must be distinguishable from a 404, because it means "add your .htaccess credentials," which is the single most common real-world case.
12. XML parsing handles namespaced documents, an XML declaration, an `<?xml-stylesheet?>` processing instruction, and `image:` child elements — all observed on real Yoast output. A `<urlset>` entry yields its `<loc>` and, when present, `<lastmod>`.
13. Unit tests run against **fixture files, not the live internet**, covering: a sitemap index, nested indexes, a paginated Yoast-style set, a TechCrunch-style `sitemap-page-N` set, a cyclic reference, malformed XML, an empty urlset, a non-XML body, and a 401 response.

### Acceptance Criteria
- QA1 confirms the module registers no routes and imports nothing from Sprint 2's route layer — only its decrypt helper.
- QA1 confirms discovery tries robots.txt **first** and only then the candidate paths, by test, asserting on the actual request sequence.
- QA1 confirms recursion terminates on the cyclic fixture rather than hanging or overflowing, and that the depth-3 nested fixture resolves fully.
- QA1 confirms the paginated fixture returns URLs from **both** `post-sitemap.xml` and `post-sitemap2.xml`, and that the `sitemap-page-N` fixture returns URLs from every child — asserting on total URL count, since this is the silent-data-loss case.
- QA1 confirms `product-`, `category-`, `author-`, `tag-`, and `media-` children are excluded, and that an unrecognized child is **included** and flagged ambiguous in the returned result.
- QA1 confirms the returned result exposes the list of sitemaps consulted, skipped, and unclassifiable — asserting on the returned structure, since Sprint 5 must be able to display it.
- QA1 confirms the `Authorization` header is present on child-sitemap requests, not only the first request, by asserting on captured outbound request headers.
- QA1 confirms the child-sitemap cap produces a result with the truncated flag set rather than an exception or a silently short list, and that the per-request and overall timeouts are both enforced.
- QA1 confirms each failure mode in requirement 11 is separately identifiable, specifically that a 401 fixture and a 404 fixture produce distinguishable results.
- QA1 confirms the SSRF check runs after redirects, not only on the initial URL.
- QA1 confirms tests use fixtures and make no live network calls — the suite must pass with networking unavailable.
- LiveQA is **not a gate on this sprint's module directly** — it has no UI. LiveQA's live verification of the engine happens in Sprint 5, against the real scan screen. This sprint still ships through Pipeman and still gets a live smoke test that the app boots and existing screens are unbroken.

### Out of Scope
- Comparing two sites' URL sets — Sprint 4.
- Fetching page titles — Sprint 4.
- Any UI, route, or scan trigger — Sprint 5.
- Custom post types, WooCommerce products, media, menus — excluded by PRD §4.4. Requirement 5's exclusion list enforces that boundary.
- Caching sitemap responses. Scans are stateless per PRD §4.5; add caching only if real use shows it is needed.

### Dependencies
- Blocks: Sprint 4 (consumes this module's URL sets), Sprint 5 (triggers it).
- Blocked by: Sprint 1 (config module). Needs Sprint 2's decrypt helper — if Sprint 2 has not landed it yet, code against a narrow interface and integrate when it does. Do not reimplement decryption.
- External: Real-world sitemap conventions, verified by hand on 2026-09-02 (see Context). Fixtures should be captured from real output rather than hand-invented.
- **Runs in parallel with Sprint 2. Dev Team 2 must run `/sprint-worktree 3` before touching any file.** This sprint owns `lib/sitemap/` and its fixtures, and nothing else.

### Risks & Mitigations
- **Silent under-collection** — the module returns a plausible-looking URL set that is missing a paginated child, and every downstream layer trusts it. The highest-severity risk in the project. Mitigated by requirement 6's include-when-unsure rule, the consulted/skipped list, and count-asserting acceptance criteria on both pagination fixtures.
- **Filename matching that fits Yoast and breaks on everything else.** Mitigated by requiring both observed naming schemes in fixtures and tests, drawn from real sites rather than invented.
- **A 2,057-child index treated as a hypothetical.** It is not — it was observed. Requirement 8's cap plus the truncated flag makes the degradation visible instead of turning it into a hang.
- **Tests written against the live internet**, which makes the suite slow, flaky, and dependent on third-party sites not changing. Explicitly forbidden by requirement 13 and checked by QA1.
- **File collision with Sprint 2.** Mitigated by the mandatory worktree and the ownership boundary above.

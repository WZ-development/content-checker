# Allowing Content Checker through a CDN/WAF challenge

Some staging and live sites sit behind a CDN or WAF (Cloudflare is the
common case for this project) that challenges automated requests before
they ever reach the origin server. Content Checker's scan shows up to
that CDN exactly like any other bot — because it is one — so a site with
challenge protection turned on will block the scan outright unless you
add an allow rule.

This document describes that rule. Setting it up is a one-time,
per-site action you take on the CDN's own dashboard; Content Checker
does not, and cannot, push this rule for you.

## Why not just match on User-Agent?

**Do not build the allow rule around Content Checker's User-Agent
string** (`ContentCheckerBot/1.0 (+https://tools.wordzite.com/content-checker)`).
A User-Agent header is just text the client sends — anyone, including
the exact bot traffic the CDN's challenge exists to stop, can set that
same string on their own requests and walk straight through your allow
rule. It identifies this tool for logging purposes only; it grants
nothing and must never be treated as a credential.

The mechanism below exists specifically because User-Agent matching is
unsafe: it keys the rule on a per-deployment secret value instead.

## The rule

Content Checker sends a header named `X-ContentCheck-Token` on outbound
requests to this project's own configured live/staging hosts when
`CONTENTCHECK_OUTBOUND_TOKEN` is configured for that deployment (generate
one with `npm run generate-outbound-token`; see `.env.example`) — never
to a third-party host merely referenced inside a scanned site's content
(a sitemap `<loc>`, a redirect, a robots.txt directive); the tool scopes
it to the project's own origins so a compromised or malicious scanned
site cannot use its own content to harvest the token for a host it
doesn't otherwise touch.

That header's value is a random secret unique to your deployment.
Unlike a User-Agent string, someone who does not control one of the
sites you scan has no way to learn or guess it — but anyone who DOES
control a site you scan (a compromised WordPress install is routine)
necessarily sees it, the same way any bot-identification header is
visible to whatever it's sent to. That is exactly why the post-deploy
IP-tightening below is not optional, not a nice-to-have: it's what stops
a captured token from being replayed from a different source once one
client site is compromised.

Add a Cloudflare WAF custom rule with:

- **Field / expression:**
  ```
  (http.request.headers["x-contentcheck-token"][0] eq "<your token>")
  ```
  Replace `<your token>` with the actual value of your deployment's
  `CONTENTCHECK_OUTBOUND_TOKEN` — paste it in only when you create the
  rule on Cloudflare's own dashboard. Never paste it anywhere else, and
  never commit it to a repository; treat it the same way you'd treat any
  other secret.
- **Action:** `Skip`, with the following protection components skipped
  for matching requests:
  - Managed Challenge / Bot Fight Mode
  - WAF managed rules (if they are what's triggering the block)
  - Rate limiting, if a scan's request volume is tripping it

  Skip only the components actually blocking the scan — skipping more
  than that widens the hole in your site's protection further than this
  rule needs to.

## Post-deploy: tightening to the app's egress IP

Once Content Checker's production deployment has a known, stable
outbound IP address (sprint 6), narrow the rule further by ANDing in a
source-IP condition:

```
(http.request.headers["x-contentcheck-token"][0] eq "<your token>") and ip.src eq <egress IP>
```

`<egress IP>` is a placeholder — TBD, pending sprint 6's egress-IP work.
Until that lands, the header match alone is the rule; add the IP
condition once a stable egress IP exists, so the allow rule can't be
reused by a request carrying a stolen or leaked token from a different
source.

## Caveats

1. **Cloudflare Free-plan Bot Fight Mode cannot be skipped by a WAF
   custom rule** — on the Free plan, Bot Fight Mode can only be turned
   off entirely for the zone, not bypassed per-request the way paid-plan
   Bot Management can. Check which plan the target site is on before
   assuming this rule alone will let scans through; a Free-plan site may
   need Bot Fight Mode disabled outright instead.
2. **The rule must cover the whole host, not just sitemap paths.**
   Content Checker doesn't only fetch a sitemap URL — it also fetches
   the actual page URLs listed in that sitemap to read their `<title>`.
   A rule scoped to `/sitemap.xml` or similar will let discovery through
   and then silently fail every title fetch, which falls back to
   showing the raw URL slug instead of the page's real title rather than
   erroring loudly. Scope the rule to the entire hostname.
3. **A WordPress security plugin (Wordfence and similar) has its own,
   separate bot blocking**, independent of whatever the CDN in front of
   it does. If the site runs one, it needs its own equivalent allowance
   — an entry keyed on something the plugin can actually verify, such as
   a known egress IP once sprint 6 lands (never the User-Agent string,
   for the same reason given above) — in addition to the CDN-level rule
   above, or the plugin will challenge/block the scan even after the CDN
   lets it through.

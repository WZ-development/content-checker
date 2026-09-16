'use strict';

const { errors } = require('../../lib/sitemap/index');

const STAGING_AUTH_MESSAGE =
  'This staging site requires HTTP Basic Auth (.htaccess) credentials to access its sitemap. Add them on the project’s edit screen.';

const AUTH_CODES = new Set(['HTTP_401', 'HTTP_403']);
const DNS_ERROR_CODE = 'DNS_ERROR';

/**
 * QA1's Sprint 5 audit, finding B: automatic discovery (robots.txt, then
 * each candidate path — see lib/sitemap/discovery.js) catches an
 * individual attempt's failure and keeps trying the next one, so a 401
 * on every attempt never propagates as HttpAuthError — it exhausts every
 * strategy and throws SitemapDiscoveryFailedError instead, indistinguishable
 * from any other kind of not-found. That's correct behaviour for
 * discovery (one bad candidate shouldn't stop it trying the next), but
 * the auth signal it swallows is exactly what requirement 10 needs on
 * its PRIMARY path — a saved staging URL, no manual sitemap entered,
 * which is what LiveQA's own criterion scans. The information already
 * exists: SitemapDiscoveryFailedError.attempts carries `error:
 * 'HTTP_401'`/`'HTTP_403'` on every row that hit one (discovery.js
 * records it from each attempt's own err.code). This just reads it
 * back out, rather than discarding it as the generic "couldn't
 * discover" case did before this fix.
 *
 * Returns the specific auth-coded attempt found (not just a boolean) so
 * the caller can tell 401 apart from 403 — see describeLiveAuthMessage.
 */
function findAuthAttempt(discoveryFailedError) {
  return (discoveryFailedError.attempts || []).find((attempt) => AUTH_CODES.has(attempt.error));
}

/**
 * LiveQA's Sprint 5 round-1 live test, issue 1: the SAME shape as
 * finding B, for a different attempt reason. Every discovery attempt is
 * against a subpath of the SAME hostname, so if that host genuinely
 * doesn't resolve, EVERY attempt fails with DNS_ERROR uniformly — there
 * is no mixed-result case the way a partially-protected site can mix
 * 401s with 404s. Checking that ALL attempts share the code (not just
 * "any", the way the auth check works) is what LiveQA's own report asked
 * for: "if the attempts all failed with DNS resolution... surface that
 * type's message". Demonstrated live: the exact same unresolvable
 * staging host produced the correct DNS message on the manual-URL path
 * and the generic "paste a sitemap URL" text on the discovery path —
 * sending a developer to paste a URL on a host that will never resolve.
 */
function allAttemptsFailedWithCode(discoveryFailedError, code) {
  const attempts = discoveryFailedError.attempts || [];
  return attempts.length > 0 && attempts.every((attempt) => attempt.error === code);
}

/**
 * LiveQA's Sprint 5 round-1 live test, issue 2: a live-side 403 was
 * presented as an "authentication error" with no next step — diagnosing
 * every 403 as a credentials problem. The first real site this tool met
 * was Cloudflare-managed-challenge (a bot-protection 403, nothing to do
 * with credentials), which is exactly the ambiguity 403 carries that 401
 * doesn't. Scope, per direct instruction: a generic, honest "the site
 * refused the request" for 403 — distinct from 401's wording — and
 * nothing WAF/Cloudflare-specific (that's Sprint 7, already written, and
 * keys off a response header this module doesn't have).
 */
function describeLiveAuthMessage(status) {
  if (status === 403) {
    return 'This live site refused the request (HTTP 403).';
  }
  return `This live site rejected the request with an authentication error (HTTP ${status}).`;
}

/**
 * Maps a thrown lib/sitemap error into an actionable message for the
 * scan results screen (requirement 10). `side` ('live' | 'staging')
 * changes the auth-error wording, since only staging has a credential
 * field to send someone to — requirement 10 is specific that a 401/403
 * on the STAGING side must name .htaccess credentials and link to the
 * edit screen; a live-side auth error (unusual, but possible) gets a
 * plain explanation since there is nowhere to add a live-side
 * credential in this app's schema.
 *
 * Every branch produces *some* message — including the final `else`,
 * for an error that isn't even a recognized SitemapError subclass at
 * all. That case is also where the raw error gets logged server-side
 * (never swallowed) before returning a generic message to the client,
 * the same pattern src/app.js's own error handler uses.
 *
 * Returns { message, editUrl }. `editUrl` is only ever set for the
 * staging-side auth case; the view treats its presence as "show a link
 * here," nothing more.
 */
function describeSitemapError(err, { side, editUrl }) {
  if (err instanceof errors.HttpAuthError) {
    if (side === 'staging') {
      return { message: STAGING_AUTH_MESSAGE, editUrl };
    }
    return { message: describeLiveAuthMessage(err.status) };
  }

  if (err instanceof errors.SitemapDiscoveryFailedError) {
    const authAttempt = findAuthAttempt(err);
    if (authAttempt) {
      if (side === 'staging') {
        return { message: STAGING_AUTH_MESSAGE, editUrl };
      }
      return { message: describeLiveAuthMessage(authAttempt.error === 'HTTP_403' ? 403 : 401) };
    }

    if (allAttemptsFailedWithCode(err, DNS_ERROR_CODE)) {
      return { message: "Could not resolve this site's domain name." };
    }

    return {
      message:
        'Could not automatically discover a sitemap for this site. Paste a sitemap URL below and run the scan again.',
    };
  }

  if (err instanceof errors.HttpNotFoundError) {
    return { message: 'The sitemap URL returned a 404 Not Found.' };
  }

  if (err instanceof errors.DnsResolutionError) {
    return { message: "Could not resolve this site's domain name." };
  }

  if (err instanceof errors.SsrfBlockedError) {
    return { message: 'This URL resolves to an address this tool is not permitted to fetch.' };
  }

  if (err instanceof errors.SitemapTimeoutError || err instanceof errors.BudgetExceededError) {
    return { message: 'This site took too long to respond and the scan timed out.' };
  }

  if (err instanceof errors.TooManyRedirectsError) {
    return { message: 'This site redirected too many times.' };
  }

  if (err instanceof errors.NonXmlResponseError) {
    return { message: 'The sitemap URL did not return recognizable sitemap content.' };
  }

  if (err instanceof errors.MalformedXmlError) {
    return { message: 'The sitemap URL returned XML that could not be parsed.' };
  }

  if (err instanceof errors.ConnectionError) {
    return { message: 'Could not connect to this site.' };
  }

  if (err instanceof errors.SitemapError) {
    // A recognized-but-not-specifically-handled typed error — still
    // actionable, still never a bare "scan failed".
    return { message: `Could not fetch this site's sitemap (${err.code}).` };
  }

  // Not a lib/sitemap error at all — genuinely unexpected. Log the full
  // detail server-side; the client only ever sees a generic message,
  // same convention as src/app.js's own top-level error handler.
  console.error('[content-checker] unexpected error during scan:', err);
  return { message: 'An unexpected error occurred while scanning this site.' };
}

module.exports = { describeSitemapError };

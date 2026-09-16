'use strict';

const { errors } = require('../../lib/sitemap/index');

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
      return {
        message:
          'This staging site requires HTTP Basic Auth (.htaccess) credentials to access its sitemap. Add them on the project’s edit screen.',
        editUrl,
      };
    }
    return { message: `This live site rejected the request with an authentication error (HTTP ${err.status}).` };
  }

  if (err instanceof errors.SitemapDiscoveryFailedError) {
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

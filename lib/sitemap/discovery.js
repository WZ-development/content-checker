'use strict';

const { parseRobotsTxtForSitemaps } = require('./robots');
const { parseSitemapXml } = require('./xml');
const { CANDIDATE_SITEMAP_PATHS } = require('./constants');
const { SitemapDiscoveryFailedError } = require('./errors');

/**
 * Automatic discovery, requirement 2: robots.txt first (using *every*
 * `Sitemap:` line it declares), then candidate paths in sequence until
 * one yields a valid sitemap, then failure.
 *
 * Each candidate is fully fetched and parsed here (not just
 * status-checked) because "yields a valid sitemap" requires knowing the
 * body actually parses — and the successfully-validated document is
 * returned alongside its URL so the crawl phase doesn't have to fetch it
 * a second time.
 *
 * Returns `{ method, roots: [{ url, parsedDoc }], attempts }` on success.
 * Throws SitemapDiscoveryFailedError, carrying every attempt and why it
 * failed, when nothing works — the shape the sprint file asks for so the
 * UI can turn it into a manual-entry prompt.
 */
async function discoverSitemapRoots(baseUrl, { guardedFetch }) {
  const attempts = [];

  const robotsUrl = new URL('/robots.txt', baseUrl).href;
  let robotsSitemapUrls = [];
  try {
    const res = await guardedFetch(robotsUrl);
    robotsSitemapUrls = parseRobotsTxtForSitemaps(res.body, baseUrl);
    attempts.push({
      url: robotsUrl,
      method: 'robots.txt',
      ok: robotsSitemapUrls.length > 0,
      declaredCount: robotsSitemapUrls.length,
    });
  } catch (err) {
    attempts.push({ url: robotsUrl, method: 'robots.txt', ok: false, error: err.code || 'UNKNOWN' });
  }

  if (robotsSitemapUrls.length > 0) {
    const roots = [];
    for (const url of robotsSitemapUrls) {
      const validated = await validateSitemapCandidate(url, { guardedFetch });
      attempts.push({
        url,
        method: 'robots.txt-declared',
        ok: validated.ok,
        error: validated.ok ? undefined : validated.errorCode,
      });
      if (validated.ok) roots.push({ url, parsedDoc: validated.parsedDoc });
    }
    if (roots.length > 0) {
      return { method: 'robots.txt', roots, attempts };
    }
    // Every robots.txt-declared sitemap failed to validate — fall through
    // to the candidate paths rather than giving up on a site that has a
    // stale/broken robots.txt but a perfectly good sitemap.
  }

  for (const path of CANDIDATE_SITEMAP_PATHS) {
    const url = new URL(path, baseUrl).href;
    const validated = await validateSitemapCandidate(url, { guardedFetch });
    attempts.push({
      url,
      method: 'candidate',
      ok: validated.ok,
      error: validated.ok ? undefined : validated.errorCode,
    });
    if (validated.ok) {
      return { method: 'candidate', roots: [{ url, parsedDoc: validated.parsedDoc }], attempts };
    }
  }

  throw new SitemapDiscoveryFailedError(attempts);
}

async function validateSitemapCandidate(url, { guardedFetch }) {
  try {
    const res = await guardedFetch(url);
    const parsedDoc = parseSitemapXml(res.body, { contentType: res.contentType, sourceUrl: url });
    return { ok: true, parsedDoc };
  } catch (err) {
    return { ok: false, errorCode: err.code || 'UNKNOWN' };
  }
}

module.exports = { discoverSitemapRoots, validateSitemapCandidate };

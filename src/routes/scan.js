'use strict';

const express = require('express');

const { verifyCsrfToken } = require('../middleware/csrf');
const { normalizeAndValidateUrl } = require('../lib/urlValidation');
const { describeSitemapError } = require('../lib/scanErrorPresentation');
const { groupBySourceType, buildRawSideItems, summarizeCompleteness } = require('../lib/scanResultPresentation');
const { discoverAndParseSitemap } = require('../../lib/sitemap/index');
const { compareAndResolveTitles } = require('../../lib/compare/index');

function renderNotFound(res) {
  res.status(404).render('error', {
    title: 'Not found',
    message: "That project doesn't exist, or has already been deleted.",
  });
}

/**
 * Resolves one side of the comparison: a manually-supplied sitemap URL
 * (validated the same way Sprint 2 validates the project's own URL
 * fields — a pasted sitemap URL is exactly as much untrusted input, and
 * deserves the same http(s)-only/SSRF-range check) replaces automatic
 * discovery entirely for that side when given; otherwise discovery runs
 * against the project's saved base URL. Never throws — every failure
 * mode (a bad manual URL, or any lib/sitemap error) becomes
 * `{ ok: false, error }`, so Promise.allSettled isn't even needed at
 * this layer; the caller runs both sides with Promise.all over this.
 */
async function resolveSide({
  baseUrl,
  manualUrlRaw,
  auth,
  side,
  editUrl,
  fetchImpl,
  dnsLookup,
  outboundTokenConfigured,
}) {
  let manualSitemapUrl;
  if (manualUrlRaw) {
    const validated = await normalizeAndValidateUrl(manualUrlRaw);
    if (!validated.valid) {
      return { ok: false, error: { message: validated.error } };
    }
    manualSitemapUrl = validated.url;
  }

  try {
    const result = await discoverAndParseSitemap({
      baseUrl: manualSitemapUrl ? undefined : baseUrl,
      manualSitemapUrl,
      auth,
      fetchImpl,
      dnsLookup,
    });
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: describeSitemapError(err, { side, editUrl, outboundTokenConfigured }) };
  }
}

/**
 * Builds the scan router. `fetchImpl`/`dnsLookup` are the ONE pinned
 * pair constructed once in src/app.js (requirement 14) — this router
 * never constructs its own, and passes the identical pair into both
 * lib/sitemap's discoverAndParseSitemap AND lib/compare's
 * compareAndResolveTitles (which forwards it to resolveTitles).
 *
 * `outboundTokenConfigured` (sprint 7, requirement 7) is a plain boolean
 * — never the token itself — forwarded from src/app.js's
 * Boolean(config.outboundToken) straight through to
 * describeSitemapError, purely so a CDN-challenge message can lead with
 * "no token configured yet" when that's true. This route never reads or
 * forwards the actual token value; wrapFetchWithOutboundToken
 * (lib/net/pinnedFetch.js) is the only place that touches it.
 *
 * Requirement 16, the credential boundary: `repository
 * .getDecryptedBasicAuthPassword()` is called ONLY here, in the route.
 * The plaintext `{username, password}` it produces is handed to
 * lib/sitemap and lib/compare as a plain option — neither module
 * imports the repository or the decrypt helper (verified structurally
 * in their own Sprint 4 tests).
 */
function createScanRouter({ urlHelper, repository, fetchImpl, dnsLookup, outboundTokenConfigured }) {
  const router = express.Router();

  // Sprint 5, requirement 3: the double-submit guard must be
  // server-side, not only a disabled button. A project id sitting in
  // this Set means a scan for it is in flight right now — scoped to
  // this router instance (built fresh per createApp() call) so tests
  // never see state bleed between app instances, the same reasoning
  // Sprint 2's repository injection exists for.
  const scansInProgress = new Set();

  router.get('/projects/:id/scan', (req, res, next) => {
    try {
      const project = repository.getProjectForEdit(req.params.id);
      if (!project) {
        renderNotFound(res);
        return;
      }
      res.render('scan/show', {
        project,
        scanResult: null,
        alreadyRunning: false,
        manualLiveSitemapUrl: '',
        manualStagingSitemapUrl: '',
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/projects/:id/scan', verifyCsrfToken, async (req, res, next) => {
    try {
      const project = repository.getProjectForEdit(req.params.id);
      if (!project) {
        renderNotFound(res);
        return;
      }

      const manualLiveSitemapUrl = typeof req.body.manualLiveSitemapUrl === 'string' ? req.body.manualLiveSitemapUrl.trim() : '';
      const manualStagingSitemapUrl =
        typeof req.body.manualStagingSitemapUrl === 'string' ? req.body.manualStagingSitemapUrl.trim() : '';

      if (scansInProgress.has(project.id)) {
        res.status(409).render('scan/show', {
          project,
          scanResult: null,
          alreadyRunning: true,
          manualLiveSitemapUrl,
          manualStagingSitemapUrl,
        });
        return;
      }

      scansInProgress.add(project.id);
      try {
        const editUrl = urlHelper(`/projects/${project.id}/edit`);
        const auth = project.hasPassword
          ? { username: project.basicAuthUsername, password: repository.getDecryptedBasicAuthPassword(project.id) }
          : undefined;

        const [live, staging] = await Promise.all([
          resolveSide({
            baseUrl: project.liveUrl,
            manualUrlRaw: manualLiveSitemapUrl,
            side: 'live',
            fetchImpl,
            dnsLookup,
            outboundTokenConfigured,
          }),
          resolveSide({
            baseUrl: project.stagingUrl,
            manualUrlRaw: manualStagingSitemapUrl,
            auth,
            side: 'staging',
            editUrl,
            fetchImpl,
            dnsLookup,
            outboundTokenConfigured,
          }),
        ]);

        let scanResult;
        if (live.ok && staging.ok) {
          const comparison = await compareAndResolveTitles({
            live: live.result,
            staging: staging.result,
            auth,
            titleOptions: { fetchImpl, dnsLookup },
          });
          scanResult = {
            status: 'success',
            comparison,
            onLiveOnlyGrouped: groupBySourceType(comparison.onLiveOnly),
            onStagingOnlyGrouped: groupBySourceType(comparison.onStagingOnly),
            // QA1 Sprint 5 audit, finding C: truncated/skipped/ambiguous
            // must render alongside results (including a zero-diff
            // "safe to push") — the comparison's own completeness
            // slice already carries all three per side; this just
            // reads all three back, not truncated alone.
            completeness: summarizeCompleteness(comparison.completeness),
            live,
            staging,
          };
        } else if (live.ok || staging.ok) {
          const okSide = live.ok ? live : staging;
          const rawSideLabel = live.ok ? 'live' : 'staging';
          scanResult = {
            status: 'partial',
            rawGrouped: groupBySourceType(buildRawSideItems(okSide.result)),
            rawSideLabel,
            completeness: summarizeCompleteness({ [rawSideLabel]: okSide.result }),
            live,
            staging,
          };
        } else {
          scanResult = { status: 'failed', live, staging };
        }

        res.render('scan/show', {
          project,
          scanResult,
          alreadyRunning: false,
          manualLiveSitemapUrl,
          manualStagingSitemapUrl,
        });
      } finally {
        scansInProgress.delete(project.id);
      }
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { createScanRouter };

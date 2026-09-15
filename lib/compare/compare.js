'use strict';

const { normalizeUrlForComparison } = require('./normalize');

/**
 * Compares a live and staging sitemap result (each the exact shape
 * discoverAndParseSitemap() returns — see lib/sitemap/index.js) and
 * classifies every URL into exactly three groups (requirement 4):
 *
 *   - onLiveOnly:    on live but not staging — the RISK case, content a
 *     staging push would destroy.
 *   - onStagingOnly: on staging but not live — informational, usually
 *     the dev work about to ship.
 *   - onBothCount:   counted but never displayed (requirement 4 is
 *     explicit that the "on both" set is not surfaced as a list — only
 *     its size is useful, as a sanity check that the diff isn't
 *     comparing two unrelated sites).
 *
 * Pure and synchronous — no HTTP, no I/O of any kind (requirement 1).
 * Every URL from both sides is reduced to a comparison key via
 * normalizeUrlForComparison() before matching; nothing here inspects a
 * host, so an arbitrary staging domain compares correctly with zero
 * configuration (requirement 3).
 *
 * Each returned item carries `sourceType` straight through from the
 * sitemap result's own per-URL tagging (requirement 5) — this module
 * never re-derives page vs post from the URL itself, only passes along
 * what lib/sitemap already determined.
 *
 * `completeness` carries the truncated/ambiguous/skipped signals from
 * BOTH sides through unchanged (requirement 10), plus a single combined
 * `truncated` flag (true if EITHER side was truncated) so a caller that
 * only wants the one-bit answer — "might this diff be incomplete?" —
 * doesn't have to inspect both sides itself. A truncated side must never
 * be silently dropped in favor of presenting a clean, complete-looking
 * result — that is the whole point of this field existing.
 *
 * @param {object} options
 * @param {{urls: Array<{loc: string, lastmod?: string, sourceType?: string}>, truncated: boolean, ambiguous: object[], skipped: object[]}} options.live
 * @param {{urls: Array<{loc: string, lastmod?: string, sourceType?: string}>, truncated: boolean, ambiguous: object[], skipped: object[]}} options.staging
 * @returns {{
 *   onLiveOnly: Array<{key: string, url: string, sourceType?: string, lastmod?: string}>,
 *   onStagingOnly: Array<{key: string, url: string, sourceType?: string, lastmod?: string}>,
 *   onBothCount: number,
 *   truncated: boolean,
 *   completeness: {
 *     live: {truncated: boolean, ambiguous: object[], skipped: object[]},
 *     staging: {truncated: boolean, ambiguous: object[], skipped: object[]},
 *   },
 * }}
 */
function compareSitemaps({ live, staging }) {
  const liveByKey = indexByComparisonKey(live.urls);
  const stagingByKey = indexByComparisonKey(staging.urls);

  const onLiveOnly = [];
  const onStagingOnly = [];
  let onBothCount = 0;

  for (const [key, entry] of liveByKey) {
    if (stagingByKey.has(key)) {
      onBothCount += 1;
    } else {
      onLiveOnly.push(toItem(key, entry));
    }
  }

  for (const [key, entry] of stagingByKey) {
    if (!liveByKey.has(key)) {
      onStagingOnly.push(toItem(key, entry));
    }
  }

  return {
    onLiveOnly,
    onStagingOnly,
    onBothCount,
    truncated: Boolean(live.truncated) || Boolean(staging.truncated),
    completeness: {
      live: {
        truncated: Boolean(live.truncated),
        ambiguous: live.ambiguous || [],
        skipped: live.skipped || [],
      },
      staging: {
        truncated: Boolean(staging.truncated),
        ambiguous: staging.ambiguous || [],
        skipped: staging.skipped || [],
      },
    },
  };
}

/** Last entry wins on a same-side key collision — consistent with
 * lib/sitemap's own first-write-wins-on-loc dedup; a same-side collision
 * here means two different absolute URLs normalized to the same key,
 * which is data-shape noise this module doesn't need to referee. */
function indexByComparisonKey(urls) {
  const byKey = new Map();
  for (const entry of urls) {
    byKey.set(normalizeUrlForComparison(entry.loc), entry);
  }
  return byKey;
}

function toItem(key, entry) {
  return {
    key,
    url: entry.loc,
    sourceType: entry.sourceType,
    lastmod: entry.lastmod,
  };
}

module.exports = { compareSitemaps };

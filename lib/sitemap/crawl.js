'use strict';

const { parseSitemapXml } = require('./xml');
const { classifyChildSitemap } = require('./classify');

/**
 * Recursively resolves a set of root sitemap documents (already
 * fetched+parsed by discovery.js) into the full set of page/post URLs.
 *
 * Guards against every failure mode called out in requirements 4, 6, and
 * 8: a visited-set keyed on the normalized absolute URL stops cycles
 * (direct or through a chain) dead regardless of nesting depth; a
 * generous safety-valve depth catches a pathological non-cyclic chain
 * without being a real feature limit (see constants.js); a hard cap on
 * children fetched plus an overall time budget make a 2,057-child index
 * degrade honestly (truncated: true, whatever was gathered so far) rather
 * than hang or silently return a short list.
 *
 * A fetch or parse failure on a NON-root sitemap is recorded in
 * `skipped` and the crawl continues — one broken child sitemap should
 * not take down the whole scan when other children are still good data.
 * A failure on a root document is the caller's problem (discovery.js
 * validates roots before handing them here; a manual URL's failure
 * propagates directly since there is no fallback for it).
 */
async function crawlSitemapTree(roots, ctx) {
  await Promise.all(roots.map((root) => visitSitemap({ url: root.url, depth: 0, ctx, preParsedDoc: root.parsedDoc })));
}

async function visitSitemap({ url, depth, ctx, preParsedDoc }) {
  let normalized;
  try {
    normalized = new URL(url).href;
  } catch {
    ctx.skipped.push({ url, reason: 'invalid-url' });
    return;
  }

  if (ctx.visited.has(normalized)) return; // cycle, direct or through a chain
  ctx.visited.add(normalized);

  if (depth > ctx.maxSafetyDepth) {
    ctx.skipped.push({ url, reason: 'max-depth-exceeded' });
    return;
  }
  if (Date.now() - ctx.startedAt > ctx.budgetMs) {
    ctx.truncated = true;
    return;
  }
  if (ctx.fetchedCount >= ctx.maxChildren) {
    ctx.truncated = true;
    return;
  }
  ctx.fetchedCount += 1;

  let parsedDoc = preParsedDoc;
  if (!parsedDoc) {
    let res;
    try {
      res = await ctx.limit(() => ctx.guardedFetch(url));
    } catch (err) {
      ctx.skipped.push({ url, reason: `fetch-failed:${err.code || 'UNKNOWN'}` });
      return;
    }
    try {
      parsedDoc = parseSitemapXml(res.body, { contentType: res.contentType, sourceUrl: url });
    } catch (err) {
      ctx.skipped.push({ url, reason: `parse-failed:${err.code || 'UNKNOWN'}` });
      return;
    }
  }

  ctx.consulted.push(url);

  if (parsedDoc.type === 'index') {
    await Promise.all(
      parsedDoc.entries.map(async (childLoc) => {
        let absoluteChild;
        try {
          absoluteChild = new URL(childLoc, url).href;
        } catch {
          ctx.skipped.push({ url: childLoc, reason: 'invalid-url' });
          return;
        }

        const classification = classifyChildSitemap(absoluteChild);
        if (classification === 'exclude') {
          ctx.skipped.push({ url: absoluteChild, reason: 'excluded-content-type' });
          return;
        }
        if (classification === 'ambiguous') {
          ctx.ambiguous.push({ url: absoluteChild, reason: 'unrecognized-naming-convention' });
        }
        await visitSitemap({ url: absoluteChild, depth: depth + 1, ctx });
      })
    );
  } else {
    for (const entry of parsedDoc.entries) {
      if (!ctx.urls.has(entry.loc)) {
        ctx.urls.set(entry.loc, entry);
      }
    }
  }
}

module.exports = { crawlSitemapTree };

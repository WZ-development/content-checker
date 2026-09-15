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
 * CHILD sitemaps fetched plus an overall time budget make a 2,057-child
 * index degrade honestly (truncated: true, whatever was gathered so far
 * recorded in full — see below) rather than hang or silently return a
 * short list.
 *
 * Root documents (preParsedDoc set — discovery.js already fetched and
 * validated them) never count against the child cap: a cap of "1 child
 * sitemap" must still fetch one actual child, not zero (QA1 round 1,
 * finding B). The cap/budget check and the fetchedCount increment
 * therefore live inside the `!parsedDoc` branch, never outside it.
 *
 * The overall budget is enforced two ways, deliberately redundant: an
 * admission-time check here catches the common case cheaply, and
 * ctx.guardedFetch additionally observes a budget-wide AbortSignal (see
 * index.js/httpClient.js) so a sitemap already admitted — or sitting
 * behind the concurrency limiter — is still cut off the moment the
 * budget expires, not just at the instant it was admitted (QA1 round 1,
 * finding A: every sibling of a flat index is admitted in the same
 * tick, so admission-time-only checking never trips for that shape).
 *
 * A truncated or failed child is ALWAYS recorded in `skipped` — never
 * silently dropped — and an 'ambiguous' classification is only recorded
 * once the child has actually been consulted (fetched and parsed), never
 * up front, so a child that was classified ambiguous and then truncated
 * cannot appear in `ambiguous` ("included, check it") when it was never
 * fetched at all (QA1 round 1, finding C).
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

function isBudgetExceeded(ctx) {
  return Date.now() - ctx.startedAt > ctx.budgetMs;
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

  let parsedDoc = preParsedDoc;
  if (!parsedDoc) {
    // Admission-time checks — cheap early exit, and what records the
    // truncation when a sitemap is never even queued.
    if (isBudgetExceeded(ctx)) {
      ctx.truncated = true;
      ctx.skipped.push({ url, reason: 'truncated:budget' });
      return;
    }
    if (ctx.fetchedCount >= ctx.maxChildren) {
      ctx.truncated = true;
      ctx.skipped.push({ url, reason: 'truncated:cap' });
      return;
    }
    ctx.fetchedCount += 1;

    let res;
    try {
      res = await ctx.limit(() => ctx.guardedFetch(url));
    } catch (err) {
      if (err.code === 'BUDGET_EXCEEDED') {
        // Admitted, then cut off mid-flight (or while queued) once the
        // shared budget signal fired — still a truncation, not a
        // generic fetch failure, and still recorded either way.
        ctx.truncated = true;
        ctx.skipped.push({ url, reason: 'truncated:budget' });
        return;
      }
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

        await visitSitemap({ url: absoluteChild, depth: depth + 1, ctx });

        // Only flag 'ambiguous' once we know the child was actually
        // consulted — a child that was admitted, classified ambiguous,
        // and then truncated or failed must show up in `skipped`, not
        // in `ambiguous` implying it was included.
        if (classification === 'ambiguous' && ctx.consulted.includes(absoluteChild)) {
          ctx.ambiguous.push({ url: absoluteChild, reason: 'unrecognized-naming-convention' });
        }
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

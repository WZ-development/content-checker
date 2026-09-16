'use strict';

const { parseSitemapXml } = require('./xml');
const { classifyChildSitemap, classifySitemapContentType } = require('./classify');

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
 *
 * Sprint 4, requirement 5: each collected URL entry carries a
 * `sourceType` ('page' | 'post' | undefined) inherited from whichever
 * enclosing sitemap's filename named it, threaded down through
 * `visitSitemap`'s recursion — see classifySitemapContentType() and its
 * call site below. Sprint 4's comparison module uses this to group
 * results without re-deriving it from the URL itself.
 *
 * Sprint 5 audit fix (finding A): a urlset entry's <loc> is never
 * fetched during the crawl (only child sitemaps are), so it never
 * passed through httpClient.js's protocol check — a javascript:/data:
 * loc from a compromised site would sail straight into `urls` and, from
 * there, an authenticated <a href>. isHttpOrHttpsUrl() below rejects
 * anything else at the one place both the crawl and every downstream
 * consumer share, recording the drop in `skipped` (reason
 * 'invalid-url-scheme') rather than silently discarding it — this
 * module's own standing rule for every other kind of drop.
 */
async function crawlSitemapTree(roots, ctx) {
  await Promise.all(
    roots.map((root) => visitSitemap({ url: root.url, depth: 0, ctx, preParsedDoc: root.parsedDoc }))
  );
}

function isBudgetExceeded(ctx) {
  return Date.now() - ctx.startedAt > ctx.budgetMs;
}

async function visitSitemap({ url, depth, ctx, preParsedDoc, sourceType }) {
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

        // Sprint 4, requirement 5: tag this branch with the page/post
        // type named by ITS OWN filename when recognizable, falling back
        // to whatever type the parent was tagged with (deeper nesting —
        // e.g. wp-sitemap-posts.xml -> wp-sitemap-posts-post-1.xml —
        // should inherit rather than lose the signal at a level whose
        // own name happens not to repeat it). An 'ambiguous' child with
        // no recognizable type of its own correctly inherits undefined
        // from an untyped root, producing an unclassified (not
        // mis-classified) leaf entry.
        const childSourceType = classifySitemapContentType(absoluteChild) ?? sourceType;

        await visitSitemap({ url: absoluteChild, depth: depth + 1, ctx, sourceType: childSourceType });

        // Only flag 'ambiguous' once we know the child was actually
        // consulted — a child that was admitted, classified ambiguous,
        // and then truncated or failed must show up in `skipped`, not
        // in `ambiguous` implying it was included.
        //
        // Sprint 4 carry-forward fix (J, QA1's Sprint 3 audit): this
        // runs once per PARENT that references the child, not once per
        // child — the visited-set in visitSitemap only stops it being
        // FETCHED twice, it does nothing here. Two parents referencing
        // the same ambiguous child (a real shape: a paginated index
        // re-listing an unrecognized sitemap, or a site with more than
        // one index) pushed it into `ambiguous` twice. ambiguousRecorded
        // makes this the one place that record can be added, ever.
        if (
          classification === 'ambiguous' &&
          ctx.consulted.includes(absoluteChild) &&
          !ctx.ambiguousRecorded.has(absoluteChild)
        ) {
          ctx.ambiguousRecorded.add(absoluteChild);
          ctx.ambiguous.push({ url: absoluteChild, reason: 'unrecognized-naming-convention' });
        }
      })
    );
  } else {
    for (const entry of parsedDoc.entries) {
      // QA1's Sprint 5 audit, finding A: a <loc> is untrusted input —
      // this tool exists to point at sites, and a compromised one can
      // put anything in its sitemap. A javascript:/data:/vbscript: loc
      // survived all the way to an authenticated <a href> because
      // nothing between XML parsing and URL collection ever checked
      // its scheme (the fetch layer does check, for the child-sitemap
      // case, via httpClient.js's UNSUPPORTED_PROTOCOL — but a urlset
      // entry is never fetched during the crawl itself, only rendered
      // later, so that check never ran for this class of value). Reject
      // here, at collection, the one place both the crawl AND every
      // downstream consumer (title fetching, the results view) share —
      // fixing it upstream protects all of them at once rather than
      // requiring each to remember its own check.
      if (!isHttpOrHttpsUrl(entry.loc)) {
        ctx.skipped.push({ url: entry.loc, reason: 'invalid-url-scheme' });
        continue;
      }
      if (!ctx.urls.has(entry.loc)) {
        // sourceType: undefined for a root urlset with no enclosing
        // index (nothing named it page or post) — an explicit unknown,
        // never a guess. See requirement 5.
        ctx.urls.set(entry.loc, { ...entry, sourceType });
      }
    }
  }
}

function isHttpOrHttpsUrl(rawUrl) {
  try {
    const protocol = new URL(rawUrl).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

module.exports = { crawlSitemapTree };

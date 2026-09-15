'use strict';

const { XMLParser, XMLValidator } = require('fast-xml-parser');
const { NonXmlResponseError, MalformedXmlError } = require('./errors');

const parser = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true, // 'image:loc' -> 'loc', 'xhtml:link' -> 'link' (requirement 12)
  ignoreDeclaration: true, // strip <?xml version="1.0"?>
  ignorePiTags: true, // strip <?xml-stylesheet ...?> (requirement 12)
  trimValues: true,
});

/**
 * Parses a sitemap XML document — either a <sitemapindex> or a <urlset> —
 * into a normalized shape:
 *   { type: 'index', entries: [childUrl, ...] }
 *   { type: 'urlset', entries: [{ loc, lastmod }, ...] }
 *
 * Throws NonXmlResponseError when the body plainly isn't XML at all (an
 * HTML error page, plain text, an empty body) and MalformedXmlError when
 * it looks like XML but fails to parse, or parses but has neither a
 * recognized root element — two distinguishable failure modes per
 * requirement 11, so callers don't have to guess from a generic message.
 *
 * `contentType`, when supplied, is used ONLY as a tiebreaker for a body
 * that fails to validate as XML at all — never as a veto on a body that
 * DOES parse. QA1 caught an earlier version of this function where a
 * content-type check ran ahead of the body check and threw
 * NonXmlResponseError on a perfectly valid <urlset> merely because a
 * server sent a misconfigured `text/html` header — dropping a good
 * sitemap is exactly the under-collection direction this project treats
 * as its highest-severity risk. The body's actual shape decides whenever
 * it can; content-type only helps classify a body that already failed.
 */
function parseSitemapXml(xmlText, { contentType, sourceUrl } = {}) {
  const raw = String(xmlText || '');
  const withoutBom = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw; // strip a leading BOM, seen from some servers
  const trimmed = withoutBom.trim();

  const looksLikeHtml = /^<!doctype html/i.test(trimmed) || /^<html[\s>]/i.test(trimmed);
  const contentTypeSaysHtml = Boolean(contentType) && /html/i.test(contentType);

  if (trimmed === '' || !trimmed.startsWith('<') || looksLikeHtml) {
    throw new NonXmlResponseError(sourceUrl, contentType, trimmed.slice(0, 120));
  }

  const validation = XMLValidator.validate(trimmed, { allowBooleanAttributes: true });
  if (validation !== true) {
    // The body doesn't parse. If the server ALSO claims an HTML
    // content-type, this is far more likely a mislabeled or truncated
    // HTML error page than a broken sitemap — report it as non-XML
    // rather than malformed XML so the caller gets the more accurate
    // typed failure. This is the only place contentType influences the
    // outcome, and only because the body already failed on its own.
    if (contentTypeSaysHtml) {
      throw new NonXmlResponseError(sourceUrl, contentType, trimmed.slice(0, 120));
    }
    throw new MalformedXmlError(sourceUrl, validation.err && new Error(validation.err.msg));
  }

  let doc;
  try {
    doc = parser.parse(trimmed);
  } catch (cause) {
    throw new MalformedXmlError(sourceUrl, cause);
  }

  // Note: an element with no children (e.g. an empty <urlset></urlset>)
  // parses to '' rather than an object, so these must check presence
  // ('in') rather than truthiness — a falsy-but-present root is still a
  // valid, empty document, not a missing one.
  if ('sitemapindex' in doc) {
    const rawEntries = ensureArray(doc.sitemapindex && doc.sitemapindex.sitemap);
    const entries = rawEntries.map((entry) => readLoc(entry)).filter(Boolean);
    return { type: 'index', entries };
  }

  if ('urlset' in doc) {
    const rawEntries = ensureArray(doc.urlset && doc.urlset.url);
    const entries = rawEntries
      .map((entry) => ({ loc: readLoc(entry), lastmod: readLastmod(entry) }))
      .filter((entry) => Boolean(entry.loc));
    return { type: 'urlset', entries };
  }

  // Well-formed XML, but not a sitemap document we recognize.
  throw new NonXmlResponseError(sourceUrl, contentType, 'unrecognized XML root element');
}

function readLoc(entry) {
  if (typeof entry === 'string') return entry.trim();
  if (entry && typeof entry.loc === 'string') return entry.loc.trim();
  return undefined;
}

function readLastmod(entry) {
  if (entry && typeof entry.lastmod === 'string') return entry.lastmod.trim();
  return undefined;
}

function ensureArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

module.exports = { parseSitemapXml };

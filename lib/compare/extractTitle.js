'use strict';

const TITLE_TAG_RE = /<title[^>]*>([\s\S]*?)<\/title>/i;

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/**
 * Extracts and decodes the `<title>` text from an HTML document, for
 * requirement 6. Returns undefined when there is no `<title>` element at
 * all (an HTML page with none, or a body that isn't really HTML despite
 * a permissive content-type) — that's one more fallback-to-slug trigger,
 * alongside the fetch/timeout/non-HTML/cap cases requirement 8 names
 * explicitly: a page genuinely can be fetched fine and still have no
 * usable title.
 *
 * A small hand-rolled entity decoder, not a full HTML parser — the only
 * job here is pulling text out of one known tag, which doesn't need a
 * DOM, and this avoids adding an HTML-parsing dependency for it.
 */
function extractTitleFromHtml(html) {
  const match = TITLE_TAG_RE.exec(String(html || ''));
  if (!match) return undefined;

  const decoded = decodeHtmlEntities(match[1]).replace(/\s+/g, ' ').trim();
  return decoded === '' ? undefined : decoded;
}

function decodeHtmlEntities(text) {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, entity) => {
    if (entity[0] === '#') {
      const isHex = entity[1] === 'x' || entity[1] === 'X';
      const codePoint = Number.parseInt(entity.slice(isHex ? 2 : 1), isHex ? 16 : 10);
      return Number.isFinite(codePoint) ? safeFromCodePoint(codePoint) : whole;
    }
    const lower = entity.toLowerCase();
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, lower) ? NAMED_ENTITIES[lower] : whole;
  });
}

function safeFromCodePoint(codePoint) {
  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return '';
  }
}

module.exports = { extractTitleFromHtml };

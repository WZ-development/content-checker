'use strict';

/**
 * Extracts every `Sitemap:` directive from a robots.txt body (requirement
 * 2a — discovery tries robots.txt first and uses *every* directive it
 * declares, not just the first). Case-insensitive per the robots.txt
 * convention, comments (`#...`) are stripped, and relative values are
 * resolved against baseUrl. Invalid URLs are silently skipped rather than
 * throwing — a malformed line in robots.txt shouldn't take down
 * discovery when other lines are usable.
 */
function parseRobotsTxtForSitemaps(text, baseUrl) {
  const urls = [];
  const lines = String(text || '').split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.split('#')[0].trim();
    const match = /^sitemap\s*:\s*(.+)$/i.exec(line);
    if (!match) continue;

    const value = match[1].trim();
    if (!value) continue;

    try {
      urls.push(new URL(value, baseUrl).href);
    } catch {
      // Malformed URL in robots.txt — skip it, don't fail discovery.
    }
  }

  return urls;
}

module.exports = { parseRobotsTxtForSitemaps };

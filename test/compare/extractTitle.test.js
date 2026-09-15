'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { extractTitleFromHtml } = require('../../lib/compare/extractTitle');

describe('extractTitleFromHtml', () => {
  test('extracts a plain title', () => {
    assert.equal(extractTitleFromHtml('<html><head><title>Hello World</title></head></html>'), 'Hello World');
  });

  test('is case-insensitive on the tag name', () => {
    assert.equal(extractTitleFromHtml('<TITLE>Shouty</TITLE>'), 'Shouty');
  });

  test('decodes common named entities', () => {
    assert.equal(extractTitleFromHtml('<title>Tom &amp; Jerry &lt;3&gt;</title>'), 'Tom & Jerry <3>');
  });

  test('decodes decimal and hex numeric entities', () => {
    assert.equal(extractTitleFromHtml('<title>Caf&#233; &#x2764;</title>'), 'Café ❤');
  });

  test('collapses internal whitespace/newlines and trims', () => {
    assert.equal(extractTitleFromHtml('<title>\n  Spread   Out  \n</title>'), 'Spread Out');
  });

  test('returns undefined when there is no title tag at all', () => {
    assert.equal(extractTitleFromHtml('<html><body>no title here</body></html>'), undefined);
  });

  test('returns undefined for a title that is empty or whitespace only', () => {
    assert.equal(extractTitleFromHtml('<title></title>'), undefined);
    assert.equal(extractTitleFromHtml('<title>   </title>'), undefined);
  });

  test('does not throw on garbage input', () => {
    assert.doesNotThrow(() => extractTitleFromHtml(undefined));
    assert.doesNotThrow(() => extractTitleFromHtml(''));
  });
});

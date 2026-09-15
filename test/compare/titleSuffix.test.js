'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { stripTitleSuffix } = require('../../lib/compare/titleSuffix');

describe('stripTitleSuffix (requirement 6)', () => {
  test('strips a " - Site Name" suffix', () => {
    assert.equal(stripTitleSuffix('Q3 Earnings Report - Acme Inc'), 'Q3 Earnings Report');
  });

  test('strips a " | Site Name" suffix', () => {
    assert.equal(stripTitleSuffix('Q3 Earnings Report | Acme Inc'), 'Q3 Earnings Report');
  });

  test('a title with no separator is returned unchanged', () => {
    assert.equal(stripTitleSuffix('Just A Plain Title'), 'Just A Plain Title');
  });

  describe('does not mangle a title that legitimately contains those characters mid-sentence', () => {
    test('a hyphen with no surrounding spaces (a compound word) is left alone', () => {
      assert.equal(stripTitleSuffix('Co-op Grocery Guide'), 'Co-op Grocery Guide');
      assert.equal(stripTitleSuffix('A Well-Known Recipe'), 'A Well-Known Recipe');
    });

    test('a separator appearing more than once is ambiguous and left untouched entirely', () => {
      assert.equal(
        stripTitleSuffix('Some Title - With - Multiple Dashes'),
        'Some Title - With - Multiple Dashes'
      );
      assert.equal(
        stripTitleSuffix('A | B | C'),
        'A | B | C'
      );
    });
  });

  test('trims incidental whitespace left after stripping', () => {
    assert.equal(stripTitleSuffix('Page Title   - Site Name'), 'Page Title');
  });

  test('non-string input passes through unchanged rather than throwing', () => {
    assert.doesNotThrow(() => stripTitleSuffix(undefined));
  });
});

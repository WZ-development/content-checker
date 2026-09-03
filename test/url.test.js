'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { createUrlHelper } = require('../src/lib/url');
const { normalizeBasePath } = require('../src/config');

describe('normalizeBasePath', () => {
  test('root default "/" normalizes to empty string', () => {
    assert.equal(normalizeBasePath('/'), '');
  });

  test('undefined normalizes to empty string (same as root)', () => {
    assert.equal(normalizeBasePath(undefined), '');
  });

  test('adds a leading slash when missing', () => {
    assert.equal(normalizeBasePath('content-check'), '/content-check');
  });

  test('strips a trailing slash', () => {
    assert.equal(normalizeBasePath('/content-check/'), '/content-check');
  });

  test('leaves a well-formed base path untouched', () => {
    assert.equal(normalizeBasePath('/content-check'), '/content-check');
  });
});

describe('createUrlHelper', () => {
  test('at root base path, passes paths through unchanged', () => {
    const url = createUrlHelper('');
    assert.equal(url('/login'), '/login');
    assert.equal(url('/'), '/');
  });

  test('at root base path via "/", passes paths through unchanged', () => {
    const url = createUrlHelper('/');
    assert.equal(url('/login'), '/login');
  });

  test('prefixes every path with a configured base path', () => {
    const url = createUrlHelper('/content-check');
    assert.equal(url('/login'), '/content-check/login');
    assert.equal(url('/'), '/content-check/');
    assert.equal(url('/style.css'), '/content-check/style.css');
  });

  test('adds a leading slash to a path that is missing one', () => {
    const url = createUrlHelper('/content-check');
    assert.equal(url('login'), '/content-check/login');
  });

  test('defaults to "/" when called with no argument', () => {
    const url = createUrlHelper('/content-check');
    assert.equal(url(), '/content-check/');
  });

  test('does not produce a double slash for a trailing-slash base path', () => {
    // createUrlHelper normalizes internally even if given an
    // un-normalized base path.
    const url = createUrlHelper('/content-check/');
    assert.equal(url('/login'), '/content-check/login');
  });
});

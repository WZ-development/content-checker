'use strict';

/**
 * A minimal concurrency limiter — no dependency pulled in for something
 * this small. createLimiter(5) returns a `limit(fn)` function; calling it
 * queues `fn` and runs at most 5 queued functions at once, in submission
 * order once a slot frees up.
 *
 * Used to bound in-flight sitemap fetches app-wide (requirement 9),
 * regardless of how the recursive crawl fans out across sitemap-index
 * branches.
 */
function createLimiter(concurrency) {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new TypeError(`concurrency must be a positive integer, got ${concurrency}`);
  }

  let active = 0;
  const queue = [];

  function runNext() {
    if (active >= concurrency || queue.length === 0) return;
    active += 1;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve()
      .then(fn)
      .then(resolve, reject)
      .finally(() => {
        active -= 1;
        runNext();
      });
  }

  return function limit(fn) {
    return new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      runNext();
    });
  };
}

module.exports = { createLimiter };

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const FIXTURE_DIR = path.join(__dirname, '..', 'fixtures', 'sitemap');

function loadFixture(name) {
  return fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8');
}

/**
 * Builds a fake `fetch`-compatible function driven entirely by an
 * in-memory route table — no live network call is possible, satisfying
 * requirement 13 ("tests run against fixture files, not the live
 * internet"). Every call is recorded in `.log` (url + headers actually
 * sent) so tests can assert on request sequence and outbound headers
 * (e.g. that Authorization is present on child requests, not only the
 * first).
 *
 * routes: { [url]: { status, headers, body, delayMs } }
 *   - status defaults to 200.
 *   - headers is a plain object; `location` drives redirects.
 *   - body is a string (fixture content).
 *   - delayMs, if set, delays the response — used to test per-request
 *     timeouts and the overall budget without slow real waits.
 *   - a route may also be a function(url) => descriptor, for stateful
 *     scenarios (unused currently, kept for flexibility).
 */
function createFakeFetch(routes) {
  const log = [];

  async function fakeFetch(url, init = {}) {
    log.push({ url, headers: { ...(init.headers || {}) } });

    const route = typeof routes[url] === 'function' ? routes[url](url) : routes[url];
    if (!route) {
      throw Object.assign(new Error(`fakeFetch: no route configured for ${url}`), { code: 'ENOTFOUND' });
    }

    if (route.delayMs) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, route.delayMs);
        if (init.signal) {
          init.signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          });
        }
      });
    }

    if (init.signal && init.signal.aborted) {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    }

    const status = route.status || 200;
    const headerMap = new Map(Object.entries(route.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));

    return {
      status,
      headers: {
        get: (name) => headerMap.get(String(name).toLowerCase()) || null,
      },
      text: async () => route.body || '',
    };
  }

  fakeFetch.log = log;
  return fakeFetch;
}

/**
 * Builds a fake DNS lookup keyed by hostname, so SSRF tests control
 * exactly what address a host "resolves" to without touching real DNS.
 * addressMap: { [hostname]: '1.2.3.4' | ['1.2.3.4', '::1'] }
 */
function createFakeDnsLookup(addressMap) {
  return async function fakeDnsLookup(hostname) {
    const entry = addressMap[hostname];
    if (!entry) {
      const err = new Error(`fakeDnsLookup: no entry for ${hostname}`);
      err.code = 'ENOTFOUND';
      throw err;
    }
    const addresses = Array.isArray(entry) ? entry : [entry];
    return addresses.map((address) => ({
      address,
      family: address.includes(':') ? 6 : 4,
    }));
  };
}

module.exports = { loadFixture, createFakeFetch, createFakeDnsLookup, FIXTURE_DIR };

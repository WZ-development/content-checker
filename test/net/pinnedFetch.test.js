'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { Agent, fetch: undiciFetch } = require('undici');
const {
  createPinnedFetch,
  resolveSafeAddresses,
  mergeOutboundTokenHeader,
  SSRF_BLOCKED_CODE,
  OUTBOUND_TOKEN_HEADER_NAME,
} = require('../../lib/net/pinnedFetch');

function withTestServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ port, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

describe('resolveSafeAddresses', () => {
  test('returns a literal public IP unchanged', async () => {
    const addresses = await resolveSafeAddresses('8.8.8.8', async () => {
      throw new Error('dnsLookup should not be called for a literal IP');
    });
    assert.deepEqual(addresses, [{ address: '8.8.8.8', family: 4 }]);
  });

  test('rejects a literal private IP without ever calling dnsLookup', async () => {
    let called = false;
    await assert.rejects(
      () =>
        resolveSafeAddresses('127.0.0.1', async () => {
          called = true;
        }),
      (err) => {
        assert.equal(err.code, SSRF_BLOCKED_CODE);
        return true;
      }
    );
    assert.equal(called, false);
  });

  test('filters out disallowed addresses, keeping any safe ones', async () => {
    const dnsLookup = async () => [
      { address: '127.0.0.1', family: 4 },
      { address: '93.184.216.34', family: 4 },
    ];
    const addresses = await resolveSafeAddresses('mixed.test', dnsLookup);
    assert.deepEqual(addresses, [{ address: '93.184.216.34', family: 4 }]);
  });

  test('rejects when every resolved address is disallowed', async () => {
    const dnsLookup = async () => [{ address: '10.0.0.5', family: 4 }];
    await assert.rejects(() => resolveSafeAddresses('evil.test', dnsLookup), (err) => {
      assert.equal(err.code, SSRF_BLOCKED_CODE);
      return true;
    });
  });
});

describe('createPinnedFetch', () => {
  test('returns the SAME dnsLookup reference passed in — the "one instance, injected into both consumers" wiring', () => {
    const myDnsLookup = async () => [];
    const { dnsLookup } = createPinnedFetch({ dnsLookup: myDnsLookup });
    assert.equal(dnsLookup, myDnsLookup);
  });

  test('the underlying connect.lookup + fetch mechanism preserves the original Host header', async () => {
    // createPinnedFetch is exactly this pattern (Agent with a custom
    // connect.lookup, driving undici's fetch) plus resolveSafeAddresses
    // as the lookup — tested thoroughly above and in the rebinding test
    // below. Since every real bindable local address is, correctly,
    // itself in the SSRF blocklist (that's the filter doing its job,
    // not a test inconvenience to route around), this test exercises
    // the connection MECHANISM directly with a trivial lookup, to prove
    // the Host header survives being pinned to a literal address — the
    // property createPinnedFetch depends on requirement 12's redirect/
    // auth-forwarding logic in lib/sitemap/httpClient.js (which keys off
    // the request's own URL, not the literal connection address) to
    // keep working unchanged once wired through here.
    const { port, close } = await withTestServer((req, res) => {
      res.end('host=' + req.headers.host);
    });
    try {
      const agent = new Agent({
        connect: { lookup: (hostname, options, callback) => callback(null, [{ address: '127.0.0.1', family: 4 }]) },
      });
      const res = await undiciFetch(`http://pinned-fetch-test.invalid:${port}/`, { dispatcher: agent });
      const text = await res.text();
      assert.equal(res.status, 200);
      assert.equal(text, `host=pinned-fetch-test.invalid:${port}`);
    } finally {
      await close();
    }
  });

  test('a request to a literal private address never connects', async () => {
    const { fetchImpl } = createPinnedFetch({ dnsLookup: async () => [] });
    await assert.rejects(() => fetchImpl('http://127.0.0.1:1/'));
  });

  describe('closes the time-of-check/time-of-use gap (requirement 14, the actual point)', () => {
    test('a hostname resolving safely on an EARLIER lookup but unsafely at connect-time is still blocked', async () => {
      // Simulates the gap QA1 flagged: an earlier, separate check (e.g.
      // lib/sitemap's own assertHostIsSafe, called before this fetchImpl
      // even runs) resolved and approved an address — DNS then answers
      // differently by the time the connection is actually opened. The
      // fix is that the ACTUAL connection re-validates via this same
      // lookup at connect time, not that some other check ran first.
      let callCount = 0;
      const dnsLookup = async () => {
        callCount += 1;
        if (callCount === 1) {
          return [{ address: '93.184.216.34', family: 4 }]; // "the earlier check" - looked safe
        }
        return [{ address: '169.254.169.254', family: 4 }]; // cloud metadata address - now unsafe
      };

      // Mimic an earlier pre-check consuming the first (safe) answer,
      // exactly like assertHostIsSafe does before httpClient.js calls
      // fetchImpl.
      const preCheckAddresses = await resolveSafeAddresses('rebinding.test', dnsLookup);
      assert.equal(preCheckAddresses[0].address, '93.184.216.34', 'pre-check saw the safe answer');

      // Now the actual fetch — its OWN connect-time lookup call (the
      // second call to dnsLookup) gets the now-unsafe answer, and must
      // block the connection rather than trusting the earlier check.
      const { fetchImpl } = createPinnedFetch({ dnsLookup });
      await assert.rejects(
        () => fetchImpl('http://rebinding.test/'),
        (err) => {
          // Specifically the SSRF rejection, not some unrelated
          // connection failure — proves the block came from the
          // connect-time re-validation, not an accident.
          assert.equal(err.cause && err.cause.code, SSRF_BLOCKED_CODE);
          return true;
        }
      );
      assert.equal(callCount, 2, 'expected exactly one pre-check call plus one connect-time call');
    });
  });
});

describe('mergeOutboundTokenHeader (sprint 7, requirement 1/2)', () => {
  test('adds the header under the exact exported name when a token is configured', () => {
    const headers = mergeOutboundTokenHeader({ 'User-Agent': 'TestBot/1.0' }, 'a-real-token-value');
    assert.equal(headers[OUTBOUND_TOKEN_HEADER_NAME], 'a-real-token-value');
    assert.equal(headers['User-Agent'], 'TestBot/1.0', 'existing headers must survive untouched');
  });

  test('does not mutate the headers object passed in', () => {
    const original = { 'User-Agent': 'TestBot/1.0' };
    mergeOutboundTokenHeader(original, 'a-real-token-value');
    assert.deepEqual(original, { 'User-Agent': 'TestBot/1.0' });
  });

  test('works when no base headers were supplied at all', () => {
    const headers = mergeOutboundTokenHeader(undefined, 'a-real-token-value');
    assert.equal(headers[OUTBOUND_TOKEN_HEADER_NAME], 'a-real-token-value');
  });

  test('requirement 2: omits the header entirely (returns baseHeaders unchanged) when no token is configured', () => {
    const base = { 'User-Agent': 'TestBot/1.0' };
    const headers = mergeOutboundTokenHeader(base, undefined);
    assert.equal(headers, base, 'must be the SAME object, not a copy with the header simply absent');
    assert.ok(!(OUTBOUND_TOKEN_HEADER_NAME in headers));
  });

  test('omits the header for an empty-string token too', () => {
    const headers = mergeOutboundTokenHeader({ 'User-Agent': 'TestBot/1.0' }, '');
    assert.ok(!(OUTBOUND_TOKEN_HEADER_NAME in headers));
  });
});

describe('the outbound token header reaches a real request (sprint 7, requirement 1, end to end)', () => {
  test('a request built the same way createPinnedFetch\'s fetchImpl builds one carries the header', async () => {
    // Same reasoning as the Host-header mechanism test above: every
    // real bindable local address is itself in the SSRF blocklist
    // (correctly), so this proves the wiring — mergeOutboundTokenHeader
    // (the REAL exported function, not a re-implementation) feeding
    // into undiciFetch via a trivial-lookup Agent — actually lands the
    // header on the wire, without needing to reach past the filter.
    const { port, close } = await withTestServer((req, res) => {
      res.end(String(req.headers['x-contentcheck-token']));
    });
    try {
      const agent = new Agent({
        connect: { lookup: (hostname, options, callback) => callback(null, [{ address: '127.0.0.1', family: 4 }]) },
      });
      const headers = mergeOutboundTokenHeader({ 'User-Agent': 'TestBot/1.0' }, 'the-real-token');
      const res = await undiciFetch(`http://token-test.invalid:${port}/`, { headers, dispatcher: agent });
      const text = await res.text();
      assert.equal(text, 'the-real-token');
    } finally {
      await close();
    }
  });

  test('no header reaches the server when no token is configured', async () => {
    const { port, close } = await withTestServer((req, res) => {
      res.end(JSON.stringify('x-contentcheck-token' in req.headers));
    });
    try {
      const agent = new Agent({
        connect: { lookup: (hostname, options, callback) => callback(null, [{ address: '127.0.0.1', family: 4 }]) },
      });
      const headers = mergeOutboundTokenHeader({ 'User-Agent': 'TestBot/1.0' }, undefined);
      const res = await undiciFetch(`http://token-test.invalid:${port}/`, { headers, dispatcher: agent });
      const text = await res.text();
      assert.equal(text, 'false');
    } finally {
      await close();
    }
  });
});

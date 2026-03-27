import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createPaywall } from './middleware.js';
import type { GenericRequest, GenericResponse, MppCredential } from './types.js';

function makeReq(url: string, headers: Record<string, string> = {}): GenericRequest {
  return { url, headers, method: 'GET' };
}

function makeRes(): GenericResponse & { _status: number; _headers: Record<string, string>; _body: any } {
  const r = {
    _status: 200,
    _headers: {} as Record<string, string>,
    _body: null as any,
    setHeader(k: string, v: string) { r._headers[k.toLowerCase()] = v; return r; },
    status(code: number) { r._status = code; return r; },
    json(obj: any) { r._body = obj; return r; },
  };
  return r;
}

const CONFIG = {
  amount: 0.001,
  address: 'u1testaddress',
  apiKey: 'cpay_sk_test',
  facilitatorUrl: 'http://localhost:3080',
  protocol: 'both' as const,
  description: 'Test resource',
};

describe('402 challenge', () => {
  it('returns both x402 and MPP headers when protocol=both', async () => {
    const handler = createPaywall(CONFIG);
    const req = makeReq('/api/test');
    const res = makeRes();
    await handler(req, res, () => {});

    assert.equal(res._status, 402, 'should return 402');
    assert.ok(res._headers['www-authenticate'], 'should have WWW-Authenticate header');
    assert.ok(res._headers['payment-required'], 'should have Payment-Required header');

    const wwwAuth = res._headers['www-authenticate'];
    assert.ok(wwwAuth.startsWith('Payment '), 'WWW-Authenticate should start with Payment');
    assert.ok(wwwAuth.includes('method="zcash"'), 'should include method=zcash');
    assert.ok(wwwAuth.includes('intent="charge"'), 'should include intent=charge');
    assert.ok(wwwAuth.includes('request="'), 'should include request param');

    const requestMatch = wwwAuth.match(/request="([^"]+)"/);
    assert.ok(requestMatch, 'should have request param');
    const charge = JSON.parse(Buffer.from(requestMatch![1], 'base64url').toString());
    assert.equal(String(charge.amount), '100000', 'amount should be in zatoshis');
    assert.equal(charge.currency, 'ZEC');
    assert.equal(charge.recipient, 'u1testaddress');

    assert.ok(res._body, 'should have JSON body');
    assert.equal(res._body.x402Version, 2);
    assert.equal(res._body.accepts[0].asset, 'ZEC');

    console.log('  challenge headers OK');
  });

  it('returns only x402 when protocol=x402', async () => {
    const handler = createPaywall({ ...CONFIG, protocol: 'x402' });
    const res = makeRes();
    await handler(makeReq('/api/test'), res, () => {});

    assert.equal(res._status, 402);
    assert.ok(res._headers['payment-required'], 'should have Payment-Required');
    assert.equal(res._headers['www-authenticate'], undefined, 'should NOT have WWW-Authenticate');
  });

  it('returns only MPP when protocol=mpp', async () => {
    const handler = createPaywall({ ...CONFIG, protocol: 'mpp' });
    const res = makeRes();
    await handler(makeReq('/api/test'), res, () => {});

    assert.equal(res._status, 402);
    assert.ok(res._headers['www-authenticate'], 'should have WWW-Authenticate');
    assert.equal(res._headers['payment-required'], undefined, 'should NOT have Payment-Required');
  });
});

describe('credential parsing', () => {
  it('detects MPP Authorization: Payment header', async () => {
    const fakeTxid = 'a'.repeat(64);
    const cred: MppCredential = {
      id: 'test',
      method: 'zcash',
      payload: { txid: fakeTxid },
    };
    const b64 = Buffer.from(JSON.stringify(cred)).toString('base64url');

    const handler = createPaywall({
      ...CONFIG,
      facilitatorUrl: 'http://127.0.0.1:19999',
    });
    const req = makeReq('/api/test', { Authorization: `Payment ${b64}` });
    const res = makeRes();

    // This will try to call verify and fail (no server), but the credential
    // parsing itself should work — we just catch the network error
    try {
      await handler(req, res, () => {});
    } catch {
      // expected: verification call fails
    }

    // If we got a 402, the credential wasn't parsed. If we got 500, it was
    // parsed and the verify call failed (which is correct behavior).
    assert.notEqual(res._status, 402, 'should NOT return 402 — credential was provided');
    console.log(`  MPP credential parsed, response status: ${res._status}`);
  });

  it('detects x402 PAYMENT-SIGNATURE header', async () => {
    const fakeTxid = 'b'.repeat(64);
    const payload = { payload: { txid: fakeTxid } };
    const b64 = Buffer.from(JSON.stringify(payload)).toString('base64');

    const handler = createPaywall({
      ...CONFIG,
      facilitatorUrl: 'http://127.0.0.1:19999',
    });
    const req = makeReq('/api/test', { 'PAYMENT-SIGNATURE': b64 });
    const res = makeRes();

    try {
      await handler(req, res, () => {});
    } catch {
      // expected
    }

    assert.notEqual(res._status, 402, 'should NOT return 402 — credential was provided');
    console.log(`  x402 credential parsed, response status: ${res._status}`);
  });

  it('rejects replayed txid by default', async () => {
    const fakeTxid = 'c'.repeat(64);
    const cred: MppCredential = {
      id: 'replay-test',
      method: 'zcash',
      payload: { txid: fakeTxid },
    };
    const b64 = Buffer.from(JSON.stringify(cred)).toString('base64url');

    // Mock a verify response where previously_verified = true
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({
      valid: true,
      received_zec: 0.001,
      received_zatoshis: 100000,
      previously_verified: true,
      reason: null,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });

    try {
      const handler = createPaywall(CONFIG);
      const req = makeReq('/api/test', { Authorization: `Payment ${b64}` });
      const res = makeRes();
      await handler(req, res, () => {});

      assert.equal(res._status, 402, 'replayed tx should return 402');
      assert.equal(res._body?.error, 'payment_replayed');
      console.log('  replay rejected correctly');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('allows replayed txid when rejectReplays=false', async () => {
    const fakeTxid = 'd'.repeat(64);
    const cred: MppCredential = {
      id: 'replay-allow',
      method: 'zcash',
      payload: { txid: fakeTxid },
    };
    const b64 = Buffer.from(JSON.stringify(cred)).toString('base64url');

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({
      valid: true,
      received_zec: 0.001,
      received_zatoshis: 100000,
      previously_verified: true,
      reason: null,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });

    try {
      const handler = createPaywall({ ...CONFIG, rejectReplays: false });
      const req = makeReq('/api/test', { Authorization: `Payment ${b64}` });
      const res = makeRes();
      let nextCalled = false;
      await handler(req, res, () => { nextCalled = true; });

      assert.ok(nextCalled, 'next() should be called — replay allowed');
      console.log('  replay allowed with rejectReplays=false');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('rejects malformed Authorization header gracefully', async () => {
    const handler = createPaywall(CONFIG);
    const req = makeReq('/api/test', { Authorization: 'Bearer some-jwt-token' });
    const res = makeRes();
    await handler(req, res, () => {});

    assert.equal(res._status, 402, 'Bearer token should not match — return 402');
  });
});

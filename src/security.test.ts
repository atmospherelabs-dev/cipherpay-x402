import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { createPaywall } from './middleware.js';
import { verifyPayment, verifyPaymentV2, settlePaymentV2, validateSession, prepareSession } from './client.js';
import { zecToZatoshis, zatoshisToZec, type GenericResponse, type PaymentRequirements, type PaymentPayload } from './types.js';
import { request } from './http.js';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
const txid = 'a'.repeat(64);
const config = { amount: 0.001, address: 'u1synthetic', apiKey: 'synthetic-merchant-key' };
const expected: PaymentRequirements = { scheme: 'exact', asset: 'ZEC', network: 'zcash:mainnet',
  amount: '100000', payTo: config.address, maxTimeoutSeconds: 120, extra: {} };
const payload: PaymentPayload = { x402Version: 2, accepted: expected, payload: { txid } };
const receipt = { success: true, transaction: txid, network: expected.network, amount: '100000' };
const json = (value: unknown, init?: ResponseInit) => new Response(JSON.stringify(value), init);
function response() {
  const res = { code: 200, body: undefined as any, headers: {} as Record<string, string>,
    status(code: number) { res.code = code; return res; }, json(body: unknown) { res.body = body; },
    setHeader(key: string, value: string) { res.headers[key.toLowerCase()] = value; } };
  return res satisfies GenericResponse;
}
async function pay(headers: Record<string, string>, next: () => void | Promise<void> = () => {}, extra = {}) {
  const res = response();
  await createPaywall({ ...config, ...extra })({ method: 'GET', url: '/resource', headers }, res, next);
  return res;
}
async function listen(server: Server) {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}
async function close(server: Server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }

test('exact decimal prices reject rounding, noncanonical strings and out-of-range values', () => {
  for (const [zec, zat] of [[0.00000001, '1'], [0.29, '29000000'], [0.001, '100000'], [21_000_000, '2100000000000000']] as const) {
    assert.equal(zecToZatoshis(zec), zat); assert.equal(zatoshisToZec(zat), zec);
  }
  for (const bad of [0, -1, NaN, Infinity, 1e-9, 0.1 + 0.2, 21_000_001]) assert.throws(() => zecToZatoshis(bad));
  for (const bad of ['1x', '1.0', '1e8', ' 1', '-1', '01', '2100000000000001']) assert.throws(() => zatoshisToZec(bad));
});

test('paid replies fail closed on malformed booleans, wrong receipt, network and amount', async () => {
  for (const bad of [{ ...receipt, success: 'true' }, { ...receipt, transaction: 'b'.repeat(64) },
    { ...receipt, network: 'zcash:testnet' }, { ...receipt, amount: '99999' },
    { ...receipt, replayed: 'false' }, { success: true }, null]) {
    globalThis.fetch = async () => json(bad);
    let calls = 0;
    const res = await pay({ 'x-payment': txid }, () => { calls++; });
    assert.equal(calls, 0); assert.equal(res.code, 503);
  }
  for (const bad of [{ valid: 'true' }, { valid: true, previously_verified: false, received_zatoshis: 1, received_zec: 1e-8 }]) {
    globalThis.fetch = async () => json(bad);
    await assert.rejects(verifyPayment(txid, .001, config.apiKey));
  }
  globalThis.fetch = async () => json({ isValid: 'false' });
  await assert.rejects(verifyPaymentV2(payload, expected, config.apiKey));
});

test('body and header replay signals each deny repeat fulfillment even with rejectReplays=false', async () => {
  for (const mode of ['body', 'header', 'conflict']) {
    globalThis.fetch = async () => mode === 'conflict' ? new Response(null, { status: 409 }) :
      json({ ...receipt, ...(mode === 'body' ? { replayed: true } : {}) },
        mode === 'header' ? { headers: { 'Idempotency-Replayed': 'true' } } : undefined);
    let calls = 0;
    const res = await pay({ 'x-payment': txid }, () => { calls++; }, { rejectReplays: false });
    assert.equal(calls, 0); assert.equal(res.code, 402); assert.match(res.body.type, /payment-replayed$/);
  }
});

test('session replies require real booleans and safe integer balances', async () => {
  for (const bad of [{ valid: 'true' }, { valid: true }, { valid: true, session_id: 's', balance_remaining: -1, requests_made: 1 },
    { valid: true, session_id: 's', balance_remaining: 1.5, requests_made: 1 },
    { valid: true, session_id: 's', balance_remaining: 1, requests_made: 1 },
    { valid: true, session_id: 's', balance_remaining: 1, requests_made: 1, deducted: 1 }]) {
    globalThis.fetch = async () => json(bad);
    let calls = 0;
    const res = await pay({ authorization: 'Bearer cps_synthetic' }, () => { calls++; });
    assert.equal(calls, 0); assert.equal(res.code, 503);
  }
});

test('mounted resources retain original URL, merchant key, price and unique session charge IDs', async () => {
  const bodies: any[] = [];
  globalThis.fetch = async (url, init) => {
    assert.match(String(url), /\/api\/sessions\/validate$/); assert.equal(init?.method, 'POST');
    assert.equal((init?.headers as Record<string,string>).Authorization, `Bearer ${config.apiKey}`);
    bodies.push(JSON.parse(String(init?.body)));
    return json({ valid: true, session_id: 'synthetic-session', balance_remaining: 100000, requests_made: bodies.length, deducted: 100000 });
  };
  let calls = 0;
  for (let i = 0; i < 2; i++) await createPaywall(config)({ method: 'GET', url: '/item', originalUrl: '/premium/item?size=2',
    headers: { authorization: 'Bearer cps_synthetic' } }, response(), () => { calls++; });
  assert.equal(calls, 2); assert.equal(bodies[0].resource, '/premium/item?size=2');
  assert.equal(bodies[0].amount_zatoshis, 100000); assert.equal(bodies[0].token, 'cps_synthetic');
  assert.notEqual(bodies[0].request_id, bodies[1].request_id);
});

test('session prepare and deduction reject missing authentication before network access', async () => {
  let fetched = false; globalThis.fetch = async () => { fetched = true; throw new Error('unreachable'); };
  await assert.rejects(prepareSession('merchant'), /API key/);
  await assert.rejects(validateSession('cps_synthetic', config.apiKey), /integer price/);
  assert.equal(fetched, false);
});

test('downstream handler failures propagate once without payment error disclosure', async () => {
  for (const session of [false, true]) {
    globalThis.fetch = async () => json(session ? { valid: true, session_id: 's', balance_remaining: 0, requests_made: 1, deducted: 100000 } : receipt);
    const secret = new Error('internal application detail'); let calls = 0;
    await assert.rejects(pay(session ? { authorization: 'Bearer cps_synthetic' } : { 'x-payment': txid },
      () => { calls++; throw secret; }), error => error === secret);
    assert.equal(calls, 1);
  }
});

test('oversized and unsupported-version credentials do not reach the facilitator', async () => {
  let calls = 0; globalThis.fetch = async () => { calls++; return json(receipt); };
  for (const version of [undefined, 1, 3]) {
    const signature = Buffer.from(JSON.stringify({ x402Version: version, payload: { txid } })).toString('base64');
    const res = await pay({ 'payment-signature': signature }); assert.equal(res.code, 402);
  }
  assert.equal((await pay({ 'payment-signature': 'a'.repeat(20000) })).code, 402); assert.equal(calls, 0);
});

test('transport forbids credential redirects and redacts upstream errors', async () => {
  let leaked = 0;
  const target = createServer((_req, res) => { leaked++; res.end('{}'); }); const targetUrl = await listen(target);
  const redirect = createServer((_req, res) => { res.writeHead(307, { location: targetUrl }); res.end(); }); const base = await listen(redirect);
  try {
    await assert.rejects(verifyPayment(txid, .001, config.apiKey, base), /unavailable/); assert.equal(leaked, 0);
  } finally { await close(redirect); await close(target); }
  globalThis.fetch = async () => new Response(`private upstream key ${config.apiKey}`, { status: 500 });
  const res = await pay({ 'x-payment': txid });
  assert.equal(res.code, 503); assert.ok(!JSON.stringify(res.body).includes(config.apiKey));
  await assert.rejects(verifyPayment(txid, .001, config.apiKey), error => !String(error).includes(config.apiKey));
  for (const base of ['http://example.com', 'https://user:pass@example.com', 'https://example.com?key=x']) {
    await assert.rejects(verifyPayment(txid, .001, config.apiKey, base));
  }
});

test('transport bounds streamed bodies and applies deadline through body reading', async () => {
  globalThis.fetch = async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(1_048_577)); controller.close(); } }));
  await assert.rejects(verifyPayment(txid, .001, config.apiKey), /invalid response/);
  globalThis.fetch = realFetch;
  const server = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{'); });
  const base = await listen(server);
  try { await assert.rejects(request(base, '/slow', 50), /timed out/); } finally { await close(server); }
});

test('concurrent payment attempts fulfill once using atomic facilitator settlement', async () => {
  let consumed = false; let verifies = 0; let settles = 0;
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    assert.equal(req.headers.authorization, `Bearer ${config.apiKey}`);
    if (req.url?.endsWith('/verify')) verifies++;
    if (req.url?.endsWith('/settle')) settles++;
    assert.equal(body.paymentRequirements.amount, '100000');
    assert.equal(body.paymentPayload.payload.txid, txid);
    const replay = consumed; consumed = true;
    res.writeHead(replay ? 409 : 200, { 'content-type': 'application/json' }); res.end(JSON.stringify(receipt));
  });
  const base = await listen(server);
  try {
    let fulfilled = 0;
    const results = await Promise.all(Array.from({ length: 8 }, () => pay({ 'x-payment': txid }, () => { fulfilled++; }, { facilitatorUrl: base })));
    assert.equal(fulfilled, 1); assert.equal(results.filter(r => r.code === 402).length, 7);
    assert.equal(settles, 8); assert.equal(verifies, 0);
  } finally { await close(server); }
});

test('real Express adapter preserves mounted resource and delegates application errors once', async () => {
  const moduleName = 'express';
  const { default: express } = await import(moduleName);
  const { zcashPaywall } = await import('./express.js');
  const app = express(); let fulfilled = 0; let errors = 0; const chargedResources: string[] = [];
  const facilitator = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    assert.equal(req.headers.authorization, `Bearer ${config.apiKey}`);
    chargedResources.push(body.resource ?? body.paymentPayload.resource.url);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.url?.includes('/sessions/') ?
      { valid: true, session_id: 'synthetic-session', balance_remaining: 0, requests_made: 1, deducted: 100000 } : receipt));
  });
  const facilitatorUrl = await listen(facilitator);
  app.use('/premium', zcashPaywall({ ...config, facilitatorUrl }));
  app.get('/premium/data', (_req: unknown, res: any) => { fulfilled++; res.json({ ok: true }); });
  app.get('/premium/failure', () => { throw new Error('private downstream failure'); });
  app.use((_error: unknown, _req: unknown, res: any, _next: unknown) => { errors++; res.status(500).json({ error: 'application failed' }); });
  const server = createServer(app); const base = await listen(server);
  try {
    const challenge = await realFetch(base + '/premium/data'); assert.equal(challenge.status, 402);
    assert.equal((await challenge.json() as any).resource.url, '/premium/data');
    const paid = await realFetch(base + '/premium/data', { headers: { 'x-payment': txid } });
    assert.equal(paid.status, 200); assert.deepEqual(await paid.json(), { ok: true });
    const session = await realFetch(base + '/premium/data?size=2', { headers: { authorization: 'Bearer cps_synthetic' } });
    assert.equal(session.status, 200); await session.body?.cancel();
    const failure = await realFetch(base + '/premium/failure', { headers: { 'x-payment': txid } });
    assert.equal(failure.status, 500); assert.deepEqual(await failure.json(), { error: 'application failed' });
    assert.equal(fulfilled, 2); assert.equal(errors, 1);
    assert.deepEqual(chargedResources, ['/premium/data', '/premium/data?size=2', '/premium/failure']);
  } finally { await close(server); await close(facilitator); }
});


test('successful direct session deduction reports the exact charged zatoshis', async () => {
  globalThis.fetch = async () => json({ valid: true, session_id: 's', balance_remaining: 7, requests_made: 2, deducted: 123 });
  const { deductSession } = await import('./client.js');
  const result = await deductSession('cps_synthetic', 123, undefined, { apiKey: config.apiKey, resource: '/metered' });
  assert.equal(result.valid, true); assert.equal(result.deducted, 123);
});

test('settlement session and idempotency options preserve validated wire fields', async () => {
  let captured: any;
  globalThis.fetch = async (_url, init) => {
    captured = { body: JSON.parse(String(init?.body)), headers: init?.headers };
    return json({ ...receipt, session: { token: 'cps_synthetic_surplus', sessionId: 's', balanceRemaining: 4000, costPerRequest: 1000, expiresAt: '2026-12-01T00:00:00Z' } });
  };
  const settled = await settlePaymentV2(payload, expected, config.apiKey, undefined, {
    session: { costPerRequest: 1000, refundAddress: 'u1synthetic-refund' }, idempotencyKey: 'synthetic-request-id',
  });
  assert.equal(captured.headers['Idempotency-Key'], 'synthetic-request-id');
  assert.deepEqual(captured.body.session, { costPerRequest: 1000, refundAddress: 'u1synthetic-refund' });
  assert.equal(settled.session?.token, 'cps_synthetic_surplus');
  const res = await pay({ 'x-payment': txid }, () => {}, { autoSession: { costPerRequest: 1000 } });
  assert.equal(res.headers['x-session-token'], 'cps_synthetic_surplus');
});

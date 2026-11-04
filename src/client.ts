import { randomUUID } from 'node:crypto';
import type {
  VerifyResponse, VerifyResponseV2, SettleResponseV2, SettleSessionConfig,
  SupportedResponse, PaymentPayload, PaymentRequirements, SessionValidateResponse,
  SessionDeductResponse, SessionPrepareResponse,
} from './types.js';
import { zecToZatoshis, zatoshisToZec } from './types.js';
import { request, object, text, integer, invalidResponse, merchantKey } from './http.js';

const DEFAULT_FACILITATOR_URL = 'https://api.cipherpay.app';
const VERIFY_TIMEOUT_MS = 30_000;
const SESSION_TIMEOUT_MS = 5_000;
const TXID = /^[a-fA-F0-9]{64}$/;
function txid(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !TXID.test(value)) throw new Error('A 64-character transaction ID is required');
}
function optionalText(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (!text(value)) invalidResponse();
  return value;
}
function requirements(payload: PaymentPayload, expected: PaymentRequirements) {
  txid(payload?.payload?.txid);
  if (payload.x402Version !== 2 || expected.scheme !== 'exact' || expected.asset !== 'ZEC' ||
      !['zcash:mainnet', 'zcash:testnet'].includes(expected.network) || !text(expected.payTo) ||
      !Number.isSafeInteger(expected.maxTimeoutSeconds) || expected.maxTimeoutSeconds <= 0) {
    throw new Error('Invalid x402 V2 payment requirements');
  }
  if (zatoshisToZec(expected.amount) <= 0) throw new Error('A positive price is required');
  for (const key of ['scheme', 'network', 'asset', 'amount', 'payTo'] as const) {
    if (payload.accepted?.[key] !== expected[key]) throw new Error('Accepted payment differs from resource requirements');
  }
}

/** Legacy V1 consumes the receipt on the facilitator. */
export async function verifyPayment(tx: string, expectedAmountZec: number, apiKey: string,
  facilitatorUrl = DEFAULT_FACILITATOR_URL, protocol?: string): Promise<VerifyResponse> {
  txid(tx);
  const expected = Number(zecToZatoshis(expectedAmountZec));
  if (protocol !== undefined && !['x402', 'mpp'].includes(protocol)) throw new Error('Unsupported payment protocol');
  const { data } = await request(facilitatorUrl, '/api/x402/verify', VERIFY_TIMEOUT_MS, {
    apiKey, body: { txid: tx, expected_amount_zec: expectedAmountZec, ...(protocol ? { protocol } : {}) },
  });
  const value = object(data);
  if (typeof value.valid !== 'boolean' || typeof value.previously_verified !== 'boolean' ||
      !integer(value.received_zatoshis) || typeof value.received_zec !== 'number' ||
      !Number.isFinite(value.received_zec) ||
      Math.abs(value.received_zec - value.received_zatoshis / 1e8) >= 0.000000005 ||
      (value.valid && value.received_zatoshis < expected)) invalidResponse();
  return { valid: value.valid, previously_verified: value.previously_verified,
    received_zatoshis: value.received_zatoshis, received_zec: value.received_zatoshis / 1e8,
    reason: optionalText(value.reason) };
}

/** Read-only V2 verification does not authorize fulfilling a resource; settle first. */
export async function verifyPaymentV2(paymentPayload: PaymentPayload, paymentRequirements: PaymentRequirements,
  apiKey: string, facilitatorUrl = DEFAULT_FACILITATOR_URL): Promise<VerifyResponseV2> {
  requirements(paymentPayload, paymentRequirements);
  const { data } = await request(facilitatorUrl, '/api/x402/v2/verify', VERIFY_TIMEOUT_MS, {
    apiKey, body: { x402Version: 2, paymentPayload, paymentRequirements },
  });
  const value = object(data);
  if (typeof value.isValid !== 'boolean') invalidResponse();
  return { isValid: value.isValid, invalidReason: optionalText(value.invalidReason), payer: optionalText(value.payer) };
}

/** Atomically consume a receipt. A cached response must never fulfill the resource again. */
export async function settlePaymentV2(paymentPayload: PaymentPayload, paymentRequirements: PaymentRequirements,
  apiKey: string, facilitatorUrl = DEFAULT_FACILITATOR_URL,
  options?: { session?: SettleSessionConfig; idempotencyKey?: string }): Promise<SettleResponseV2> {
  requirements(paymentPayload, paymentRequirements);
  if (options?.idempotencyKey !== undefined && !text(options.idempotencyKey, 128)) throw new Error('Invalid idempotency key');
  if (options?.session?.costPerRequest !== undefined && !integer(options.session.costPerRequest, true)) throw new Error('Invalid session price');
  if (options?.session?.refundAddress !== undefined && !text(options.session.refundAddress)) throw new Error('Invalid refund address');
  const { data, headers, status } = await request(facilitatorUrl, '/api/x402/v2/settle', VERIFY_TIMEOUT_MS, {
    apiKey, allowConflict: true,
    headers: options?.idempotencyKey ? { 'Idempotency-Key': options.idempotencyKey } : undefined,
    body: { x402Version: 2, paymentPayload, paymentRequirements, ...(options?.session ? { session: options.session } : {}) },
  });
  if (status === 409) return { success: false, transaction: '', network: paymentRequirements.network, errorReason: 'payment_replayed', replayed: true };
  const value = object(data);
  if (typeof value.success !== 'boolean' || (value.replayed !== undefined && typeof value.replayed !== 'boolean')) invalidResponse();
  const replayHeader = headers.get('Idempotency-Replayed');
  if (replayHeader !== null && replayHeader !== 'true' && replayHeader !== 'false') invalidResponse();
  const replayed = value.replayed === true || replayHeader === 'true';
  if (value.success && (typeof value.transaction !== 'string' ||
      value.transaction.toLowerCase() !== paymentPayload.payload.txid.toLowerCase() || value.network !== paymentRequirements.network)) invalidResponse();
  if (value.amount !== undefined && (typeof value.amount !== 'string' ||
      zatoshisToZec(value.amount) < zatoshisToZec(paymentRequirements.amount))) invalidResponse();
  let session: SettleResponseV2['session'];
  if (value.session !== undefined) {
    const s = object(value.session);
    if (!text(s.token) || !s.token.startsWith('cps_') || !text(s.sessionId) ||
        !integer(s.balanceRemaining) || !integer(s.costPerRequest, true) || !text(s.expiresAt)) invalidResponse();
    session = { token: s.token, sessionId: s.sessionId, balanceRemaining: s.balanceRemaining,
      costPerRequest: s.costPerRequest, expiresAt: s.expiresAt };
  }
  return { success: value.success, transaction: value.success ? value.transaction : '',
    network: paymentRequirements.network, replayed, errorReason: optionalText(value.errorReason),
    payer: optionalText(value.payer), amount: value.amount, session };
}

export async function getSupported(facilitatorUrl = DEFAULT_FACILITATOR_URL): Promise<SupportedResponse> {
  const { data } = await request(facilitatorUrl, '/api/x402/supported', SESSION_TIMEOUT_MS);
  const v = object(data);
  if (!Array.isArray(v.kinds) || !v.kinds.every((k: unknown) => {
    const kind = object(k); return Number.isSafeInteger(kind.x402Version) && text(kind.scheme) && text(kind.network);
  }) || !Array.isArray(v.extensions) || !v.extensions.every((e: unknown) => text(e))) invalidResponse();
  const signers = object(v.signers);
  if (!Object.values(signers).every(s => Array.isArray(s) && s.every(k => text(k)))) invalidResponse();
  return { kinds: v.kinds, extensions: v.extensions, signers };
}

/** Merchant-authenticated, priced and resource-bound atomic session charge. */
export async function validateSession(token: string, apiKey: string, facilitatorUrl = DEFAULT_FACILITATOR_URL,
  charge?: { amountZatoshis: number; resource: string; requestId?: string }): Promise<SessionValidateResponse> {
  merchantKey(apiKey);
  if (!text(token) || !token.startsWith('cps_') || !charge || !integer(charge.amountZatoshis, true) ||
      !text(charge.resource, 2048) || (charge.requestId !== undefined && !text(charge.requestId, 128))) {
    throw new Error('Merchant-authenticated session charge requires a token, integer price and resource');
  }
  const { data } = await request(facilitatorUrl, '/api/sessions/validate', SESSION_TIMEOUT_MS, {
    apiKey, body: { token, amount_zatoshis: charge.amountZatoshis, resource: charge.resource, request_id: charge.requestId ?? randomUUID() },
  });
  const value = object(data);
  if (typeof value.valid !== 'boolean' || (value.valid &&
      (!text(value.session_id) || !integer(value.balance_remaining) || !integer(value.requests_made) ||
       !integer(value.deducted, true) || value.deducted !== charge.amountZatoshis))) invalidResponse();
  return { valid: value.valid, ...(value.valid ? { session_id: value.session_id,
    balance_remaining: value.balance_remaining, requests_made: value.requests_made, deducted: value.deducted } : {}), reason: optionalText(value.reason) };
}

export async function deductSession(token: string, amountZatoshis: number, facilitatorUrl = DEFAULT_FACILITATOR_URL,
  authorization?: { apiKey: string; resource: string; requestId?: string }): Promise<SessionDeductResponse> {
  if (!authorization) throw new Error('Merchant API key and resource are required to meter a session');
  return validateSession(token, authorization.apiKey, facilitatorUrl, { amountZatoshis, resource: authorization.resource, requestId: authorization.requestId });
}

/** Prepare a unique deposit address before paying; the returned ID is required to open it. */
export async function prepareSession(merchantId: string, facilitatorUrl = DEFAULT_FACILITATOR_URL,
  apiKey?: string): Promise<SessionPrepareResponse> {
  merchantKey(apiKey ?? '');
  if (!text(merchantId, 200)) throw new Error('Merchant ID is required');
  const { data } = await request(facilitatorUrl, '/api/sessions/prepare', SESSION_TIMEOUT_MS, { apiKey, body: { merchant_id: merchantId } });
  const v = object(data);
  if (!text(v.session_request_id, 200) || !text(v.deposit_address) || v.merchant_id !== merchantId ||
      !integer(v.min_deposit_zatoshis, true) || !Number.isSafeInteger(v.expires_in_seconds) || v.expires_in_seconds <= 0) invalidResponse();
  return { session_request_id: v.session_request_id, deposit_address: v.deposit_address,
    merchant_id: v.merchant_id, min_deposit_zatoshis: v.min_deposit_zatoshis, expires_in_seconds: v.expires_in_seconds };
}

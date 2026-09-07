import { randomUUID } from 'node:crypto';
import type {
  VerifyResponse,
  VerifyResponseV2,
  SettleResponseV2,
  SettleSessionConfig,
  SupportedResponse,
  PaymentPayload,
  PaymentRequirements,
  SessionValidateResponse,
  SessionDeductResponse,
  SessionPrepareResponse,
} from './types.js';

const DEFAULT_FACILITATOR_URL = 'https://api.cipherpay.app';
const VERIFY_TIMEOUT_MS = 30_000;
const SESSION_TIMEOUT_MS = 5_000;

/**
 * Verify a shielded Zcash payment via CipherPay's x402 facilitator.
 */
export async function verifyPayment(
  txid: string,
  expectedAmountZec: number,
  apiKey: string,
  facilitatorUrl = DEFAULT_FACILITATOR_URL,
  protocol?: string,
): Promise<VerifyResponse> {
  const url = `${facilitatorUrl.replace(/\/$/, '')}/api/x402/verify`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        txid,
        expected_amount_zec: expectedAmountZec,
        ...(protocol ? { protocol } : {}),
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`CipherPay verify failed (${res.status}): ${text}`);
    }

    return await res.json() as VerifyResponse;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Verify a payment via x402 V2 spec-compliant facilitator endpoint.
 * Sends { x402Version, paymentPayload, paymentRequirements } to /api/x402/v2/verify.
 */
export async function verifyPaymentV2(
  paymentPayload: PaymentPayload,
  paymentRequirements: PaymentRequirements,
  apiKey: string,
  facilitatorUrl = DEFAULT_FACILITATOR_URL,
): Promise<VerifyResponseV2> {
  const url = `${facilitatorUrl.replace(/\/$/, '')}/api/x402/v2/verify`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        x402Version: 2,
        paymentPayload,
        paymentRequirements,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`CipherPay V2 verify failed (${res.status}): ${text}`);
    }

    return await res.json() as VerifyResponseV2;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Settle a payment via x402 V2 spec-compliant facilitator endpoint.
 *
 * Supports auto-session creation: pass `session` config to receive a session
 * token in the response when the payment covers multiple requests.
 *
 * Supports idempotency: pass `idempotencyKey` to safely retry the same request.
 */
export async function settlePaymentV2(
  paymentPayload: PaymentPayload,
  paymentRequirements: PaymentRequirements,
  apiKey: string,
  facilitatorUrl = DEFAULT_FACILITATOR_URL,
  options?: {
    session?: SettleSessionConfig;
    idempotencyKey?: string;
  },
): Promise<SettleResponseV2> {
  const url = `${facilitatorUrl.replace(/\/$/, '')}/api/x402/v2/settle`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`,
  };
  if (options?.idempotencyKey) {
    headers['Idempotency-Key'] = options.idempotencyKey;
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        x402Version: 2,
        paymentPayload,
        paymentRequirements,
        ...(options?.session ? { session: options.session } : {}),
      }),
      signal: controller.signal,
    });

    if (res.status === 409) return { success: false, transaction: '', network: paymentRequirements.network, errorReason: 'payment_replayed' };
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`CipherPay V2 settle failed (${res.status}): ${text}`);
    }

    const result = await res.json() as SettleResponseV2;
    return { ...result, replayed: res.headers.get('Idempotency-Replayed') === 'true' };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Query facilitator capabilities via GET /api/x402/supported.
 */
export async function getSupported(
  facilitatorUrl = DEFAULT_FACILITATOR_URL,
): Promise<SupportedResponse> {
  const url = `${facilitatorUrl.replace(/\/$/, '')}/api/x402/supported`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SESSION_TIMEOUT_MS);

  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`CipherPay supported query failed (${res.status})`);
    }
    return await res.json() as SupportedResponse;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Validate a session bearer token and deduct one request from the balance.
 * Token is sent via Authorization header (not query string) to avoid URL logging.
 */
export async function validateSession(
  token: string,
  apiKey: string,
  facilitatorUrl = DEFAULT_FACILITATOR_URL,
  charge?: { amountZatoshis: number; resource: string; requestId?: string },
): Promise<SessionValidateResponse> {
  if (!charge || !Number.isSafeInteger(charge.amountZatoshis) || charge.amountZatoshis <= 0 || !charge.resource) {
    throw new Error('Merchant-authenticated session charge requires integer price and resource');
  }
  const url = `${facilitatorUrl.replace(/\/$/, '')}/api/sessions/validate`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SESSION_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, amount_zatoshis: charge.amountZatoshis,
        resource: charge.resource, request_id: charge.requestId || randomUUID() }),
      signal: controller.signal,
    });

    if (!res.ok) {
      return { valid: false };
    }

    return await res.json() as SessionValidateResponse;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Deduct a variable amount from a session (for streaming metering).
 */
export async function deductSession(
  token: string,
  amountZatoshis: number,
  facilitatorUrl = DEFAULT_FACILITATOR_URL,
  authorization?: { apiKey: string; resource: string; requestId?: string },
): Promise<SessionDeductResponse> {
  if (!authorization) throw new Error('Merchant API key and resource are required to meter a session');
  return validateSession(token, authorization.apiKey, facilitatorUrl, {
    amountZatoshis, resource: authorization.resource, requestId: authorization.requestId,
  });

}

/**
 * Prepare a session deposit: get a unique payment address (no memo needed).
 */
export async function prepareSession(
  merchantId: string,
  facilitatorUrl = DEFAULT_FACILITATOR_URL,
  apiKey?: string,
): Promise<SessionPrepareResponse> {
  const url = `${facilitatorUrl.replace(/\/$/, '')}/api/sessions/prepare`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SESSION_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey || ''}` },
      body: JSON.stringify({ merchant_id: merchantId }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Session prepare failed (${res.status}): ${text}`);
    }

    return await res.json() as SessionPrepareResponse;
  } finally {
    clearTimeout(timeout);
  }
}

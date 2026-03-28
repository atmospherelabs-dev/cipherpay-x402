import type { VerifyResponse, SessionValidateResponse, SessionDeductResponse, SessionPrepareResponse } from './types.js';

const DEFAULT_FACILITATOR_URL = 'https://api.cipherpay.app';
const VERIFY_TIMEOUT_MS = 30_000;

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

const SESSION_TIMEOUT_MS = 5_000;

/**
 * Validate a session bearer token and deduct one request from the balance.
 * Token is sent via Authorization header (not query string) to avoid URL logging.
 */
export async function validateSession(
  token: string,
  _apiKey: string,
  facilitatorUrl = DEFAULT_FACILITATOR_URL,
): Promise<SessionValidateResponse> {
  const url = `${facilitatorUrl.replace(/\/$/, '')}/api/sessions/validate`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SESSION_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` },
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
): Promise<SessionDeductResponse> {
  const url = `${facilitatorUrl.replace(/\/$/, '')}/api/sessions/deduct`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SESSION_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({ amount_zatoshis: amountZatoshis }),
      signal: controller.signal,
    });

    if (!res.ok) {
      return { valid: false };
    }

    return await res.json() as SessionDeductResponse;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Prepare a session deposit: get a unique payment address (no memo needed).
 */
export async function prepareSession(
  merchantId: string,
  facilitatorUrl = DEFAULT_FACILITATOR_URL,
): Promise<SessionPrepareResponse> {
  const url = `${facilitatorUrl.replace(/\/$/, '')}/api/sessions/prepare`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SESSION_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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

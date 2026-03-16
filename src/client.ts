import type { VerifyResponse } from './types.js';

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

import type {
  PaywallConfig,
  PaymentRequired,
  PaymentPayload,
  SettlementResponse,
  GenericRequest,
  GenericResponse,
} from './types.js';
import { zecToZatoshis } from './types.js';
import { verifyPayment } from './client.js';

// x402 v2 standard headers
const HEADER_PAYMENT_SIGNATURE = 'payment-signature';
const HEADER_PAYMENT_REQUIRED = 'payment-required';
const HEADER_PAYMENT_RESPONSE = 'payment-response';

// Legacy header (backward compatibility)
const HEADER_X_PAYMENT = 'x-payment';

/**
 * Extract the txid from the incoming request.
 *
 * Supports two formats:
 * 1. x402 v2: PAYMENT-SIGNATURE header → base64 → JSON PaymentPayload → payload.txid
 * 2. Legacy:  X-PAYMENT header → raw txid or txid=<hex>
 */
function extractTxid(headers: Record<string, string | string[] | undefined>): string | null {
  // Normalize header names to lowercase for case-insensitive lookup
  const normalized: Record<string, string> = {};
  for (const [key, val] of Object.entries(headers)) {
    const v = Array.isArray(val) ? val[0] : val;
    if (v) normalized[key.toLowerCase()] = v;
  }

  // x402 v2: PAYMENT-SIGNATURE header (base64-encoded PaymentPayload)
  const signatureHeader = normalized[HEADER_PAYMENT_SIGNATURE];
  if (signatureHeader) {
    try {
      const json = Buffer.from(signatureHeader, 'base64').toString('utf-8');
      const payload: PaymentPayload = JSON.parse(json);
      if (payload.payload?.txid && /^[a-fA-F0-9]{64}$/.test(payload.payload.txid)) {
        return payload.payload.txid;
      }
    } catch {
      // Fall through to legacy header
    }
  }

  // Legacy: X-PAYMENT header (raw txid or txid=<hex>)
  const legacyHeader = normalized[HEADER_X_PAYMENT];
  if (legacyHeader) {
    const trimmed = legacyHeader.trim();
    const match = trimmed.match(/^txid=([a-fA-F0-9]{64})$/);
    if (match) return match[1];
    if (/^[a-fA-F0-9]{64}$/.test(trimmed)) return trimmed;
  }

  return null;
}

/**
 * Build the x402 v2 PaymentRequired response.
 */
function buildPaymentRequired(config: PaywallConfig, amount: number, resourceUrl: string): PaymentRequired {
  const network = config.network ?? 'zcash:mainnet';

  return {
    x402Version: 2,
    resource: {
      url: resourceUrl,
      description: config.description,
    },
    accepts: [
      {
        scheme: 'exact',
        network,
        asset: 'ZEC',
        amount: zecToZatoshis(amount),
        payTo: config.address,
        maxTimeoutSeconds: config.maxTimeoutSeconds ?? 120,
        extra: {},
      },
    ],
  };
}

/**
 * Base64-encode a JSON object for x402 headers.
 */
function toBase64(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString('base64');
}

export type NextFunction = () => void | Promise<void>;

/**
 * Framework-agnostic x402 paywall middleware (v2).
 *
 * - No valid payment header → 402 with PAYMENT-REQUIRED header + JSON body
 * - Valid txid → verify via CipherPay → grant access or reject
 * - On success → set PAYMENT-RESPONSE header
 */
export function createPaywall(config: PaywallConfig) {
  if (!config.address) throw new Error('@cipherpay/x402: address is required');
  if (!config.apiKey) throw new Error('@cipherpay/x402: apiKey is required');
  if (!config.amount && !config.getAmount) throw new Error('@cipherpay/x402: amount or getAmount is required');

  return async function paywall(
    req: GenericRequest,
    res: GenericResponse,
    next: NextFunction,
  ): Promise<void> {
    const amount = config.getAmount
      ? await config.getAmount(req)
      : config.amount;

    const txid = extractTxid(req.headers);

    if (!txid) {
      const body = buildPaymentRequired(config, amount, req.url);

      res.setHeader('Content-Type', 'application/json');
      res.setHeader(HEADER_PAYMENT_REQUIRED, toBase64(body));
      res.status(402).json(body);
      return;
    }

    try {
      const result = await verifyPayment(
        txid,
        amount,
        config.apiKey,
        config.facilitatorUrl,
      );

      if (result.valid) {
        const settlement: SettlementResponse = {
          success: true,
          txid,
          network: config.network ?? 'zcash:mainnet',
        };
        res.setHeader(HEADER_PAYMENT_RESPONSE, toBase64(settlement));
        await next();
      } else {
        const body = buildPaymentRequired(config, amount, req.url);
        res.setHeader('Content-Type', 'application/json');
        res.setHeader(HEADER_PAYMENT_REQUIRED, toBase64(body));
        res.status(402).json({
          error: 'payment_invalid',
          reason: result.reason ?? 'Payment verification failed',
          ...body,
        });
      }
    } catch (err) {
      res.setHeader('Content-Type', 'application/json');
      res.status(500).json({
        error: 'verification_error',
        message: err instanceof Error ? err.message : 'Verification failed',
      });
    }
  };
}

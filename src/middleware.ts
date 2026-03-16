import type {
  PaywallConfig,
  PaymentRequiredResponse,
  GenericRequest,
  GenericResponse,
} from './types.js';
import { verifyPayment } from './client.js';

const PAYMENT_HEADER = 'x-payment';

/**
 * Extract the txid from the X-PAYMENT header.
 * Supports both `txid=<value>` and raw `<value>` formats.
 */
function extractTxid(header: string | string[] | undefined): string | null {
  if (!header) return null;
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return null;

  const trimmed = value.trim();

  // Format: txid=<hex>
  const match = trimmed.match(/^txid=([a-fA-F0-9]{64})$/);
  if (match) return match[1];

  // Format: raw 64-char hex
  if (/^[a-fA-F0-9]{64}$/.test(trimmed)) return trimmed;

  return null;
}

/**
 * Build the 402 Payment Required response body.
 */
function buildPaymentRequired(config: PaywallConfig, amount: number): PaymentRequiredResponse {
  const network = config.network ?? 'zcash:mainnet';
  const facilitatorUrl = config.facilitatorUrl ?? 'https://api.cipherpay.app';

  return {
    x402Version: 1,
    accepts: [
      {
        network,
        token: 'ZEC',
        amount: amount.toFixed(8),
        address: config.address,
      },
    ],
    description: config.description,
    facilitator: {
      url: facilitatorUrl,
      network,
    },
  };
}

export type NextFunction = () => void | Promise<void>;

/**
 * Framework-agnostic x402 paywall middleware.
 *
 * When no valid X-PAYMENT header is present, responds with 402 and payment instructions.
 * When a txid is present, verifies via CipherPay and either grants access or rejects.
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

    const txid = extractTxid(req.headers[PAYMENT_HEADER]);

    if (!txid) {
      const body = buildPaymentRequired(config, amount);
      res.setHeader('Content-Type', 'application/json');
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
        await next();
      } else {
        res.setHeader('Content-Type', 'application/json');
        res.status(402).json({
          error: 'payment_invalid',
          reason: result.reason ?? 'Payment verification failed',
          ...buildPaymentRequired(config, amount),
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

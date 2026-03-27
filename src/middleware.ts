import type {
  PaywallConfig,
  PaymentRequired,
  PaymentPayload,
  SettlementResponse,
  MppCredential,
  GenericRequest,
  GenericResponse,
} from './types.js';
import { zecToZatoshis } from './types.js';
import { verifyPayment } from './client.js';

const HEADER_PAYMENT_SIGNATURE = 'payment-signature';
const HEADER_PAYMENT_REQUIRED = 'payment-required';
const HEADER_PAYMENT_RESPONSE = 'payment-response';
const HEADER_X_PAYMENT = 'x-payment';
const HEADER_WWW_AUTHENTICATE = 'www-authenticate';
const HEADER_AUTHORIZATION = 'authorization';

function normalizeHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, val] of Object.entries(headers)) {
    const v = Array.isArray(val) ? val[0] : val;
    if (v) out[key.toLowerCase()] = v;
  }
  return out;
}

/**
 * Extract txid from incoming request, checking both x402 and MPP credential formats.
 * Returns { txid, protocol } or null.
 */
function extractPayment(headers: Record<string, string | string[] | undefined>): { txid: string; protocol: 'x402' | 'mpp' } | null {
  const h = normalizeHeaders(headers);

  // MPP: Authorization: Payment <base64url(JSON credential)>
  const authHeader = h[HEADER_AUTHORIZATION];
  if (authHeader) {
    const mppMatch = authHeader.match(/^Payment\s+(.+)$/i);
    if (mppMatch) {
      try {
        const json = Buffer.from(mppMatch[1], 'base64url').toString('utf-8');
        const cred: MppCredential = JSON.parse(json);
        if (cred.payload?.txid && /^[a-fA-F0-9]{64}$/.test(cred.payload.txid)) {
          return { txid: cred.payload.txid, protocol: 'mpp' };
        }
      } catch {
        // Also try standard base64 in case client uses that
        try {
          const json = Buffer.from(mppMatch[1], 'base64').toString('utf-8');
          const cred: MppCredential = JSON.parse(json);
          if (cred.payload?.txid && /^[a-fA-F0-9]{64}$/.test(cred.payload.txid)) {
            return { txid: cred.payload.txid, protocol: 'mpp' };
          }
        } catch { /* fall through */ }
      }
    }
  }

  // x402 v2: PAYMENT-SIGNATURE header (base64-encoded PaymentPayload)
  const sigHeader = h[HEADER_PAYMENT_SIGNATURE];
  if (sigHeader) {
    try {
      const json = Buffer.from(sigHeader, 'base64').toString('utf-8');
      const payload: PaymentPayload = JSON.parse(json);
      if (payload.payload?.txid && /^[a-fA-F0-9]{64}$/.test(payload.payload.txid)) {
        return { txid: payload.payload.txid, protocol: 'x402' };
      }
    } catch { /* fall through */ }
  }

  // Legacy: X-PAYMENT header
  const legacyHeader = h[HEADER_X_PAYMENT];
  if (legacyHeader) {
    const trimmed = legacyHeader.trim();
    const match = trimmed.match(/^txid=([a-fA-F0-9]{64})$/);
    if (match) return { txid: match[1], protocol: 'x402' };
    if (/^[a-fA-F0-9]{64}$/.test(trimmed)) return { txid: trimmed, protocol: 'x402' };
  }

  return null;
}

function buildPaymentRequired(config: PaywallConfig, amount: number, resourceUrl: string): PaymentRequired {
  const network = config.network ?? 'zcash:mainnet';
  return {
    x402Version: 2,
    resource: { url: resourceUrl, description: config.description },
    accepts: [{
      scheme: 'exact',
      network,
      asset: 'ZEC',
      amount: zecToZatoshis(amount),
      payTo: config.address,
      maxTimeoutSeconds: config.maxTimeoutSeconds ?? 120,
      extra: {},
    }],
  };
}

/**
 * Build the MPP WWW-Authenticate: Payment header value.
 */
function buildMppChallenge(config: PaywallConfig, amount: number, resourceUrl: string): string {
  const network = config.network ?? 'zcash:mainnet';
  const charge = {
    amount: zecToZatoshis(amount),
    currency: 'ZEC',
    recipient: config.address,
    description: config.description ?? resourceUrl,
  };
  const requestB64 = Buffer.from(JSON.stringify(charge)).toString('base64url');
  const id = Buffer.from(resourceUrl).toString('base64url').slice(0, 32);

  return `Payment id="${id}", realm="${network}", method="zcash", intent="charge", request="${requestB64}"`;
}

function toBase64(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString('base64');
}

export type NextFunction = () => void | Promise<void>;

/**
 * Framework-agnostic paywall middleware supporting x402 and MPP protocols.
 *
 * Accepts credentials from either protocol regardless of the `protocol` config.
 * The `protocol` setting controls which challenge format(s) are advertised in
 * the 402 response.
 */
export function createPaywall(config: PaywallConfig) {
  if (!config.address) throw new Error('@cipherpay/x402: address is required');
  if (!config.apiKey) throw new Error('@cipherpay/x402: apiKey is required');
  if (!config.amount && !config.getAmount) throw new Error('@cipherpay/x402: amount or getAmount is required');

  const advertise = config.protocol ?? 'both';

  return async function paywall(
    req: GenericRequest,
    res: GenericResponse,
    next: NextFunction,
  ): Promise<void> {
    const amount = config.getAmount
      ? await config.getAmount(req)
      : config.amount;

    const payment = extractPayment(req.headers);

    if (!payment) {
      const body = buildPaymentRequired(config, amount, req.url);

      res.setHeader('Content-Type', 'application/json');

      if (advertise === 'x402' || advertise === 'both') {
        res.setHeader(HEADER_PAYMENT_REQUIRED, toBase64(body));
      }
      if (advertise === 'mpp' || advertise === 'both') {
        res.setHeader('WWW-Authenticate', buildMppChallenge(config, amount, req.url));
      }

      res.status(402).json(body);
      return;
    }

    try {
      const result = await verifyPayment(
        payment.txid,
        amount,
        config.apiKey,
        config.facilitatorUrl,
      );

      if (result.valid) {
        const settlement: SettlementResponse = {
          success: true,
          txid: payment.txid,
          network: config.network ?? 'zcash:mainnet',
        };

        if (payment.protocol === 'mpp') {
          const receipt = Buffer.from(JSON.stringify(settlement)).toString('base64url');
          res.setHeader('Payment-Receipt', receipt);
        }
        res.setHeader(HEADER_PAYMENT_RESPONSE, toBase64(settlement));

        await next();
      } else {
        const body = buildPaymentRequired(config, amount, req.url);
        res.setHeader('Content-Type', 'application/json');

        if (advertise === 'x402' || advertise === 'both') {
          res.setHeader(HEADER_PAYMENT_REQUIRED, toBase64(body));
        }
        if (advertise === 'mpp' || advertise === 'both') {
          res.setHeader('WWW-Authenticate', buildMppChallenge(config, amount, req.url));
        }

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

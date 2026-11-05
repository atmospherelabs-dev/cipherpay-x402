import type {
  PaywallConfig,
  PaymentRequired,
  PaymentPayload,
  PaymentRequirements,
  SettlementResponse,
  MppCredential,
  GenericRequest,
  GenericResponse,
} from './types.js';
import { zecToZatoshis } from './types.js';
import { facilitatorBase, text, integer, merchantKey } from './http.js';
import { verifyPayment, settlePaymentV2, validateSession } from './client.js';

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
    if (v && v.length <= 16_384) out[key.toLowerCase()] = v;
  }
  return out;
}

/**
 * Extract a session bearer token from Authorization: Bearer cps_...
 */
function extractSessionToken(headers: Record<string, string | string[] | undefined>): string | null {
  const h = normalizeHeaders(headers);
  const authHeader = h[HEADER_AUTHORIZATION];
  if (authHeader) {
    const match = authHeader.match(/^Bearer\s+(cps_.+)$/i);
    if (match) return match[1];
  }
  return null;
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
        if (cred.method === 'zcash' && typeof cred.payload?.txid === 'string' && /^[a-fA-F0-9]{64}$/.test(cred.payload.txid)) {
          return { txid: cred.payload.txid, protocol: 'mpp' };
        }
      } catch {
        // Also try standard base64 in case client uses that
        try {
          const json = Buffer.from(mppMatch[1], 'base64').toString('utf-8');
          const cred: MppCredential = JSON.parse(json);
          if (cred.method === 'zcash' && typeof cred.payload?.txid === 'string' && /^[a-fA-F0-9]{64}$/.test(cred.payload.txid)) {
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
      if (payload.x402Version === 2 && typeof payload.payload?.txid === 'string' && /^[a-fA-F0-9]{64}$/.test(payload.payload.txid)) {
        return { txid: payload.payload.txid, protocol: 'x402' };
      }
    } catch { /* fall through */ }
  }

  // @deprecated Legacy V1 header — will be removed in a future major version.
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
  const timeoutSec = config.challengeTimeoutSeconds ?? 300;
  const validUntil = new Date(Date.now() + timeoutSec * 1000).toISOString();
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
    validUntil,
  };
}

/**
 * Build the MPP WWW-Authenticate: Payment header value.
 */
function buildMppChallenge(config: PaywallConfig, amount: number, resourceUrl: string): string {
  const network = config.network ?? 'zcash:mainnet';
  const timeoutSec = config.challengeTimeoutSeconds ?? 300;
  const validUntil = new Date(Date.now() + timeoutSec * 1000).toISOString();
  const charge = {
    amount: zecToZatoshis(amount),
    currency: 'ZEC',
    recipient: config.address,
    description: config.description ?? resourceUrl,
    valid_until: validUntil,
  };
  const requestB64 = Buffer.from(JSON.stringify(charge)).toString('base64url');
  const id = Buffer.from(resourceUrl).toString('base64url').slice(0, 32);

  return `Payment id="${id}", realm="${network}", method="zcash", intent="charge", request="${requestB64}", valid_until="${validUntil}"`;
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
  if (!text(config.address)) throw new Error('@cipherpay/x402: address is required');
  merchantKey(config.apiKey);
  if (config.facilitatorUrl !== undefined) facilitatorBase(config.facilitatorUrl);
  if (config.network !== undefined && !['zcash:mainnet', 'zcash:testnet'].includes(config.network)) throw new Error('Unsupported Zcash network');
  if (config.facilitatorVersion !== undefined && ![1, 2].includes(config.facilitatorVersion)) throw new Error('Unsupported facilitator version');
  if (config.protocol !== undefined && !['x402', 'mpp', 'both'].includes(config.protocol)) throw new Error('Unsupported protocol');
  for (const timeout of [config.maxTimeoutSeconds, config.challengeTimeoutSeconds]) {
    if (timeout !== undefined && (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 86_400)) throw new Error('Invalid challenge timeout');
  }
  if (!config.getAmount) zecToZatoshis(config.amount);
  if (config.autoSession?.costPerRequest !== undefined && !integer(config.autoSession.costPerRequest, true)) throw new Error('Invalid session price');
  if (!config.amount && !config.getAmount) throw new Error('@cipherpay/x402: amount or getAmount is required');

  const advertise = config.protocol ?? 'both';
  const rejectReplays = config.rejectReplays ?? true;
  const facilitatorVersion = config.facilitatorVersion ?? 2;

  return async function paywall(
    req: GenericRequest,
    res: GenericResponse,
    next: NextFunction,
  ): Promise<void> {
    const amount = config.getAmount
      ? await config.getAmount(req)
      : config.amount;

    zecToZatoshis(amount);
    const resourceUrl = req.originalUrl ?? req.url;
    if (!text(resourceUrl, 2048)) throw new Error('Invalid payment resource URL');

    // Session bearer tokens take priority — instant, no per-tx verification
    const sessionToken = extractSessionToken(req.headers);
    if (sessionToken) {
      let accepted = false;
      try {
        const session = await validateSession(sessionToken, config.apiKey, config.facilitatorUrl, {
          amountZatoshis: Number(zecToZatoshis(amount)), resource: resourceUrl,
        });
        if (session.valid) {
          res.setHeader('X-Session-Balance', String(session.balance_remaining));
          res.setHeader('X-Session-Id', session.session_id ?? '');
          accepted = true;
        }
        // Session token recognized but invalid/expired/depleted — require new payment
      } catch {
        res.setHeader('Content-Type', 'application/problem+json');
        res.status(503).json({
          type: 'https://cipherpay.app/errors/session-validation-unavailable',
          title: 'Session Validation Unavailable',
          status: 503,
          detail: 'Session validation service is temporarily unavailable. Try again shortly.',
        });
        return;
      }
      if (accepted) { await next(); return; }
    }

    const payment = extractPayment(req.headers);

    if (!payment) {
      const body = buildPaymentRequired(config, amount, resourceUrl);

      res.setHeader('Content-Type', 'application/json');

      if (advertise === 'x402' || advertise === 'both') {
        res.setHeader(HEADER_PAYMENT_REQUIRED, toBase64(body));
      }
      if (advertise === 'mpp' || advertise === 'both') {
        res.setHeader('WWW-Authenticate', buildMppChallenge(config, amount, resourceUrl));
      }

      res.status(402).json(body);
      return;
    }

    let authorized = false;
    try {
      let isValid: boolean;
      let isReplay = false;
      let sessionToken: string | undefined;

      if (facilitatorVersion === 2) {
        const challengeBody = buildPaymentRequired(config, amount, resourceUrl);
        const paymentPayload: PaymentPayload = {
          x402Version: 2,
          payload: { txid: payment.txid },
          resource: challengeBody.resource,
          accepted: challengeBody.accepts[0],
        };

        const settleResult = await settlePaymentV2(
          paymentPayload,
          challengeBody.accepts[0],
          config.apiKey,
          config.facilitatorUrl,
          config.autoSession ? { session: config.autoSession } : undefined,
        );
        isReplay = settleResult.replayed === true || settleResult.errorReason === 'payment_replayed';
        isValid = settleResult.success && !isReplay;

        if (settleResult.session?.token) {
          sessionToken = settleResult.session.token;
        }
      } else {
        const result = await verifyPayment(
          payment.txid,
          amount,
          config.apiKey,
          config.facilitatorUrl,
          payment.protocol,
        );
        isValid = result.valid && !(rejectReplays && result.previously_verified);
        isReplay = result.valid && result.previously_verified;
      }

      if (isValid) {
        const settlement: SettlementResponse = {
          success: true,
          transaction: payment.txid,
          network: config.network ?? 'zcash:mainnet',
        };

        if (payment.protocol === 'mpp') {
          const receipt = Buffer.from(JSON.stringify(settlement)).toString('base64url');
          res.setHeader('Payment-Receipt', receipt);
        }
        res.setHeader(HEADER_PAYMENT_RESPONSE, toBase64(settlement));

        if (sessionToken) {
          res.setHeader('X-Session-Token', sessionToken);
        }

        authorized = true;
      } else {
        const body = buildPaymentRequired(config, amount, resourceUrl);
        res.setHeader('Content-Type', 'application/problem+json');

        if (advertise === 'x402' || advertise === 'both') {
          res.setHeader(HEADER_PAYMENT_REQUIRED, toBase64(body));
        }
        if (advertise === 'mpp' || advertise === 'both') {
          res.setHeader('WWW-Authenticate', buildMppChallenge(config, amount, resourceUrl));
        }

        const errorType = isReplay ? 'payment-replayed' : 'payment-invalid';
        const errorTitle = isReplay ? 'Payment Replayed' : 'Payment Invalid';
        const errorDetail = isReplay
          ? 'This transaction has already been used. Send a new payment.'
          : 'Payment verification failed. Check the confirmed payment and current price.';

        res.status(402).json({
          type: `https://cipherpay.app/errors/${errorType}`,
          title: errorTitle,
          status: 402,
          detail: errorDetail,
          ...body,
        });
      }
    } catch {
      res.setHeader('Content-Type', 'application/problem+json');
      res.status(503).json({
        type: 'https://cipherpay.app/errors/verification-error',
        title: 'Verification Unavailable',
        status: 503,
        detail: 'Payment verification is temporarily unavailable. Try again shortly.',
      });
    }
    if (authorized) await next();
  };
}

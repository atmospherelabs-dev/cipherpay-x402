// ---------------------------------------------------------------------------
// x402 v2 Protocol Types (aligned with coinbase/x402 spec)
// ---------------------------------------------------------------------------

const ZATOSHIS_PER_ZEC = 100_000_000;

export function zecToZatoshis(zec: number): string {
  return Math.round(zec * ZATOSHIS_PER_ZEC).toString();
}

export function zatoshisToZec(zatoshis: string): number {
  return parseInt(zatoshis, 10) / ZATOSHIS_PER_ZEC;
}

// ---------------------------------------------------------------------------
// Wire protocol types (x402 v2)
// ---------------------------------------------------------------------------

export interface ResourceInfo {
  url: string;
  description?: string;
  mimeType?: string;
}

export interface PaymentRequirements {
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: Record<string, unknown>;
}

export interface PaymentRequired {
  x402Version: 2;
  resource: ResourceInfo;
  accepts: PaymentRequirements[];
  validUntil?: string;
  error?: string;
}

export interface PaymentPayload {
  x402Version: 2;
  resource?: ResourceInfo;
  accepted: PaymentRequirements;
  payload: {
    txid: string;
  };
}

export interface SettlementResponse {
  success: boolean;
  txid: string;
  network: string;
}

// ---------------------------------------------------------------------------
// Developer-facing config
// ---------------------------------------------------------------------------

export interface PaywallConfig {
  /** ZEC amount to charge per request (e.g. 0.001) */
  amount: number;

  /** Your Zcash Unified Address (payment destination) */
  address: string;

  /** CipherPay API key (cpay_sk_...) for payment verification */
  apiKey: string;

  /** CipherPay facilitator URL. Defaults to https://api.cipherpay.app */
  facilitatorUrl?: string;

  /** Network identifier. Defaults to zcash:mainnet */
  network?: string;

  /** Custom description shown in the 402 response */
  description?: string;

  /** Max seconds to wait for verification. Defaults to 120 */
  maxTimeoutSeconds?: number;

  /**
   * Which payment protocol(s) to advertise in 402 responses.
   * - "x402": x402 JSON body + PAYMENT-SIGNATURE header (default)
   * - "mpp": WWW-Authenticate: Payment header + Authorization: Payment credential
   * - "both": advertise both protocols simultaneously
   *
   * Incoming credentials are always accepted from either protocol regardless
   * of this setting.
   */
  protocol?: 'x402' | 'mpp' | 'both';

  /**
   * Reject payments that have already been verified (replay protection).
   * Defaults to true. Set to false for idempotent retry patterns or
   * session-based access where one payment covers multiple requests.
   */
  rejectReplays?: boolean;

  /**
   * Dynamic pricing — if provided, overrides the static `amount` field.
   */
  getAmount?: (req: GenericRequest) => number | Promise<number>;

  /**
   * How long a 402 challenge remains valid (in seconds). Defaults to 300 (5 minutes).
   * After this, agents should request a fresh challenge to get current pricing.
   */
  challengeTimeoutSeconds?: number;
}

// ---------------------------------------------------------------------------
// MPP (Machine Payments Protocol) types
// ---------------------------------------------------------------------------

export interface MppCharge {
  amount: string;
  currency: string;
  recipient?: string;
  description?: string;
}

export interface MppCredential {
  id: string;
  method: string;
  payload: { txid: string };
}

// ---------------------------------------------------------------------------
// CipherPay facilitator verify response
// ---------------------------------------------------------------------------

export interface VerifyResponse {
  valid: boolean;
  received_zec: number;
  received_zatoshis: number;
  previously_verified: boolean;
  reason?: string;
}

export interface SessionValidateResponse {
  valid: boolean;
  session_id?: string;
  balance_remaining?: number;
  requests_made?: number;
  reason?: string;
}

export interface SessionDeductResponse {
  valid: boolean;
  session_id?: string;
  balance_remaining?: number;
  deducted?: number;
  reason?: string;
}

export interface SessionPrepareResponse {
  session_request_id: string;
  deposit_address: string;
  merchant_id: string;
  min_deposit_zatoshis: number;
  expires_in_seconds: number;
}

export interface WellKnownPayment {
  version: string;
  methods: string[];
  currencies: string[];
  network: string;
  protocols: string[];
  capabilities: {
    sessions: boolean;
    streaming: boolean;
    replay_protection: boolean;
  };
  facilitator: string;
  documentation: string;
}

// ---------------------------------------------------------------------------
// Framework-agnostic request/response
// ---------------------------------------------------------------------------

export interface GenericRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
}

export interface GenericResponse {
  status(code: number): GenericResponse;
  json(body: unknown): void;
  setHeader(name: string, value: string): void;
}

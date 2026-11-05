// ---------------------------------------------------------------------------
// x402 v2 Protocol Types (aligned with coinbase/x402 spec)
// ---------------------------------------------------------------------------

const ZATOSHIS_PER_ZEC = 100_000_000;

/** Convert a decimal ZEC price exactly; never round a sub-zatoshi price. */
export function zecToZatoshis(zec: number): string {
  if (!Number.isFinite(zec) || zec <= 0 || zec > 21_000_000) throw new Error('Price must be positive and within the ZEC supply');
  const [coefficient, exponent = '0'] = zec.toString().toLowerCase().split('e');
  const [whole, fraction = ''] = coefficient.split('.');
  const digits = BigInt(whole + fraction);
  const scale = 8 + Number(exponent) - fraction.length;
  if (scale >= 0) return (digits * 10n ** BigInt(scale)).toString();
  const divisor = 10n ** BigInt(-scale);
  if (digits % divisor !== 0n) throw new Error('Price must be representable in whole zatoshis (at most 8 decimal places)');
  return (digits / divisor).toString();
}

export function zatoshisToZec(zatoshis: string): number {
  if (typeof zatoshis !== 'string' || !/^(0|[1-9][0-9]{0,15})$/.test(zatoshis) || BigInt(zatoshis) > 2_100_000_000_000_000n) {
    throw new Error('Invalid zatoshi amount');
  }
  return Number(zatoshis) / ZATOSHIS_PER_ZEC;
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

export interface Extensions {
  [key: string]: { info: unknown; schema: unknown };
}

export interface PaymentRequired {
  x402Version: 2;
  resource: ResourceInfo;
  accepts: PaymentRequirements[];
  validUntil?: string;
  error?: string;
  extensions?: Extensions;
}

export interface PaymentPayload {
  x402Version: 2;
  resource?: ResourceInfo;
  accepted: PaymentRequirements;
  payload: {
    txid: string;
  };
  extensions?: Extensions;
}

export interface SettlementResponse {
  success: boolean;
  transaction: string;
  network: string;
  payer?: string;
  errorReason?: string;
  amount?: string;
  extensions?: Extensions;
  session?: SessionInfo;
}

export interface SessionInfo {
  token: string;
  sessionId: string;
  balanceRemaining: number;
  costPerRequest: number;
  expiresAt: string;
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
   * Legacy V1 replay policy. V2 settlements are always consumed once.
   * Defaults to true. An explicit false only permits legacy V1 facilitators
   * that deliberately return a previously verified payment as valid.
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

  /**
   * Facilitator API version to use for payment verification.
   * - 1: Legacy CipherPay format ({ txid, expected_amount_zec })
   * - 2: x402 V2 spec format ({ x402Version, paymentPayload, paymentRequirements })
   * Defaults to 2.
   */
  facilitatorVersion?: 1 | 2;

  /**
   * Auto-session: if set, successful settlements will auto-create a session.
   * The session token is returned in X-Session-Token response header, and the
   * agent can use it for subsequent requests via Authorization: Bearer cps_...
   */
  autoSession?: {
    /** Cost per request in zatoshis. Defaults to 1000 (0.00001 ZEC). */
    costPerRequest?: number;
    /** Zcash refund address for unused session balance. */
    refundAddress?: string;
  };
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
// CipherPay facilitator verify response (v1 compat)
// ---------------------------------------------------------------------------

export interface VerifyResponse {
  valid: boolean;
  received_zec: number;
  received_zatoshis: number;
  previously_verified: boolean;
  reason?: string;
}

// ---------------------------------------------------------------------------
// x402 V2 spec-compliant facilitator response types
// ---------------------------------------------------------------------------

export interface VerifyResponseV2 {
  isValid: boolean;
  invalidReason?: string;
  payer?: string;
}

export interface SettleResponseV2 {
  /** A cached settlement is not authorization to execute the resource again. */
  replayed?: boolean;
  success: boolean;
  transaction: string;
  network: string;
  payer?: string;
  errorReason?: string;
  amount?: string;
  session?: SessionInfo;
}

export interface SettleSessionConfig {
  costPerRequest?: number;
  refundAddress?: string;
}

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance?: string;
}

export interface SupportedKind {
  x402Version: number;
  scheme: string;
  network: string;
  extra?: Record<string, unknown>;
}

export interface SupportedResponse {
  kinds: SupportedKind[];
  extensions: string[];
  signers: Record<string, string[]>;
}

export interface SessionValidateResponse {
  valid: boolean;
  session_id?: string;
  balance_remaining?: number;
  requests_made?: number;
  /** Exact zatoshi amount atomically deducted for this successful charge. */
  deducted?: number;
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
  /** Express keeps the mounted path here; used for resource binding when present. */
  originalUrl?: string;
  headers: Record<string, string | string[] | undefined>;
}

export interface GenericResponse {
  status(code: number): GenericResponse;
  json(body: unknown): void;
  setHeader(name: string, value: string): void;
}

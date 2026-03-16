/**
 * Configuration for the x402 Zcash paywall middleware.
 */
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

  /**
   * Optional function to extract a custom amount per request.
   * If provided, overrides the static `amount` field.
   */
  getAmount?: (req: GenericRequest) => number | Promise<number>;
}

/**
 * The 402 Payment Required response body sent to clients.
 * Follows the x402 protocol specification.
 */
export interface PaymentRequiredResponse {
  /** x402 protocol version */
  x402Version: 1;

  /** Payment options the client can choose from */
  accepts: PaymentOption[];

  /** Human-readable description */
  description?: string;

  /** Facilitator info for verification */
  facilitator: {
    url: string;
    network: string;
  };
}

export interface PaymentOption {
  /** Blockchain network (CAIP-2 format) */
  network: string;

  /** Token identifier */
  token: string;

  /** Payment amount as string (ZEC) */
  amount: string;

  /** Recipient address */
  address: string;
}

/**
 * CipherPay x402 verify response.
 */
export interface VerifyResponse {
  valid: boolean;
  received_zec: number;
  received_zatoshis: number;
  previously_verified: boolean;
  reason?: string;
}

/**
 * Minimal request interface for framework-agnostic middleware.
 */
export interface GenericRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
}

/**
 * Minimal response interface for framework-agnostic middleware.
 */
export interface GenericResponse {
  status(code: number): GenericResponse;
  json(body: unknown): void;
  setHeader(name: string, value: string): void;
}

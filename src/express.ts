import type { PaywallConfig } from './types.js';
import { createPaywall } from './middleware.js';

/**
 * Express middleware that gates routes behind Zcash shielded payments via x402.
 *
 * @example
 * ```typescript
 * import { zcashPaywall } from '@cipherpay/x402/express';
 *
 * app.use('/api/premium', zcashPaywall({
 *   amount: 0.001,
 *   address: 'u1abc...',
 *   apiKey: process.env.CIPHERPAY_API_KEY!,
 * }));
 * ```
 */
export function zcashPaywall(config: PaywallConfig) {
  const handler = createPaywall(config);

  // Express middleware signature: (req, res, next)
  return function expressPaywall(req: any, res: any, next: any) {
    handler(req, res, next).catch(next);
  };
}

export { zcashPaywall as default };

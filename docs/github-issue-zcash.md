# Feature Request: Add Zcash as a supported network for `exact` scheme

## Summary

Add Zcash shielded payments as a supported network for the `exact` scheme in x402, providing the first **fully private** payment option in the protocol.

## Motivation

Every x402 payment on EVM and Solana is fully public on-chain. Any observer can see:

- Which APIs an agent is paying for
- How much it's spending per request
- How frequently it calls each service
- The agent's wallet balance and full transaction history

For AI agents operating on behalf of humans or businesses, this creates a real-time surveillance trail of operational strategy.

Zcash shielded transactions encrypt sender, receiver, amount, and memo on-chain. Adding Zcash to x402 gives clients a **private payment option** — no observer can link agent activity to payment patterns.

## Proposed Approach

Implement the `exact` scheme on Zcash (`scheme_exact_zcash.md`), following the existing pattern of chain-specific implementations alongside EVM, SVM, SUI, and Stellar.

### How Zcash differs from EVM/SVM

| Aspect | EVM/SVM | Zcash |
|--------|---------|-------|
| Settlement | Facilitator submits/co-signs tx | Client sends on-chain directly |
| Verification | Signature check / tx inspection | Orchard trial decryption |
| Privacy | Fully public | Fully encrypted |
| Gas | Facilitator sponsors | Client pays (~0.00001 ZEC) |
| Token | ERC-20 / SPL | ZEC (native) |

The core `exact` semantics remain the same — a specific amount is transferred for resource access. The mechanism differs because Zcash shielded transactions cannot be constructed off-chain as authorizations.

### Facilitator

**CipherPay** ([cipherpay.app](https://cipherpay.app)) serves as the Zcash facilitator:

- Open-source, non-custodial Zcash payment processor
- Verifies payments via Orchard trial decryption using the recipient's UFVK (viewing key — read-only, cannot spend)
- No settlement endpoint needed (client-driven)
- Source: [github.com/atmospherelabs-dev/cipherpay](https://github.com/atmospherelabs-dev/cipherpay)

### TypeScript Middleware

An npm package (`@cipherpay/x402`) is already built and provides Express middleware for resource servers accepting Zcash x402 payments:

```bash
npm install @cipherpay/x402
```

```typescript
import { zcashPaywall } from '@cipherpay/x402/express';

app.use('/api/premium', zcashPaywall({
  amount: 0.001,
  address: 'u1abc...',
  apiKey: 'cpay_sk_...',
}));
```

## Implementation Plan

1. **PR 1 (Spec)**: `specs/schemes/exact/scheme_exact_zcash.md` — full specification following the existing scheme template
2. **PR 2 (Implementation)**: TypeScript reference implementation in `typescript/packages/mechanisms/zcash/`

## Network Identifiers (CAIP-2)

| Name | CAIP-2 ID |
|------|-----------|
| Zcash mainnet | `zcash:mainnet` |
| Zcash testnet | `zcash:testnet` |

## References

- [CipherPay](https://cipherpay.app) — Zcash payment processor
- [Zcash Protocol](https://z.cash) — Private digital currency
- [@cipherpay/x402](https://www.npmjs.com/package/@cipherpay/x402) — TypeScript middleware
- [x402 Spec](https://x402.org) — Protocol documentation

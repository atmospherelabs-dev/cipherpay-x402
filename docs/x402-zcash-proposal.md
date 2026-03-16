# Proposal: Add Zcash to x402 — `exact` scheme on `zcash:mainnet`

## Summary

Add Zcash as a supported network for the `exact` scheme in x402, enabling fully private AI agent payments via shielded transactions. CipherPay ([cipherpay.app](https://cipherpay.app)) serves as the Zcash facilitator.

## Motivation

Every x402 payment on EVM and Solana chains is fully public — anyone can observe which APIs an agent uses, how often, and how much it spends. For AI agents operating on behalf of humans, this creates a real-time surveillance trail of operational strategy.

Zcash shielded transactions encrypt sender, receiver, amount, and memo on-chain. Adding Zcash to x402 provides the first **private** payment option in the protocol — no observer can link agent activity to payment patterns.

## Network Identifiers (CAIP-2)

| Name | CAIP-2 ID |
|------|-----------|
| Zcash mainnet | `zcash:mainnet` |
| Zcash testnet | `zcash:testnet` |

## How It Works

Zcash implements the `exact` scheme with a client-driven settlement model:

- **Client sends on-chain directly**: The client broadcasts a shielded ZEC transaction before sending the payment header.
- **Trial decryption verification**: The facilitator verifies payments by performing Orchard trial decryption using the recipient's UFVK. This confirms the payment was made without revealing sender identity.
- **Verify-only facilitator**: CipherPay does not handle settlement — the client sends ZEC directly to the recipient's address. CipherPay only answers "did this txid pay the expected amount to this recipient?"

### Flow

```
Client                    Resource Server              CipherPay (Facilitator)
  │                            │                              │
  │  GET /api/data             │                              │
  │───────────────────────────>│                              │
  │                            │                              │
  │  402 Payment Required      │                              │
  │  PAYMENT-REQUIRED: base64  │                              │
  │  { accepts: [{             │                              │
  │      scheme: "exact",      │                              │
  │      network: "zcash:mainnet",                            │
  │      asset: "ZEC",         │                              │
  │      amount: "100000",     │                              │
  │      payTo: "u1..." }]}    │                              │
  │<───────────────────────────│                              │
  │                            │                              │
  │  (sends shielded ZEC       │                              │
  │   on-chain to payTo)       │                              │
  │                            │                              │
  │  GET /api/data             │                              │
  │  PAYMENT-SIGNATURE: base64 │                              │
  │  { payload: {txid:"..."} } │                              │
  │───────────────────────────>│                              │
  │                            │  POST /api/x402/verify       │
  │                            │  { txid, expected_amount }   │
  │                            │─────────────────────────────>│
  │                            │                              │
  │                            │  { valid: true }             │
  │                            │<─────────────────────────────│
  │                            │                              │
  │  200 OK                    │                              │
  │  PAYMENT-RESPONSE: base64  │                              │
  │<───────────────────────────│                              │
```

### Key Differences from Other Chains

| Aspect | EVM (exact) | SVM (exact) | Zcash (exact) |
|--------|-------------|-------------|---------------|
| Authorization | Off-chain EIP-712 signature | Partially-signed tx | On-chain transaction |
| Settlement | Facilitator submits tx | Facilitator co-signs tx | Client sends directly |
| Verification | Signature recovery + simulation | Tx inspection + simulation | Trial decryption |
| Privacy | Fully public | Fully public | Fully encrypted |
| Gas | Facilitator sponsors | Facilitator sponsors | Client pays (~0.00001 ZEC) |
| Token | Any ERC-20 | Any SPL | ZEC (native) |

### PaymentRequirements

```json
{
  "scheme": "exact",
  "network": "zcash:mainnet",
  "asset": "ZEC",
  "amount": "100000",
  "payTo": "u1recipientaddress...",
  "maxTimeoutSeconds": 120,
  "extra": {}
}
```

### PaymentPayload

```json
{
  "x402Version": 2,
  "accepted": {
    "scheme": "exact",
    "network": "zcash:mainnet",
    "asset": "ZEC",
    "amount": "100000",
    "payTo": "u1recipientaddress...",
    "maxTimeoutSeconds": 120,
    "extra": {}
  },
  "payload": {
    "txid": "7f3a9b2c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f"
  }
}
```

## Facilitator: CipherPay

**CipherPay** ([cipherpay.app](https://cipherpay.app)) is an open-source, non-custodial Zcash payment processor built by [Atmosphere Labs](https://github.com/atmospherelabs-dev).

- **Verify endpoint**: `POST https://api.cipherpay.app/api/x402/verify`
- **Auth**: `Authorization: Bearer <api_key>` (merchants register with their UFVK)
- **Verification**: Orchard trial decryption using merchant's viewing key
- **Non-custodial**: CipherPay never holds funds — viewing key is read-only
- **Open source**: [github.com/atmospherelabs-dev/cipherpay](https://github.com/atmospherelabs-dev/cipherpay)

### Server middleware (npm)

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

## Multi-Chain Compatibility

Servers can offer both transparent and private payment options:

```json
{
  "x402Version": 2,
  "resource": { "url": "/api/data" },
  "accepts": [
    {
      "scheme": "exact",
      "network": "eip155:8453",
      "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "amount": "10000",
      "payTo": "0xabc...",
      "maxTimeoutSeconds": 60,
      "extra": { "assetTransferMethod": "eip3009", "name": "USDC", "version": "2" }
    },
    {
      "scheme": "exact",
      "network": "zcash:mainnet",
      "asset": "ZEC",
      "amount": "100000",
      "payTo": "u1abc...",
      "maxTimeoutSeconds": 120,
      "extra": {}
    }
  ]
}
```

Agents with Zcash wallets choose the shielded option for privacy. Agents with only USDC/ETH use the transparent option. The server accepts either.

## Implementation Plan

1. **PR 1 (Spec)**: Add `specs/schemes/exact/scheme_exact_zcash.md`
2. **PR 2 (Implementation)**: TypeScript reference implementation in `typescript/packages/mechanisms/zcash/`
3. **Facilitator listing**: Add CipherPay to the x402 ecosystem/facilitator page

## References

- [x402 Protocol](https://x402.org)
- [CipherPay](https://cipherpay.app)
- [@cipherpay/x402 on npm](https://www.npmjs.com/package/@cipherpay/x402)
- [Zcash Protocol](https://z.cash)
- [CAIP-2 Specification](https://chainagnostic.org/CAIPs/caip-2)

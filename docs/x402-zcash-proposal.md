# Proposal: Add Zcash (Shielded) as a Supported Network in x402

## Summary

Add Zcash as a supported network in the x402 protocol, enabling fully private AI agent payments via shielded transactions. CipherPay ([cipherpay.app](https://cipherpay.app)) serves as the Zcash facilitator.

## Motivation

Every x402 payment on EVM and Solana chains is fully public — anyone can observe which APIs an agent uses, how often, and how much it spends. For AI agents operating on behalf of humans, this creates a real-time surveillance trail of operational strategy.

Zcash shielded transactions encrypt sender, receiver, amount, and memo on-chain. Adding Zcash to x402 provides the first **private** payment option in the protocol — no observer can link agent activity to payment patterns.

## Network Identifiers (CAIP-2)

| Name | CAIP-2 ID | Description |
|------|-----------|-------------|
| `zcash` | `zcash:mainnet` | Zcash mainnet |
| `zcash-testnet` | `zcash:testnet` | Zcash testnet |

## How It Works

Zcash shielded payments work differently from EVM/Solana:

- **No off-chain signatures**: Zcash shielded transactions don't use `transferWithAuthorization` or EIP-3009. The client sends an on-chain transaction directly.
- **Trial decryption verification**: The facilitator verifies payments by performing Orchard trial decryption using the recipient's viewing key (UFVK). This confirms the payment was made without revealing sender identity.
- **Verify-only facilitator**: CipherPay does not handle settlement — the client sends ZEC directly to the recipient's address. CipherPay only answers "did this txid pay the expected amount to this recipient?"

### Flow

```
Client                    Resource Server              CipherPay (Facilitator)
  │                            │                              │
  │  GET /api/data             │                              │
  │───────────────────────────>│                              │
  │                            │                              │
  │  402 Payment Required      │                              │
  │  { accepts: [{             │                              │
  │      network: "zcash:mainnet",                            │
  │      token: "ZEC",         │                              │
  │      amount: "0.001",      │                              │
  │      address: "u1..." }]}  │                              │
  │<───────────────────────────│                              │
  │                            │                              │
  │  (sends shielded ZEC       │                              │
  │   on-chain to u1...)       │                              │
  │                            │                              │
  │  GET /api/data             │                              │
  │  X-PAYMENT: txid=abc123    │                              │
  │───────────────────────────>│                              │
  │                            │  POST /api/x402/verify       │
  │                            │  { txid, expected_amount }   │
  │                            │─────────────────────────────>│
  │                            │                              │
  │                            │  { valid: true,              │
  │                            │    received_zec: 0.001 }     │
  │                            │<─────────────────────────────│
  │                            │                              │
  │  200 OK + data             │                              │
  │<───────────────────────────│                              │
```

### Key Differences from EVM Scheme

| Aspect | EVM (exact) | Zcash (shielded) |
|--------|-------------|-------------------|
| Authorization | Off-chain EIP-712 signature | On-chain transaction |
| Settlement | Facilitator submits tx | Client sends directly |
| Verification | Check on-chain transfer event | Trial decryption of Orchard outputs |
| Privacy | Fully public | Fully encrypted |
| Latency | Instant (signature check) | ~5-10 seconds (mempool propagation) |
| Gas | Facilitator sponsors | Client pays network fee |
| Token | Any EIP-3009 token | ZEC (native) |

### Scheme: `shielded`

We propose a new scheme type `shielded` alongside the existing `exact` scheme:

```typescript
// Resource server route config
const routes = {
  "GET /api/data": {
    accepts: [{
      scheme: "shielded",
      network: "zcash:mainnet",
      token: "ZEC",
      amount: "0.001",
      address: "u1recipientaddress...",
      facilitator: "https://api.cipherpay.app",
    }],
  },
};
```

The `shielded` scheme tells clients that:
1. Payment must be an on-chain shielded transaction (not a signed authorization)
2. The txid should be sent in the `X-PAYMENT` header
3. The facilitator verifies via trial decryption, not on-chain event lookup

## Facilitator: CipherPay

**CipherPay** ([cipherpay.app](https://cipherpay.app)) is an open-source, non-custodial Zcash payment processor built by [Atmosphere Labs](https://github.com/ALabsProducts).

- **Verify endpoint**: `POST https://api.cipherpay.app/api/x402/verify`
- **Auth**: `Authorization: Bearer <api_key>` (merchants register with their UFVK)
- **Verification**: Orchard trial decryption using merchant's viewing key
- **Non-custodial**: CipherPay never holds funds
- **Free**: x402 verification carries no facilitator fee
- **Open source**: [github.com/ALabsProducts/cipherpay](https://github.com/ALabsProducts/cipherpay)

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
  "accepts": [
    {
      "scheme": "exact",
      "network": "eip155:8453",
      "price": "$0.01",
      "payTo": "0xabc..."
    },
    {
      "scheme": "shielded",
      "network": "zcash:mainnet",
      "token": "ZEC",
      "amount": "0.001",
      "address": "u1abc...",
      "facilitator": "https://api.cipherpay.app"
    }
  ]
}
```

Agents with Zcash wallets choose the shielded option for privacy. Agents with only USDC/ETH use the transparent option. The server accepts either.

## Implementation Plan

1. Add `zcash:mainnet` and `zcash:testnet` to the network identifier reference
2. Define the `shielded` scheme type in the x402 spec
3. List CipherPay as a facilitator on the x402 Ecosystem page
4. Add Zcash examples to the x402 documentation

## References

- [x402 Protocol](https://x402.org)
- [CipherPay](https://cipherpay.app)
- [CipherPay x402 SDK](https://github.com/ALabsProducts/cipherpay-x402)
- [Zcash Protocol](https://z.cash)
- [CAIP-2 Specification](https://chainagnostic.org/CAIPs/caip-2)

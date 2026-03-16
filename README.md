# @cipherpay/x402

Accept private Zcash payments on any API via the [x402 protocol](https://x402.org). One middleware. Fully shielded. No buyer data exposed.

CipherPay is the **Zcash facilitator** for x402 — the only way to accept shielded ZEC payments in the HTTP 402 flow.

## Why

Every x402 payment on Base, Solana, or Polygon is public. Anyone can see which APIs an agent is using, how often, and how much it's spending.

Zcash shielded payments make all of that invisible. The buyer (human or AI agent) reveals nothing — no identity, no balance, no transaction history.

## Install

```bash
npm install @cipherpay/x402
```

## Quick Start (Express)

```typescript
import express from 'express';
import { zcashPaywall } from '@cipherpay/x402/express';

const app = express();

app.use('/api/premium', zcashPaywall({
  amount: 0.001,          // ZEC per request
  address: 'u1abc...',    // Your Zcash Unified Address
  apiKey: 'cpay_sk_...',  // CipherPay API key
}));

app.get('/api/premium/data', (req, res) => {
  res.json({ temperature: 18, conditions: 'partly cloudy' });
});

app.listen(3000);
```

## How It Works

x402 v2 protocol flow with Zcash shielded payments:

```
Client                          Your API                    CipherPay
  │                               │                            │
  │  GET /api/premium/data        │                            │
  │──────────────────────────────>│                            │
  │                               │                            │
  │  402 Payment Required         │                            │
  │  PAYMENT-REQUIRED: base64     │                            │
  │  { accepts: [{ scheme:        │                            │
  │    "exact", asset: "ZEC",     │                            │
  │    amount: "100000",          │                            │
  │    payTo: "u1abc..." }] }     │                            │
  │<──────────────────────────────│                            │
  │                               │                            │
  │  (client sends shielded ZEC)  │                            │
  │                               │                            │
  │  GET /api/premium/data        │                            │
  │  PAYMENT-SIGNATURE: base64    │                            │
  │  { payload: { txid: "..." } } │                            │
  │──────────────────────────────>│                            │
  │                               │  POST /api/x402/verify     │
  │                               │───────────────────────────>│
  │                               │                            │
  │                               │  { valid: true }           │
  │                               │<───────────────────────────│
  │                               │                            │
  │  200 OK                       │                            │
  │  PAYMENT-RESPONSE: base64     │                            │
  │<──────────────────────────────│                            │
```

1. Client requests a paid resource.
2. Middleware returns `402` with `PAYMENT-REQUIRED` header (base64-encoded `PaymentRequired`).
3. Client sends shielded ZEC to your address.
4. Client retries with `PAYMENT-SIGNATURE` header (base64-encoded `PaymentPayload` containing `txid`).
5. Middleware verifies via CipherPay's facilitator (trial decryption).
6. If valid, `PAYMENT-RESPONSE` header is set and request proceeds.

## x402 v2 Compatibility

This SDK implements the [x402 v2 protocol](https://github.com/coinbase/x402):

| Feature | x402 Standard | @cipherpay/x402 |
|---------|---------------|-----------------|
| Version | `x402Version: 2` | Supported |
| Request header | `PAYMENT-SIGNATURE` | Supported |
| Response header | `PAYMENT-REQUIRED` | Supported |
| Settlement header | `PAYMENT-RESPONSE` | Supported |
| Scheme | `exact` | `exact` on `zcash:mainnet` |
| Amount format | Smallest denomination | Zatoshis (1 ZEC = 10^8) |
| Legacy `X-PAYMENT` | — | Backward compatible |

## Framework-Agnostic Usage

```typescript
import { createPaywall } from '@cipherpay/x402';

const paywall = createPaywall({
  amount: 0.001,
  address: 'u1abc...',
  apiKey: 'cpay_sk_...',
});

// Use with any framework that has (req, res, next)
server.use('/paid', (req, res, next) => paywall(req, res, next));
```

## Dynamic Pricing

```typescript
import { zcashPaywall } from '@cipherpay/x402/express';

app.use('/api/ai', zcashPaywall({
  address: 'u1abc...',
  apiKey: 'cpay_sk_...',
  amount: 0,
  getAmount: (req) => {
    if (req.url.includes('gpt-4')) return 0.01;
    if (req.url.includes('gpt-3')) return 0.001;
    return 0.0005;
  },
  description: 'AI inference — price varies by model',
}));
```

## Standalone Verification

```typescript
import { verifyPayment } from '@cipherpay/x402';

const result = await verifyPayment(
  '7f3a9b2c...',       // transaction ID
  0.001,               // expected ZEC amount
  'cpay_sk_...',       // CipherPay API key
);

if (result.valid) {
  console.log(`Received ${result.received_zec} ZEC`);
}
```

## Configuration

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `amount` | `number` | Yes* | ZEC amount per request |
| `address` | `string` | Yes | Zcash Unified Address |
| `apiKey` | `string` | Yes | CipherPay API key (`cpay_sk_...`) |
| `facilitatorUrl` | `string` | No | CipherPay URL (default: `https://api.cipherpay.app`) |
| `network` | `string` | No | CAIP-2 identifier (default: `zcash:mainnet`) |
| `description` | `string` | No | Human-readable description in 402 response |
| `maxTimeoutSeconds` | `number` | No | Verification timeout (default: `120`) |
| `getAmount` | `function` | No | Dynamic pricing function (overrides `amount`) |

*Required unless `getAmount` is provided.

## 402 Response Format (x402 v2)

```json
{
  "x402Version": 2,
  "resource": {
    "url": "/api/premium/data",
    "description": "Premium weather data"
  },
  "accepts": [
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

## For AI Agent Developers

AI agents can pay for x402-gated APIs using a shielded Zcash wallet. The agent:

1. Receives a 402 response — decodes `PAYMENT-REQUIRED` header.
2. Sends shielded ZEC to the `payTo` address for the `amount` (in zatoshis).
3. Retries with `PAYMENT-SIGNATURE` header containing base64-encoded `PaymentPayload`.

Every payment is fully encrypted on the Zcash blockchain. No observer can see what API the agent called, how much it paid, or how often.

## Get a CipherPay Account

1. Go to [cipherpay.app](https://cipherpay.app) and register as a merchant.
2. Provide your Zcash Unified Full Viewing Key (read-only, cannot spend funds).
3. Get your API key (`cpay_sk_...`).
4. Use it in the middleware config.

Same account works for both e-commerce (invoices, checkout) and x402 (API monetization).

## Links

- [CipherPay](https://cipherpay.app) — Zcash payment processor
- [x402 Protocol](https://x402.org) — HTTP 402 payment standard
- [Zcash](https://z.cash) — Private digital currency
- [Documentation](https://cipherpay.app/docs) — Full API docs
- [coinbase/x402](https://github.com/coinbase/x402) — Protocol source

## License

MIT — [Atmosphere Labs](https://atmospherelabs.dev)

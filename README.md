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

// Gate premium endpoints behind a ZEC payment
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

```
Client                          Your API                    CipherPay
  │                               │                            │
  │  GET /api/premium/data        │                            │
  │──────────────────────────────>│                            │
  │                               │                            │
  │  402 Payment Required         │                            │
  │  { accepts: [{ token: "ZEC", │                            │
  │    amount: "0.001",           │                            │
  │    address: "u1abc..." }] }   │                            │
  │<──────────────────────────────│                            │
  │                               │                            │
  │  (client sends shielded ZEC)  │                            │
  │                               │                            │
  │  GET /api/premium/data        │                            │
  │  X-PAYMENT: txid=7f3a9b...   │                            │
  │──────────────────────────────>│                            │
  │                               │  POST /api/x402/verify     │
  │                               │───────────────────────────>│
  │                               │                            │
  │                               │  { valid: true }           │
  │                               │<───────────────────────────│
  │                               │                            │
  │  200 OK                       │                            │
  │  { temperature: 18 }          │                            │
  │<──────────────────────────────│                            │
```

1. Client requests a paid resource.
2. Middleware returns `402` with Zcash payment instructions.
3. Client sends shielded ZEC to your address.
4. Client retries with `X-PAYMENT: txid=<transaction_id>`.
5. Middleware verifies via CipherPay's facilitator (trial decryption).
6. If valid, request proceeds. If not, 402 again.

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
  amount: 0, // overridden by getAmount
  getAmount: (req) => {
    // Price by model
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
| `getAmount` | `function` | No | Dynamic pricing function (overrides `amount`) |

*Required unless `getAmount` is provided.

## 402 Response Format

```json
{
  "x402Version": 1,
  "accepts": [
    {
      "network": "zcash:mainnet",
      "token": "ZEC",
      "amount": "0.00100000",
      "address": "u1abc..."
    }
  ],
  "facilitator": {
    "url": "https://api.cipherpay.app",
    "network": "zcash:mainnet"
  }
}
```

## For AI Agent Developers

AI agents can pay for x402-gated APIs using a shielded Zcash wallet. The agent:

1. Discovers the 402 response with payment terms.
2. Sends shielded ZEC to the address.
3. Retries with the txid.

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

## License

MIT — [Atmosphere Labs](https://atmosphere-labs.com)

# @cipherpay/x402

Accept private Zcash payments on any API via x402 and [MPP](https://www.mppstandard.org/) protocols. One middleware. Fully shielded. No buyer data exposed.

CipherPay is the **Zcash facilitator** for agentic payments — the only way to accept shielded ZEC in the HTTP 402 flow.

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

## Protocol Support

The middleware supports **three payment methods** — all handled transparently:

| Method | Header | Use case |
|--------|--------|----------|
| x402 | `PAYMENT-SIGNATURE` | Standard x402 per-request payments |
| MPP | `Authorization: Payment` | Machine Payments Protocol |
| Sessions | `Authorization: Bearer cps_...` | Prepaid credit — pay once, use many times |

By default, the middleware advertises **both** x402 and MPP challenge formats in 402 responses and accepts credentials from either protocol. Sessions are always accepted when a valid bearer token is present.

## How It Works

```
Agent                           Your API                    CipherPay
  │                               │                            │
  │  GET /api/premium/data        │                            │
  │──────────────────────────────>│                            │
  │                               │                            │
  │  402 Payment Required         │                            │
  │  PAYMENT-REQUIRED: base64     │  (x402 challenge)          │
  │  WWW-Authenticate: Payment    │  (MPP challenge)           │
  │<──────────────────────────────│                            │
  │                               │                            │
  │  (agent sends shielded ZEC)   │                            │
  │                               │                            │
  │  GET /api/premium/data        │                            │
  │  Authorization: Payment ...   │  (or PAYMENT-SIGNATURE)    │
  │──────────────────────────────>│                            │
  │                               │  POST /api/x402/verify     │
  │                               │───────────────────────────>│
  │                               │  { valid: true }           │
  │                               │<───────────────────────────│
  │                               │                            │
  │  200 OK                       │                            │
  │<──────────────────────────────│                            │
```

### Session flow (prepaid credit)

```
Agent                           Your API                    CipherPay
  │                               │                            │
  │  POST /api/sessions/open      │                            │
  │  { txid, merchant_id }        │───────────────────────────>│
  │                               │  { bearer_token: cps_... } │
  │<──────────────────────────────│<───────────────────────────│
  │                               │                            │
  │  GET /api/premium/data        │                            │
  │  Authorization: Bearer cps_.. │                            │
  │──────────────────────────────>│  GET /sessions/validate    │
  │                               │───────────────────────────>│
  │                               │  { valid, balance }        │
  │  200 OK                       │<───────────────────────────│
  │  X-Session-Balance: 49000     │                            │
  │<──────────────────────────────│                            │
```

## Replay Protection

By default, the middleware rejects transactions that have already been verified. A replayed txid returns `402` with `"error": "payment_replayed"`.

```typescript
app.use('/api/premium', zcashPaywall({
  amount: 0.001,
  address: 'u1abc...',
  apiKey: 'cpay_sk_...',
  rejectReplays: true,      // default — each txid works once
}));
```

Set `rejectReplays: false` for endpoints where the same transaction should grant repeated access (e.g., downloading a file multiple times after purchase).

## Protocol Compatibility

| Feature | x402 | MPP | Sessions |
|---------|------|-----|----------|
| Challenge header | `PAYMENT-REQUIRED` | `WWW-Authenticate: Payment` | — |
| Credential header | `PAYMENT-SIGNATURE` | `Authorization: Payment` | `Authorization: Bearer cps_...` |
| Settlement header | `PAYMENT-RESPONSE` | `Payment-Receipt` | `X-Session-Balance` |
| Replay protection | Yes | Yes | N/A (balance-based) |
| Per-request cost | Full amount | Full amount | `cost_per_request` from session |

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
| `protocol` | `'x402' \| 'mpp' \| 'both'` | No | Which challenge format(s) to advertise (default: `'both'`) |
| `rejectReplays` | `boolean` | No | Reject previously-verified txids (default: `true`) |

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

AI agents can pay for gated APIs using a shielded Zcash wallet. Three options:

**Per-request (x402 or MPP):** Agent receives a 402, sends shielded ZEC, retries with the txid. Simple, one payment per request.

**Sessions (prepaid credit):** Agent sends a deposit transaction, receives a bearer token (`cps_...`), and uses it for subsequent requests. Balance is deducted automatically. Best for high-frequency API usage.

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

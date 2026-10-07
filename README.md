# CX Pay workbench sample

A thin, server-rendered dashboard over the CX Pay API for your **test** account. See your payments, capture, cancel and refund them, create payment links, and watch signed webhooks arrive. One small Node.js server, plain HTML and one CSS file. No dependencies, bundler or frontend framework. **Test mode only.**

[CX Pay documentation](https://docs.cxpaygo.com/) · [Request authentication](https://docs.cxpaygo.com/docs/authentication) · [Verify webhook signatures](https://docs.cxpaygo.com/docs/verifying-webhooks)

It also shows a complete server-side integration: HMAC request signing, cursor pagination, `Idempotency-Key` on every write, and raw-body webhook verification.

## Quickstart

You need:

- **Node.js 22.9 or newer**; tested with Node.js 22.23.
- A CX Pay **test** API key ID (`ak_test_…`) and its Base64 signing secret. A full-access key works. For a restricted key, grant `payments:read`, `payments:capture`, `payments:cancel`, `payments:refund`, `payment_links:read`, `payment_links:create` and `payment_links:update`.
- An HTTPS tunnel to **`127.0.0.1:4242`**, such as [ngrok](https://ngrok.com/). CX Pay must reach your webhook receiver, and payers must reach your return page.

### 1. Clone and configure

```sh
git clone https://github.com/CXPay-Global/workbench-sample.git
cd workbench-sample
cp .env.example .env
chmod 600 .env
```

On Windows, copy `.env.example` to `.env` and omit the `chmod` command.

Edit `.env`: replace `CXPAY_KEY_ID` and `CXPAY_API_SECRET` with your **test** credentials. Leave `CXPAY_WEBHOOK_SECRET` empty for now; CX Pay sends it to you in step 4. Never commit `.env`.

### 2. Start an HTTPS tunnel

If ngrok is installed and authenticated, run this in a separate terminal:

```sh
ngrok http http://127.0.0.1:4242
```

Keep it running. Copy its HTTPS origin into `.env`:

```dotenv
CXPAY_PUBLIC_ORIGIN=https://your-tunnel.example
```

Use the **exact origin, with no trailing slash or path**. A free ngrok URL changes every time ngrok restarts; a reserved domain keeps it stable. If it changes, update `.env`, restart, and send CX Pay the new URLs.

### 3. Start the portal

```sh
npm start
```

Open **http://localhost:4242** on the same machine. The overview checks your credentials with `GET /v1/me` and shows the account your key belongs to.

The portal refuses to start with a live key or a malformed secret, and tells you which setting to fix.

### 4. Send CX Pay your URLs

The overview's **Send these to CX Pay** section lists three values. Email them to your CX Pay contact:

| Value       | Example                                         | What CX Pay does with it                                                                                                  |
| ----------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Account ID  | `morg_…`                                        | Identifies the test account to configure.                                                                                  |
| Return URL  | `https://your-tunnel.example/return`            | Allows your tunnel's domain as a return destination, so payment links can send payers back to you.                        |
| Webhook URL | `https://your-tunnel.example/webhooks/cxpay`    | Registers a test-mode webhook endpoint and replies with its signing secret (`whsec_…`).                                   |

### 5. Add the webhook secret

Put the signing secret CX Pay sends you in `.env` and restart:

```dotenv
CXPAY_WEBHOOK_SECRET=whsec_…
```

Deliveries then appear under **Webhook events**. Until the secret is set, the receiver answers `503` and CX Pay retries.

`npm run dev` restarts the server whenever you edit a file. There is no install or build step.

## Configuration

All settings live in `.env`, which is read only by the server and never served to the browser.

| Setting                | Required | Purpose                                                                                                     |
| ---------------------- | -------- | ----------------------------------------------------------------------------------------------------------- |
| `CXPAY_KEY_ID`         | Yes      | `ak_test_…` API key ID. Live keys are refused.                                                               |
| `CXPAY_API_SECRET`     | Yes      | The 32-byte, Base64-encoded signing secret issued with that key.                                            |
| `CXPAY_PUBLIC_ORIGIN`  | Yes      | Your tunnel's HTTPS origin. The return URL and webhook URL are derived from it. Default `http://localhost:4242`, which CX Pay cannot reach. |
| `CXPAY_WEBHOOK_SECRET` | Later    | The webhook endpoint signing secret from CX Pay, used as UTF-8.                                              |
| `CXPAY_API_BASE_URL`   | No       | CX Pay's API URL, including any stage and a trailing `/`. Default `https://api.cxpay.net/`.                  |
| `PORT`                 | No       | Local port. Default `4242`. Change the tunnel's target port to match.                                       |

Restart after changing `.env`. No account ID is configured: the API derives the account and test mode from the key.

## What the portal does

| Page                         | CX Pay API calls                                                                                                  |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| **Overview** `/`             | `GET /v1/me`. Shows your account, the URLs to send CX Pay, and the five most recent webhook events.               |
| **Payments** `/payments`     | `GET /v1/payment-intents`, 20 per page, with a status filter and cursor pagination.                              |
| **Payment** `/payments/{id}` | `GET /v1/payment-intents/{id}`, plus the action its status allows: `POST …/capture` (`requires_capture`), `POST …/cancel` (not yet captured), `POST …/refund` (`succeeded`). Amounts are optional and in minor units; blank means the full amount. |
| **Payment links**            | `GET /v1/payment-links` with cursor pagination, and `POST /v1/payment-links` to create a fixed or open-amount link. The redirect URL defaults to your return URL. |
| **Payment link**             | `GET /v1/payment-links/{id}`, and `PATCH` with `active: false` or `true` to deactivate or reactivate it.          |
| **Webhook events** `/events` | No API call. The verified deliveries this server has received.                                                    |

Every page shows CX Pay's error code, message and correlation ID when a call fails. Quote the correlation ID to CX Pay support. A 401 or 403 with no code usually means the key ID, secret, API URL or scopes are wrong.

**Payments made through a Checkout Session or payment link** are canceled through their session. CX Pay refuses a direct cancel of those, and the portal shows that refusal.

## Who can reach what

The tunnel makes this server public, so the portal splits it in two:

| Reached through          | Answers                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------- |
| `http://localhost:4242`  | Everything: the dashboard, its forms, the return page and the webhook receiver.             |
| The tunnel               | Only `POST /webhooks/cxpay` and `GET /return`. Every dashboard page answers `404`.          |

A request counts as local only when its `Host` is `localhost`, `127.0.0.1` or `[::1]` on your port and it carries no `X-Forwarded-For`, `X-Forwarded-Host` or `Forwarded` header. Tunnels add those headers, so a tunnel that rewrites `Host` is still treated as public. Dashboard forms are also refused unless their `Origin` is the portal itself, so another website cannot post to them from your browser.

The server binds to `127.0.0.1` only. API credentials never reach the browser.

## Writes and idempotency

Every write sends an `Idempotency-Key`. Each form is rendered with its own key in a hidden field, so a double click or a browser resubmit replays the original request instead of repeating it.

If CX Pay **definitely rejects** a request (a 4xx), the form comes back with a new key so you can correct it. If the outcome is **unknown** (no response, a timeout, `202` or a 5xx), the form keeps the same key. Reload the payment first: a refund may already have happened. Resubmitting with the same key is safe within CX Pay's 24-hour idempotency window.

## Webhooks

`lib/webhook.mjs` verifies `X-CXPay-Signature: t=SECONDS,v1=HEX`: HMAC-SHA256 over the timestamp, a period and the raw body bytes, keyed with the webhook secret as UTF-8. It rejects signatures more than five minutes off, malformed headers and changed bodies. It verifies before parsing JSON and ignores the other `X-CXPay-*` headers. This differs from API request signing, which Base64-decodes its secret.

A verified event is acknowledged with `200` and summarized in `.data/events.json`: event ID, type, object ID, test/live flag and receipt time. The last 100 are kept and duplicate event IDs are recorded once. Full payloads are not stored.

**This is a viewer, not a fulfillment system.** For real order fulfillment, deduplicate the event and apply its effect in one database transaction, and re-read the object from the API before trusting it.

## Checks and limits

```sh
npm run check
npm test
```

The dependency-free tests cover HMAC signing with and without a query, stage-free signing paths, `Idempotency-Key` on writes, error and live-data handling, credential validation, webhook tampering and timing, local-only dashboard access, cross-site form refusal, HTML escaping of API data, and that API failures render a page instead of crashing. They use a fake API; they do not prove your account's configuration.

This is a **single-user local tool**. It has no login: anyone who can open `http://localhost:4242` on your machine can refund your test payments. Do not deploy it, expose the dashboard through the tunnel, or point it at a live key.

## Troubleshooting

| Symptom                                           | Check                                                                                                                       |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `The portal did not start`                        | Read the listed settings. Live keys, a secret that isn't 32 Base64-encoded bytes, and a non-HTTPS public origin are refused. |
| `HTTP 403` or `401` with no error code            | The key ID, secret or API URL is wrong, or the key is revoked. Copy the secret again without spaces.                        |
| `INSUFFICIENT_PERMISSIONS` on one page or action  | The key is restricted. Add the scope listed in the Quickstart.                                                              |
| The dashboard returns `404` through the tunnel    | That is deliberate. Open `http://localhost:4242`.                                                                           |
| Webhooks never arrive                             | Keep ngrok and `npm start` running. Confirm CX Pay registered the current tunnel URL. ngrok's own inspector (`http://127.0.0.1:4040`) shows each delivery. |
| Deliveries get `503`                              | `CXPAY_WEBHOOK_SECRET` is empty. Add it and restart.                                                                        |
| Deliveries get `401`                              | The secret does not match the endpoint, or your clock is more than five minutes off.                                        |
| Payers see an ngrok warning page before `/return` | Free ngrok domains show it to browsers. It does not affect webhooks.                                                        |

## Documentation

| Guide                                                                                | What it covers                                                     |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| [CX Pay documentation](https://docs.cxpaygo.com/)                                    | Guides and API reference.                                          |
| [Authentication](https://docs.cxpaygo.com/docs/authentication)                       | HMAC headers, the canonical signing string, timestamps and nonces. |
| [Webhooks](https://docs.cxpaygo.com/docs/webhooks)                                   | Event delivery, endpoints and retries.                             |
| [Verify webhook signatures](https://docs.cxpaygo.com/docs/verifying-webhooks)        | Raw-body signature verification and event deduplication.           |
| [Declines and card testing](https://docs.cxpaygo.com/docs/declines-and-card-testing) | Test cards for creating payments to try the portal on.             |

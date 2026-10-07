import { randomUUID } from "node:crypto";
import { html, layout, money, date, status, apiError, notice, fields, rawJson } from "./html.mjs";

export const PAYMENT_STATUSES = [
  "requires_payment_method",
  "requires_confirmation",
  "requires_action",
  "processing",
  "uncertain",
  "requires_capture",
  "succeeded",
  "canceled",
  "expired",
  "requires_review",
];

const CANCELABLE = new Set([
  "requires_payment_method",
  "requires_confirmation",
  "requires_action",
  "requires_capture",
]);

// Each rendered form carries its own Idempotency-Key, so a double submit or a
// browser resubmit replays the same request instead of repeating it.
function keyInput(key = randomUUID()) {
  return html`<input type="hidden" name="idempotency_key" value="${key}">`;
}

function pager(basePath, query, nextCursor) {
  const first = new URLSearchParams(query);
  first.delete("cursor");
  const next = new URLSearchParams(first);
  if (nextCursor) next.set("cursor", nextCursor);
  return html`<p class="pager">
  ${query.cursor ? html`<a href="${basePath}?${first}">← First page</a>` : ""}
  ${nextCursor ? html`<a href="${basePath}?${next}">Next page →</a>` : ""}
</p>`;
}

function eventObjectLink(event) {
  if (!event.objectId) return "—";
  if (event.objectId.startsWith("pi_"))
    return html`<a href="/payments/${event.objectId}">${event.objectId}</a>`;
  if (event.type.startsWith("payment_link."))
    return html`<a href="/payment-links/${event.objectId}">${event.objectId}</a>`;
  return html`<code>${event.objectId}</code>`;
}

function eventsTable(events) {
  if (!events.length) return html`<p class="muted">No webhook events received yet.</p>`;
  return html`<table>
<thead><tr><th>Received</th><th>Type</th><th>Object</th><th>Event ID</th><th>Mode</th></tr></thead>
<tbody>${events.map(
    (e) => html`<tr>
  <td>${date(e.receivedAt)}</td><td><code>${e.type}</code></td><td>${eventObjectLink(e)}</td>
  <td><code>${e.id}</code></td><td>${e.livemode ? "live" : "test"}</td>
</tr>`,
  )}</tbody>
</table>`;
}

export function overviewPage({ config, me, error, events }) {
  const body = html`
<section>
  <h2>Connection</h2>
  ${error
    ? apiError(error)
    : fields([
        ["Account", html`<code>${me.merchantOrgId}</code>`],
        ["Business", me.business?.name],
        ["API key", html`<code>${me.keyId}</code>`],
        [
          "Key scopes",
          me.scopes?.length ? me.scopes.join(", ") : "Unrestricted (full access)",
        ],
      ])}
</section>

<section class="send">
  <h2>Send these to CX Pay</h2>
  ${config.tunnelConfigured
    ? ""
    : html`<div class="warning">CXPAY_PUBLIC_ORIGIN is not set to an HTTPS tunnel, so the URLs below point at
      your own machine and CX Pay cannot reach them. Start your tunnel, set its origin in <code>.env</code>,
      and restart.</div>`}
  <p>Email these to your CX Pay contact. They register them on your test account.</p>
  ${fields([
    ["Account ID", me ? html`<code>${me.merchantOrgId}</code>` : "Shown once the connection works."],
    ["Return URL", html`<code class="copy">${config.returnUrl}</code>`],
    ["Webhook URL", html`<code class="copy">${config.webhookUrl}</code>`],
  ])}
  <ul>
    <li><strong>Return URL:</strong> CX Pay allows your tunnel's domain as a return destination. Payers land on it
      after paying through a payment link that uses it.</li>
    <li><strong>Webhook URL:</strong> CX Pay registers it as a test-mode webhook endpoint for
      <code>payment_intent.*</code>, <code>charge.*</code>, <code>refund.*</code> and <code>payment_link.*</code>
      events, then sends you the endpoint's signing secret (<code>whsec_…</code>). Put it in
      <code>CXPAY_WEBHOOK_SECRET</code> in <code>.env</code> and restart.</li>
  </ul>
  <p>Webhook signing secret:
    ${config.webhookSecret
      ? html`<strong>configured</strong>.`
      : html`<strong>not set</strong>. The receiver rejects deliveries until it is.`}</p>
  <p class="muted">Tunnel URLs change when ngrok restarts unless you use a reserved domain. Send the new URLs if yours change.</p>
</section>

<section>
  <h2>Recent webhook events</h2>
  ${eventsTable(events.slice(0, 5))}
  <p><a href="/events">All received events →</a></p>
</section>`;
  return layout({ title: "Overview", active: "/", body, config });
}

export function paymentsPage({ config, result, error, query }) {
  const body = html`
<form method="get" action="/payments" class="filters">
  <label>Status
    <select name="status">
      <option value="">Any</option>
      ${PAYMENT_STATUSES.map(
        (s) => html`<option value="${s}"${query.status === s ? html` selected` : ""}>${s}</option>`,
      )}
    </select>
  </label>
  <button type="submit">Filter</button>
</form>
${error
  ? apiError(error)
  : result.data.length === 0
    ? html`<p class="muted">No payments found.</p>`
    : html`<table>
<thead><tr><th>Payment</th><th class="num">Amount</th><th>Status</th><th>Description</th><th>Created</th></tr></thead>
<tbody>${result.data.map(
        (pi) => html`<tr>
  <td><a href="/payments/${pi.id}">${pi.id}</a></td>
  <td class="num">${money(pi.amount, pi.currency)}</td>
  <td>${status(pi.status)}</td>
  <td>${pi.description}</td>
  <td>${date(pi.created_at)}</td>
</tr>`,
      )}</tbody>
</table>`}
${error ? "" : pager("/payments", query, result.next_cursor)}`;
  return layout({ title: "Payments", active: "/payments", body, config });
}

const AMOUNT_HINT = "Minor units, e.g. 1050 for 10.50. Leave blank for the full amount.";

export function paymentPage({ config, pi, error, message, actionError, retry = {} }) {
  if (!pi)
    return layout({ title: "Payment", active: "/payments", body: apiError(error), config });
  const err = pi.last_payment_error;
  const body = html`
${notice(message)}
${actionError ? apiError(actionError) : ""}
${fields([
  ["ID", html`<code>${pi.id}</code>`],
  ["Status", status(pi.status)],
  ["Amount", money(pi.amount, pi.currency)],
  ["Description", pi.description],
  ["Created", date(pi.created_at)],
  ["Latest charge", pi.latest_charge && html`<code>${pi.latest_charge}</code>`],
  ["Customer", pi.customer && html`<code>${pi.customer}</code>`],
  ["Last payment error", err && `${err.code}: ${err.message}`],
  ["Cancellation reason", pi.cancellation_reason],
  ["Expires", pi.expires_at && date(pi.expires_at)],
  ["Mode", pi.livemode ? "live" : "test"],
])}

${pi.status === "requires_capture"
  ? html`<section>
  <h2>Capture</h2>
  <form method="post" action="/payments/${pi.id}/capture">
    ${keyInput(retry.capture)}
    <label>Amount to capture <input name="amount_to_capture" inputmode="numeric" pattern="[0-9]*"></label>
    <small>${AMOUNT_HINT} The rest of the authorization is released.</small>
    <button type="submit">Capture</button>
  </form>
</section>`
  : ""}

${CANCELABLE.has(pi.status)
  ? html`<section>
  <h2>Cancel</h2>
  <form method="post" action="/payments/${pi.id}/cancel">
    ${keyInput(retry.cancel)}
    <label>Reason (optional) <input name="cancellation_reason" maxlength="255"></label>
    <small>Payments created by a Checkout Session or payment link are canceled through their session, so CX Pay may refuse this.</small>
    <button type="submit" class="danger">Cancel payment</button>
  </form>
</section>`
  : ""}

${pi.status === "succeeded"
  ? html`<section>
  <h2>Refund</h2>
  <form method="post" action="/payments/${pi.id}/refund">
    ${keyInput(retry.refund)}
    <label>Amount <input name="amount" inputmode="numeric" pattern="[0-9]*"></label>
    <small>${AMOUNT_HINT}</small>
    <label>Reason
      <select name="reason">
        <option value="">None</option>
        <option value="requested_by_customer">Requested by customer</option>
        <option value="duplicate">Duplicate</option>
        <option value="fraudulent">Fraudulent</option>
      </select>
    </label>
    <button type="submit" class="danger">Refund</button>
  </form>
  <p class="muted">Subscribe to <code>refund.*</code> webhooks to keep a record of refunds.</p>
</section>`
  : ""}

${rawJson(pi)}`;
  return layout({ title: `Payment ${pi.id}`, active: "/payments", body, config });
}

function linkForm(config, values = {}, key) {
  const v = {
    type: "fixed",
    currency: "USD",
    redirect_url: config.tunnelConfigured ? config.returnUrl : "",
    ...values,
  };
  return html`<form method="post" action="/payment-links" class="stack">
  ${keyInput(key)}
  <label>Type
    <select name="type">
      <option value="fixed"${v.type === "fixed" ? html` selected` : ""}>Fixed amount</option>
      <option value="open"${v.type === "open" ? html` selected` : ""}>Open (payer enters the amount)</option>
    </select>
  </label>
  <label>Amount <input name="amount" inputmode="numeric" pattern="[0-9]*" value="${v.amount}"></label>
  <small>Minor units, e.g. 2500 for 25.00. Required for fixed links.</small>
  <label>Currency <input name="currency" maxlength="3" value="${v.currency}" required></label>
  <label>Description <input name="description" maxlength="500" value="${v.description}"></label>
  <label>Redirect URL <input name="redirect_url" type="url" value="${v.redirect_url}"></label>
  <small>Where payers go after paying. Defaults to your return URL. CX Pay checks its domain when a payer opens the link, so register it first or leave this blank.</small>
  <label>Maximum uses <input name="max_uses" inputmode="numeric" pattern="[0-9]*" value="${v.max_uses}"></label>
  <button type="submit">Create payment link</button>
</form>`;
}

export function paymentLinksPage({ config, result, error, query, form = {} }) {
  const body = html`
<section>
  <h2>Create a payment link</h2>
  ${form.error ? apiError(form.error) : ""}
  ${linkForm(config, form.values, form.key)}
</section>
<section>
  <h2>Your payment links</h2>
  ${error
    ? apiError(error)
    : result.data.length === 0
      ? html`<p class="muted">No payment links yet.</p>`
      : html`<table>
<thead><tr><th>Link</th><th class="num">Amount</th><th>Status</th><th class="num">Checkouts</th><th>Created</th></tr></thead>
<tbody>${result.data.map(
          (link) => html`<tr>
  <td><a href="/payment-links/${link.id}">${link.description || link.id}</a></td>
  <td class="num">${link.type === "open" ? `Open (${link.currency})` : money(link.amount, link.currency)}</td>
  <td>${status(link.status)}</td>
  <td class="num">${link.times_completed} paid / ${link.times_used} started</td>
  <td>${date(link.created_at)}</td>
</tr>`,
        )}</tbody>
</table>`}
  ${error ? "" : pager("/payment-links", query, result.next_cursor)}
</section>`;
  return layout({ title: "Payment links", active: "/payment-links", body, config });
}

export function paymentLinkPage({ config, link, error, message, actionError, retryKey }) {
  if (!link)
    return layout({ title: "Payment link", active: "/payment-links", body: apiError(error), config });
  const toggle =
    link.status === "active" ? false : link.status === "inactive" ? true : null;
  const body = html`
${notice(message)}
${actionError ? apiError(actionError) : ""}
${fields([
  ["ID", html`<code>${link.id}</code>`],
  ["Status", status(link.status)],
  ["URL", html`<a href="${link.url}" target="_blank" rel="noopener">${link.url}</a>`],
  ["QR code", link.qr_code_url && html`<a href="${link.qr_code_url}" target="_blank" rel="noopener">Open QR code</a>`],
  ["Type", link.type],
  ["Amount", link.type === "open" ? `Payer enters it (${link.currency})` : money(link.amount, link.currency)],
  ["Description", link.description],
  ["Redirect URL", link.redirect_url],
  ["Reusable", link.recurring ? "Yes" : "No, single use"],
  ["Uses", `${link.times_completed} paid / ${link.times_used} started${link.max_uses ? ` (max ${link.max_uses})` : ""}`],
  ["Expires", link.expires_at && date(link.expires_at)],
  ["Created", date(link.created_at)],
  ["Mode", link.livemode ? "live" : "test"],
])}
${toggle === null
  ? ""
  : html`<form method="post" action="/payment-links/${link.id}/active">
  ${keyInput(retryKey)}
  <input type="hidden" name="active" value="${String(toggle)}">
  <button type="submit"${toggle ? "" : html` class="danger"`}>${toggle ? "Activate link" : "Deactivate link"}</button>
</form>`}
${rawJson(link)}`;
  return layout({ title: link.description || "Payment link", active: "/payment-links", body, config });
}

export function eventsPage({ config, events }) {
  const body = html`
<p>Verified deliveries to <code>${config.webhookUrl}</code>, newest first. The portal keeps a summary of the
  last 100 in <code>.data/events.json</code>.</p>
${config.webhookSecret
  ? ""
  : html`<div class="warning">CXPAY_WEBHOOK_SECRET is not set, so every delivery is rejected. Add the
    signing secret CX Pay sent you to <code>.env</code> and restart.</div>`}
${eventsTable(events)}`;
  return layout({ title: "Webhook events", active: "/events", body, config });
}

export function returnPage() {
  return html`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Thank you</title><link rel="stylesheet" href="/style.css"></head>
<body><main class="narrow">
<h1>Thank you</h1>
<p>You are back with the merchant. They confirm your payment separately; you can close this tab.</p>
<p class="muted">Test mode. No real payment was taken.</p>
</main></body>
</html>`;
}

export function messagePage(title, text) {
  return html`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${title}</title><link rel="stylesheet" href="/style.css"></head>
<body><main class="narrow"><h1>${title}</h1><p>${text}</p></main></body>
</html>`;
}

// A tagged template that escapes every interpolated value unless it is
// itself an html`` fragment. Arrays are joined.
class Html {
  constructor(text) {
    this.text = text;
  }
  toString() {
    return this.text;
  }
}

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

function render(value) {
  if (value instanceof Html) return value.text;
  if (Array.isArray(value)) return value.map(render).join("");
  if (value === null || value === undefined || value === false) return "";
  return String(value).replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

export function html(strings, ...values) {
  return new Html(
    strings.reduce((out, string, i) => out + render(values[i - 1]) + string),
  );
}

export function money(amount, currency) {
  if (!Number.isInteger(amount)) return "—";
  try {
    const format = new Intl.NumberFormat("en-US", { style: "currency", currency });
    const digits = format.resolvedOptions().maximumFractionDigits;
    return format.format(amount / 10 ** digits);
  } catch {
    return `${amount} ${currency ?? ""}`.trim();
  }
}

export function date(value) {
  const parsed = new Date(value);
  if (!value || Number.isNaN(parsed.getTime())) return "—";
  return `${parsed.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export function status(value) {
  return html`<span class="status status-${String(value).replace(/[^a-z_]/g, "")}">${value}</span>`;
}

export function layout({ title, active, body, config }) {
  const nav = [
    ["/", "Overview"],
    ["/payments", "Payments"],
    ["/payment-links", "Payment links"],
    ["/events", "Webhook events"],
  ];
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${title} · CX Pay test portal</title>
<link rel="stylesheet" href="/style.css">
</head>
<body>
<header>
  <a class="brand" href="/">CX Pay portal</a>
  <span class="badge">Test mode</span>
  <nav>${nav.map(
    ([href, label]) =>
      html`<a href="${href}"${active === href ? html` aria-current="page"` : ""}>${label}</a>`,
  )}</nav>
</header>
<main>
<h1>${title}</h1>
${body}
</main>
<footer>Key ${config.keyId} · ${config.apiBaseUrl}</footer>
</body>
</html>`;
}

export function apiError(error) {
  return html`<div class="error">
  <strong>${error.code}</strong>${error.status ? ` (HTTP ${error.status})` : ""}: ${error.message}
  ${error.correlationId ? html`<br><small>Correlation ID: <code>${error.correlationId}</code>. Quote it to CX Pay support.</small>` : ""}
</div>`;
}

export function notice(text) {
  return text ? html`<div class="notice">${text}</div>` : "";
}

export function fields(rows) {
  return html`<dl class="fields">${rows.map(
    ([label, value]) => html`<dt>${label}</dt><dd>${value ?? "—"}</dd>`,
  )}</dl>`;
}

export function rawJson(object) {
  return html`<details><summary>Raw JSON</summary><pre>${JSON.stringify(object, null, 2)}</pre></details>`;
}

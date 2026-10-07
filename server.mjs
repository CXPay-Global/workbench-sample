import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { readConfig } from "./lib/config.mjs";
import { createClient, ApiError } from "./lib/cxpay.mjs";
import { money } from "./lib/html.mjs";
import { verifyWebhook } from "./lib/webhook.mjs";
import { createEventLog } from "./lib/events.mjs";
import {
  overviewPage,
  paymentsPage,
  paymentPage,
  paymentLinksPage,
  paymentLinkPage,
  eventsPage,
  returnPage,
  messagePage,
} from "./lib/pages.mjs";

const root = fileURLToPath(new URL(".", import.meta.url));
const css = readFileSync(join(root, "public", "style.css"));
const ID = "[A-Za-z0-9_]+";
const KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function readBody(req, limit) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > limit) throw new HttpError(413, "Request body is too large.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function optionalAmount(value, name) {
  if (!value) return undefined;
  if (!/^[0-9]{1,12}$/.test(value) || Number(value) < 1)
    throw new HttpError(400, `${name} must be a whole number of minor units, at least 1.`);
  return Number(value);
}

// Network loss, 202 and 5xx leave the outcome unknown: keep the same key so a
// retry replays the original request. A definite rejection gets a fresh key.
function retryKeyFor(error, key) {
  return error.status === 0 || error.status === 202 || error.status >= 500
    ? key
    : randomUUID();
}

export function createApp({
  env = process.env,
  fetchImpl = fetch,
  dataDirectory = join(root, ".data"),
} = {}) {
  const { config, issues } = readConfig(env);
  if (issues.length) throw new Error(issues.join("\n"));
  const cxpay = createClient(config, fetchImpl);
  const events = createEventLog(join(dataDirectory, "events.json"));
  const localHosts = new Set(
    ["localhost", "127.0.0.1", "[::1]"].map((h) => `${h}:${config.port}`),
  );
  const localOrigins = new Set([...localHosts].map((h) => `http://${h}`));

  // The dashboard is for you only. Through the tunnel the Host header is the
  // tunnel's domain and a forwarding header is present, so only the webhook
  // receiver and the return page answer there.
  function isLocal(req) {
    return (
      localHosts.has(req.headers.host) &&
      !req.headers["x-forwarded-for"] &&
      !req.headers["x-forwarded-host"] &&
      !req.headers.forwarded
    );
  }

  async function readForm(req) {
    if (!localOrigins.has(req.headers.origin))
      throw new HttpError(403, "Form posts must come from this portal's own pages.");
    const form = new URLSearchParams((await readBody(req, 16_384)).toString());
    const key = form.get("idempotency_key") || "";
    if (!KEY.test(key)) throw new HttpError(400, "The form is missing its Idempotency-Key. Reload the page.");
    return { form, key };
  }

  async function attempt(run) {
    try {
      return { value: await run() };
    } catch (e) {
      if (e instanceof ApiError) return { error: e };
      throw e;
    }
  }

  async function paymentAction(id, action, req) {
    const { form, key } = await readForm(req);
    let result;
    try {
      const body =
        action === "capture"
          ? { amount_to_capture: optionalAmount(form.get("amount_to_capture"), "Amount to capture") }
          : action === "refund"
            ? { amount: optionalAmount(form.get("amount"), "Refund amount"), reason: form.get("reason") || undefined }
            : { cancellation_reason: form.get("cancellation_reason")?.trim() || undefined };
      result = await attempt(() =>
        cxpay("POST", `/v1/payment-intents/${id}/${action}`, { body, idempotencyKey: key }),
      );
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      // Nothing was sent, so the same key is still unused.
      result = { error: { code: "INVALID_INPUT", status: 0, message: e.message }, unsent: true };
    }
    const pi = await attempt(() => cxpay("GET", `/v1/payment-intents/${id}`));
    let message = "";
    if (!result.error) {
      const r = result.value;
      message =
        action === "refund"
          ? `Refund ${r.id} created for ${money(r.amount, r.currency)}. Status: ${r.status}.`
          : action === "capture"
            ? "Payment captured."
            : "Payment canceled.";
    }
    return paymentPage({
      config,
      pi: pi.value,
      error: pi.error,
      message,
      actionError: result.error,
      retry: result.error ? { [action]: result.unsent ? key : retryKeyFor(result.error, key) } : {},
    });
  }

  async function createLink(req) {
    const { form, key } = await readForm(req);
    const values = Object.fromEntries(
      ["type", "amount", "currency", "description", "redirect_url", "max_uses"].map((f) => [
        f,
        form.get(f)?.trim() || undefined,
      ]),
    );
    let body;
    try {
      body = {
        type: values.type === "open" ? "open" : "fixed",
        amount: values.type === "open" ? undefined : optionalAmount(values.amount, "Amount"),
        currency: values.currency?.toUpperCase(),
        description: values.description,
        redirect_url: values.redirect_url,
        max_uses: optionalAmount(values.max_uses, "Maximum uses"),
      };
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      return listLinks({}, { values, key, error: { code: "INVALID_INPUT", message: e.message } });
    }
    const result = await attempt(() =>
      cxpay("POST", "/v1/payment-links", { body, idempotencyKey: key }),
    );
    if (result.error)
      return listLinks({}, { values, key: retryKeyFor(result.error, key), error: result.error });
    return paymentLinkPage({ config, link: result.value, message: "Payment link created." });
  }

  async function listLinks(query, form) {
    const result = await attempt(() =>
      cxpay("GET", "/v1/payment-links", { query: { limit: 20, ...query } }),
    );
    return paymentLinksPage({ config, result: result.value, error: result.error, query, form });
  }

  async function toggleLink(id, req) {
    const { form, key } = await readForm(req);
    const active = form.get("active") === "true";
    const result = await attempt(() =>
      cxpay("PATCH", `/v1/payment-links/${id}`, { body: { active }, idempotencyKey: key }),
    );
    if (!result.error)
      return paymentLinkPage({
        config,
        link: result.value,
        message: active ? "Payment link activated." : "Payment link deactivated.",
      });
    const link = await attempt(() => cxpay("GET", `/v1/payment-links/${id}`));
    return paymentLinkPage({
      config,
      link: link.value,
      error: link.error,
      actionError: result.error,
      retryKey: retryKeyFor(result.error, key),
    });
  }

  async function receiveWebhook(req, res) {
    if (!config.webhookSecret) {
      sendJson(res, 503, { error: "CXPAY_WEBHOOK_SECRET is not configured." });
      return;
    }
    const raw = await readBody(req, 262_144);
    // Verify the exact bytes before parsing. Ignore every other header.
    if (!verifyWebhook(raw, req.headers["x-cxpay-signature"], config.webhookSecret)) {
      sendJson(res, 401, { error: "Invalid signature." });
      return;
    }
    let event;
    try {
      event = JSON.parse(raw.toString("utf8"));
    } catch {
      sendJson(res, 400, { error: "Body is not JSON." });
      return;
    }
    if (typeof event?.id !== "string" || typeof event?.type !== "string") {
      sendJson(res, 400, { error: "Not a CX Pay event." });
      return;
    }
    const object = event.data?.object ?? {};
    const { duplicate } = events.add({
      id: event.id,
      type: event.type,
      objectId: object.id ?? object.paymentIntentId ?? null,
      livemode: event.livemode === true,
      createdAt: event.createdAt ?? null,
      receivedAt: new Date().toISOString(),
    });
    sendJson(res, 200, { received: true, duplicate });
  }

  async function route(req, res) {
    const url = new URL(req.url, "http://localhost");
    const path = url.pathname;
    const method = req.method;
    let m;

    if (path === "/style.css" && method === "GET") {
      res.writeHead(200, { "Content-Type": "text/css; charset=utf-8", "Cache-Control": "no-cache" });
      res.end(css);
      return;
    }
    if (path === "/webhooks/cxpay" && method === "POST") return receiveWebhook(req, res);
    if (path === "/return" && method === "GET") return sendHtml(res, 200, returnPage());

    if (!isLocal(req))
      return sendHtml(
        res,
        404,
        messagePage("Not found", `The dashboard only opens at http://localhost:${config.port} on the machine running it.`),
      );

    const query = {};
    for (const name of ["status", "cursor"]) {
      const value = url.searchParams.get(name);
      if (value) query[name] = value;
    }

    if (method === "GET" && path === "/") {
      const me = await attempt(() => cxpay("GET", "/v1/me"));
      return sendHtml(res, 200, overviewPage({ config, me: me.value, error: me.error, events: events.list() }));
    }
    if (method === "GET" && path === "/payments") {
      const result = await attempt(() =>
        cxpay("GET", "/v1/payment-intents", { query: { limit: 20, ...query } }),
      );
      return sendHtml(res, result.error ? 502 : 200, paymentsPage({ config, result: result.value, error: result.error, query }));
    }
    if (method === "GET" && (m = path.match(new RegExp(`^/payments/(${ID})$`)))) {
      const pi = await attempt(() => cxpay("GET", `/v1/payment-intents/${m[1]}`));
      return sendHtml(res, pi.error ? 502 : 200, paymentPage({ config, pi: pi.value, error: pi.error }));
    }
    if (method === "POST" && (m = path.match(new RegExp(`^/payments/(${ID})/(capture|cancel|refund)$`))))
      return sendHtml(res, 200, await paymentAction(m[1], m[2], req));
    if (method === "GET" && path === "/payment-links")
      return sendHtml(res, 200, await listLinks({ ...(query.cursor ? { cursor: query.cursor } : {}) }));
    if (method === "POST" && path === "/payment-links")
      return sendHtml(res, 200, await createLink(req));
    if (method === "GET" && (m = path.match(new RegExp(`^/payment-links/(${ID})$`)))) {
      const link = await attempt(() => cxpay("GET", `/v1/payment-links/${m[1]}`));
      return sendHtml(res, link.error ? 502 : 200, paymentLinkPage({ config, link: link.value, error: link.error }));
    }
    if (method === "POST" && (m = path.match(new RegExp(`^/payment-links/(${ID})/active$`))))
      return sendHtml(res, 200, await toggleLink(m[1], req));
    if (method === "GET" && path === "/events")
      return sendHtml(res, 200, eventsPage({ config, events: events.list() }));

    sendHtml(res, 404, messagePage("Not found", "There is no page here."));
  }

  const server = createServer((req, res) => {
    route(req, res).catch((error) => {
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) console.error(error);
      if (res.headersSent) return res.end();
      sendHtml(
        res,
        status,
        messagePage(
          status === 500 ? "Something went wrong" : "Request refused",
          status === 500 ? "The portal hit an unexpected error. Check the terminal running npm start." : error.message,
        ),
      );
    });
  });
  server.config = config;
  return server;
}

function sendHtml(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });
  res.end(String(body));
}

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let server;
  try {
    server = createApp();
  } catch (error) {
    console.error(`The portal did not start:\n${error.message}`);
    process.exit(1);
  }
  const { host, port, publicOrigin, tunnelConfigured } = server.config;
  server.listen(port, host, () => {
    console.log(`CX Pay test portal: http://localhost:${port}`);
    console.log(
      tunnelConfigured
        ? `Public origin (tunnel): ${publicOrigin}`
        : "No tunnel origin set. Set CXPAY_PUBLIC_ORIGIN in .env to receive webhooks.",
    );
  });
}

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { createHmac } from "node:crypto";
import { createApp } from "../server.mjs";
import { env } from "./fixtures.mjs";

const PORT = 4242;
const LOCAL = `localhost:${PORT}`;

const pi = {
  id: "pi_1",
  object: "payment_intent",
  status: "succeeded",
  amount: 2500,
  currency: "USD",
  description: "<script>alert(1)</script>",
  livemode: false,
  created_at: "2026-10-07T12:00:00.000Z",
};
const link = {
  id: "plink_1",
  object: "payment_link",
  status: "active",
  type: "fixed",
  amount: 2500,
  currency: "USD",
  url: "https://pay.example/l/plink_1",
  times_used: 0,
  times_completed: 0,
  livemode: false,
  created_at: "2026-10-07T12:00:00.000Z",
};

function fakeApi(url, init) {
  const path = url.pathname;
  if (path === "/v1/me")
    return Response.json({ merchantOrgId: "morg_1", keyId: "key_1", business: { name: "Floral" }, scopes: [] });
  if (path === "/v1/payment-intents")
    return Response.json({ data: [pi], has_more: true, next_cursor: "next+1" });
  if (path === "/v1/payment-intents/pi_1") return Response.json(pi);
  if (path === "/v1/payment-intents/pi_1/refund")
    return Response.json({ id: "re_1", object: "refund", amount: 500, currency: "USD", status: "succeeded" });
  if (path === "/v1/payment-links" && init.method === "POST") return Response.json(link);
  if (path === "/v1/payment-links") return Response.json({ data: [link], has_more: false, next_cursor: null });
  if (path === "/v1/payment-links/plink_1") return Response.json(link);
  return Response.json({ error: { code: "NOT_FOUND", message: "No such object." } }, { status: 404 });
}

async function harness(t, api = fakeApi) {
  const dataDirectory = mkdtempSync(join(tmpdir(), "cxpay-portal-"));
  const calls = [];
  const server = createApp({
    env: { ...env, PORT: String(PORT) },
    dataDirectory,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return api(url, init);
    },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.close();
    rmSync(dataDirectory, { recursive: true, force: true });
  });
  const send = (path, { method = "GET", headers = {}, body } = {}) =>
    new Promise((resolve, reject) => {
      const req = httpRequest(
        { host: "127.0.0.1", port: server.address().port, path, method, headers: { host: LOCAL, ...headers } },
        (res) => {
          let text = "";
          res.on("data", (c) => (text += c));
          res.on("end", () => resolve({ status: res.statusCode, text }));
        },
      );
      req.on("error", reject);
      req.end(body);
    });
  const post = (path, form, headers = {}) =>
    send(path, {
      method: "POST",
      body: new URLSearchParams(form).toString(),
      headers: { origin: `http://${LOCAL}`, "content-type": "application/x-www-form-urlencoded", ...headers },
    });
  return { send, post, calls };
}

test("every dashboard page renders and escapes API data", async (t) => {
  const h = await harness(t);
  for (const path of ["/", "/payments", "/payments?status=succeeded", "/payments/pi_1", "/payment-links", "/payment-links/plink_1", "/events"]) {
    const res = await h.send(path);
    assert.equal(res.status, 200, path);
    assert.match(res.text, /Test mode/);
  }
  const overview = await h.send("/");
  assert.match(overview.text, /https:\/\/tunnel\.example\/return/);
  assert.match(overview.text, /https:\/\/tunnel\.example\/webhooks\/cxpay/);
  assert.match(overview.text, /morg_1/);
  const list = await h.send("/payments");
  assert.ok(!list.text.includes("<script>alert"));
  assert.match(list.text, /cursor=next%2B1/);
  const secretInPage = (await h.send("/")).text.includes(env.CXPAY_API_SECRET);
  assert.equal(secretInPage, false);
});

test("through the tunnel only the webhook receiver and return page answer", async (t) => {
  const h = await harness(t);
  for (const path of ["/", "/payments", "/payments/pi_1", "/events"]) {
    assert.equal((await h.send(path, { headers: { host: "tunnel.example" } })).status, 404);
    assert.equal(
      (await h.send(path, { headers: { "x-forwarded-for": "203.0.113.9" } })).status,
      404,
      "a rewritten Host header is still caught by the forwarding header",
    );
  }
  assert.equal((await h.send("/return", { headers: { host: "tunnel.example" } })).status, 200);
  assert.equal(h.calls.length, 0);
});

test("writes need this portal's origin and send the form's Idempotency-Key", async (t) => {
  const h = await harness(t);
  const key = "6f1c1f0e-5d2a-4c1b-9a51-3a1d2f6b7c8e";
  const refused = await h.post("/payments/pi_1/refund", { idempotency_key: key }, { origin: "https://evil.example" });
  assert.equal(refused.status, 403);
  assert.equal(h.calls.length, 0);

  const refund = await h.post("/payments/pi_1/refund", { idempotency_key: key, amount: "500", reason: "duplicate" });
  assert.equal(refund.status, 200);
  assert.match(refund.text, /Refund re_1 created/);
  const call = h.calls.find((c) => c.url.pathname.endsWith("/refund"));
  assert.equal(call.init.headers["Idempotency-Key"], key);
  assert.equal(call.init.body, '{"amount":500,"reason":"duplicate"}');

  const created = await h.post("/payment-links", { idempotency_key: key, type: "fixed", amount: "2500", currency: "usd" });
  assert.match(created.text, /Payment link created/);
  const create = h.calls.find((c) => c.url.pathname === "/v1/payment-links" && c.init.method === "POST");
  assert.equal(create.init.headers["Idempotency-Key"], key);
  assert.deepEqual(JSON.parse(create.init.body), { type: "fixed", amount: 2500, currency: "USD" });
});

test("API failures render as a page, never a crash", async (t) => {
  const h = await harness(t, () => {
    throw new TypeError("fetch failed");
  });
  for (const path of ["/", "/payments", "/payments/pi_1", "/payment-links", "/payment-links/plink_1"]) {
    const res = await h.send(path);
    assert.ok([200, 502].includes(res.status), path);
    assert.match(res.text, /NETWORK_ERROR/, path);
  }
  const key = "6f1c1f0e-5d2a-4c1b-9a51-3a1d2f6b7c8e";
  const res = await h.post("/payment-links", { idempotency_key: key, type: "fixed", amount: "2500", currency: "USD" });
  assert.match(res.text, /NETWORK_ERROR/);
  // The outcome is unknown, so the retry form reuses the same key.
  assert.match(res.text, new RegExp(`value="${key}"`));
});

test("the webhook receiver verifies, records and deduplicates events", async (t) => {
  const h = await harness(t);
  const body = JSON.stringify({ id: "evt_1", type: "refund.succeeded", livemode: false, data: { object: { id: "re_1" } } });
  const timestamp = Math.floor(Date.now() / 1000);
  const v1 = createHmac("sha256", env.CXPAY_WEBHOOK_SECRET).update(`${timestamp}.${body}`).digest("hex");
  const headers = { host: "tunnel.example", "x-forwarded-for": "203.0.113.9" };

  const unsigned = await h.send("/webhooks/cxpay", { method: "POST", body, headers });
  assert.equal(unsigned.status, 401);
  const first = await h.send("/webhooks/cxpay", {
    method: "POST",
    body,
    headers: { ...headers, "x-cxpay-signature": `t=${timestamp},v1=${v1}` },
  });
  assert.equal(first.status, 200);
  assert.equal(JSON.parse(first.text).duplicate, false);
  const again = await h.send("/webhooks/cxpay", {
    method: "POST",
    body,
    headers: { ...headers, "x-cxpay-signature": `t=${timestamp},v1=${v1}` },
  });
  assert.equal(JSON.parse(again.text).duplicate, true);
  assert.match((await h.send("/events")).text, /refund\.succeeded/);
});

test("the portal will not start with a live key", () => {
  assert.throws(() => createApp({ env: { ...env, CXPAY_KEY_ID: `ak_live_${"a".repeat(32)}` } }), /live key/);
});

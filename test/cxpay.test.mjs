import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { canonicalQuery, createClient, signRequest } from "../lib/cxpay.mjs";
import { readConfig } from "../lib/config.mjs";
import { env } from "./fixtures.mjs";

test("HMAC authenticates the raw body with a Base64-decoded key and stage-free path", () => {
  const body = '{"type":"fixed","amount":2500,"currency":"USD"}';
  const headers = signRequest({
    method: "POST",
    path: "/v1/payment-links",
    body,
    keyId: "fixture",
    secret: env.CXPAY_API_SECRET,
    timestamp: "2026-10-07T12:00:00.000Z",
    nonce: "fixture-nonce",
  });
  const hash = createHash("sha256").update(body).digest("hex");
  const canonical = `POST\n/v1/payment-links\n\n2026-10-07T12:00:00.000Z\nfixture-nonce\n${hash}`;
  assert.equal(headers["X-Body-Hash"], hash);
  assert.equal(
    headers["X-Signature"],
    createHmac("sha256", Buffer.alloc(32, 7)).update(canonical).digest("base64"),
  );
});

test("the query is signed sorted by key over decoded values", () => {
  assert.equal(canonicalQuery([]), "");
  assert.equal(
    canonicalQuery([
      ["status", "succeeded"],
      ["limit", "20"],
      ["cursor", "eyJhIjoxfQ+/="],
    ]),
    "cursor=eyJhIjoxfQ+/=&limit=20&status=succeeded",
  );
});

test("a list request puts the stage and encoded query in the URL, and signs neither encoding nor stage", async () => {
  const { config } = readConfig({ ...env, CXPAY_API_BASE_URL: "https://gateway.example/dev/" });
  const request = createClient(config, async (url, init) => {
    assert.equal(url.origin + url.pathname, "https://gateway.example/dev/v1/payment-intents");
    assert.equal(url.searchParams.get("cursor"), "a+b/c=");
    assert.equal(init.body, undefined);
    const expected = signRequest({
      method: "GET",
      path: "/v1/payment-intents",
      query: "cursor=a+b/c=&limit=20",
      keyId: config.keyId,
      secret: config.secret,
      timestamp: init.headers["X-Timestamp"],
      nonce: init.headers["X-Nonce"],
    });
    assert.equal(init.headers["X-Signature"], expected["X-Signature"]);
    assert.equal(init.headers["Idempotency-Key"], undefined);
    return Response.json({ data: [], has_more: false, next_cursor: null });
  });
  await request("GET", "/v1/payment-intents", { query: { limit: 20, cursor: "a+b/c=", status: undefined } });
});

test("writes send the Idempotency-Key and a fresh nonce on every attempt", async () => {
  const { config } = readConfig(env);
  const seen = [];
  const request = createClient(config, async (url, init) => {
    seen.push(init.headers);
    assert.equal(init.body, '{"amount":500}');
    return Response.json({ id: "re_1", object: "refund", amount: 500, currency: "USD", status: "succeeded" });
  });
  const body = { amount: 500, reason: undefined };
  await request("POST", "/v1/payment-intents/pi_1/refund", { body, idempotencyKey: "key-1" });
  await request("POST", "/v1/payment-intents/pi_1/refund", { body, idempotencyKey: "key-1" });
  assert.equal(seen[0]["Idempotency-Key"], "key-1");
  assert.equal(seen[1]["Idempotency-Key"], "key-1");
  assert.notEqual(seen[0]["X-Nonce"], seen[1]["X-Nonce"]);
});

test("API errors keep CX Pay's code, message and correlation ID; live data is refused", async () => {
  const { config } = readConfig(env);
  const failing = createClient(config, async () =>
    Response.json(
      { error: { type: "VALIDATION", code: "AMOUNT_TOO_LARGE", message: "Too much.", correlationId: "corr_1" } },
      { status: 400 },
    ),
  );
  await assert.rejects(failing("POST", "/v1/payment-intents/pi_1/refund", { body: {} }), {
    status: 400,
    code: "AMOUNT_TOO_LARGE",
    message: "Too much.",
    correlationId: "corr_1",
  });
  const offline = createClient(config, async () => {
    throw new TypeError("fetch failed");
  });
  await assert.rejects(offline("GET", "/v1/me"), { status: 0, code: "NETWORK_ERROR" });
  const live = createClient(config, async () =>
    Response.json({ data: [{ id: "pi_1", livemode: true }], has_more: false }),
  );
  await assert.rejects(live("GET", "/v1/payment-intents"), { code: "LIVEMODE_RESPONSE" });
});

test("live keys and malformed secrets are refused without echoing values", () => {
  assert.deepEqual(readConfig(env).issues, []);
  const { issues } = readConfig({
    CXPAY_KEY_ID: "ak_live_sensitive",
    CXPAY_API_SECRET: "sensitive",
  });
  assert.equal(issues.length, 2);
  assert.match(issues[0], /live key/);
  assert.ok(!JSON.stringify(issues).includes("sensitive"));
  assert.equal(readConfig({ ...env, CXPAY_PUBLIC_ORIGIN: "http://tunnel.example" }).issues.length, 1);
  assert.equal(readConfig({ ...env, CXPAY_PUBLIC_ORIGIN: "https://tunnel.example/" }).issues.length, 1);
});

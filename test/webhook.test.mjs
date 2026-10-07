import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { verifyWebhook } from "../lib/webhook.mjs";

const secret = "whsec_fixture";

function sign(body, timestamp = Math.floor(Date.now() / 1000), key = secret) {
  const signature = createHmac("sha256", key).update(`${timestamp}.`).update(body).digest("hex");
  return `t=${timestamp},v1=${signature}`;
}

test("webhook verification uses the raw bytes, the timestamp and the UTF-8 secret", () => {
  const body = Buffer.from('{"id":"evt_1", "type":"payment_intent.succeeded","livemode":false}');
  const header = sign(body);
  assert.ok(verifyWebhook(body, header, secret));
  // Re-serialized JSON is a different body.
  assert.equal(verifyWebhook(Buffer.from(body.toString().replace(", ", ",")), header, secret), false);
  assert.equal(verifyWebhook(body, header, "whsec_other"), false);
  assert.equal(verifyWebhook(body, header, ""), false);
});

test("stale, future and malformed signatures are rejected", () => {
  const body = Buffer.from('{"id":"evt_1"}');
  const header = sign(body);
  assert.equal(verifyWebhook(body, header, secret, Date.now() + 301_000), false);
  assert.equal(verifyWebhook(body, header, secret, Date.now() - 301_000), false);
  assert.ok(verifyWebhook(body, header, secret, Date.now() + 299_000));
  const t = Math.floor(Date.now() / 1000);
  assert.equal(verifyWebhook(body, `t=${t},v1=00`, secret), false);
  assert.equal(verifyWebhook(body, header.replace("t=", "ts="), secret), false);
  assert.equal(verifyWebhook(body, undefined, secret), false);
});

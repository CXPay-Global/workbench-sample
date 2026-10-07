import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyWebhook(rawBody, header, secret, now = Date.now()) {
  if (!secret || typeof header !== "string") return false;
  const match = /^t=(\d{1,12}),v1=([a-f0-9]{64})$/.exec(header);
  if (!match || Math.abs(now / 1000 - Number(match[1])) > 300) return false;
  // Webhook secrets are UTF-8, unlike Base64-encoded API signing secrets.
  const expected = createHmac("sha256", secret)
    .update(`${match[1]}.`)
    .update(rawBody)
    .digest();
  return timingSafeEqual(Buffer.from(match[2], "hex"), expected);
}

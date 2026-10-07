const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

// Reads .env values. Returns problems as messages that never echo a secret.
export function readConfig(env) {
  const issues = [];
  const keyId = env.CXPAY_KEY_ID?.trim() || "";
  const secret = env.CXPAY_API_SECRET?.trim() || "";
  const webhookSecret = env.CXPAY_WEBHOOK_SECRET?.trim() || "";
  const apiBaseUrl =
    env.CXPAY_API_BASE_URL?.trim() || "https://api.cxpay.net/";
  const port = Number(env.PORT?.trim() || 4242);
  const publicOrigin =
    env.CXPAY_PUBLIC_ORIGIN?.trim() || `http://localhost:${port}`;

  if (keyId.startsWith("ak_live_"))
    issues.push(
      "CXPAY_KEY_ID is a live key. This portal runs in test mode only; use an ak_test_… key.",
    );
  else if (!/^ak_test_[a-f0-9]{32}$/.test(keyId))
    issues.push("Set CXPAY_KEY_ID in .env to a test API key ID (ak_test_…).");
  if (
    !/^[A-Za-z0-9+/]{43}=$/.test(secret) ||
    Buffer.from(secret, "base64").length !== 32
  )
    issues.push(
      "Set CXPAY_API_SECRET in .env to the 32-byte, Base64-encoded API signing secret.",
    );
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    issues.push("PORT must be 1–65535.");

  try {
    const url = new URL(apiBaseUrl);
    if (url.protocol !== "https:" || !url.pathname.endsWith("/") || url.search)
      throw new Error();
  } catch {
    issues.push("CXPAY_API_BASE_URL must be an HTTPS URL ending with /.");
  }

  try {
    const url = new URL(publicOrigin);
    const loopbackHttp =
      url.protocol === "http:" && LOOPBACK.has(url.hostname);
    if (url.origin !== publicOrigin || (url.protocol !== "https:" && !loopbackHttp))
      throw new Error();
  } catch {
    issues.push(
      "CXPAY_PUBLIC_ORIGIN must be your tunnel's HTTPS origin, with no path or trailing slash.",
    );
  }

  return {
    issues,
    config: {
      keyId,
      secret,
      webhookSecret,
      apiBaseUrl,
      port,
      host: "127.0.0.1",
      publicOrigin,
      tunnelConfigured: publicOrigin.startsWith("https:"),
      returnUrl: `${publicOrigin}/return`,
      webhookUrl: `${publicOrigin}/webhooks/cxpay`,
      requestTimeoutMs: 20_000,
    },
  };
}

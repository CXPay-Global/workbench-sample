import { createHash, createHmac, randomUUID } from "node:crypto";

export class ApiError extends Error {
  constructor({ status, code, message, correlationId = null }) {
    super(message);
    this.status = status;
    this.code = code;
    this.correlationId = correlationId;
  }
}

// Sorted by key, then value, as `k=v&k=v`, over the values CX Pay receives
// after URL decoding. Empty when there is no query.
export function canonicalQuery(params) {
  return [...params]
    .sort(([ak, av], [bk, bv]) =>
      ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0,
    )
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

export function signRequest({
  method,
  path,
  query = "",
  body = "",
  keyId,
  secret,
  timestamp = new Date().toISOString(),
  nonce = randomUUID(),
}) {
  // Sign the stage-free /v1/… path, even when apiBaseUrl includes a stage.
  const bodyHash = createHash("sha256").update(body).digest("hex");
  const canonical = [method, path, query, timestamp, nonce, bodyHash].join("\n");
  return {
    "Content-Type": "application/json",
    "X-Key-Id": keyId,
    "X-Timestamp": timestamp,
    "X-Nonce": nonce,
    "X-Body-Hash": bodyHash,
    "X-Signature": createHmac("sha256", Buffer.from(secret, "base64"))
      .update(canonical)
      .digest("base64"),
  };
}

function containsLive(payload) {
  if (payload?.livemode === true) return true;
  return Array.isArray(payload?.data) && payload.data.some((o) => o?.livemode === true);
}

export function createClient(config, fetchImpl = fetch) {
  return async function request(
    method,
    path,
    { query = {}, body, idempotencyKey } = {},
  ) {
    const params = Object.entries(query)
      .filter(([, value]) => value !== undefined && value !== "")
      .map(([key, value]) => [key, String(value)]);
    const text = body === undefined ? "" : JSON.stringify(body);
    const headers = signRequest({
      method,
      path,
      query: canonicalQuery(params),
      body: text,
      keyId: config.keyId,
      secret: config.secret,
    });
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;

    const url = new URL(path.slice(1), config.apiBaseUrl);
    for (const [key, value] of params) url.searchParams.append(key, value);

    let response;
    try {
      response = await fetchImpl(url, {
        method,
        headers,
        ...(text ? { body: text } : {}),
        signal: AbortSignal.timeout(config.requestTimeoutMs),
        redirect: "error",
      });
    } catch {
      throw new ApiError({
        status: 0,
        code: "NETWORK_ERROR",
        message:
          "CX Pay could not be reached, or did not answer in time. The outcome of a write is unknown: reload before retrying.",
      });
    }

    const payload = await response.json().catch(() => null);
    const correlationId =
      payload?.error?.correlationId || response.headers.get("x-correlation-id");
    if (response.status === 202)
      throw new ApiError({
        status: 202,
        code: "REQUEST_IN_PROGRESS",
        message:
          "CX Pay is still processing an earlier request with this Idempotency-Key. Reload to see the result.",
        correlationId,
      });
    if (!response.ok)
      // CX Pay error messages are safe to show. Nothing else from the response is.
      throw new ApiError({
        status: response.status,
        code: payload?.error?.code || "API_ERROR",
        message:
          payload?.error?.message ||
          (response.status === 401 || response.status === 403
            ? `CX Pay refused the request (HTTP ${response.status}). Check CXPAY_KEY_ID, CXPAY_API_SECRET, CXPAY_API_BASE_URL and the key's scopes.`
            : `CX Pay answered HTTP ${response.status}.`),
        correlationId,
      });
    if (payload === null)
      throw new ApiError({
        status: response.status,
        code: "INVALID_RESPONSE",
        message: "CX Pay returned a response this portal could not read.",
        correlationId,
      });
    if (containsLive(payload))
      throw new ApiError({
        status: response.status,
        code: "LIVEMODE_RESPONSE",
        message: "CX Pay returned live-mode data. This portal is test-only and will not show it.",
        correlationId,
      });
    return payload;
  };
}

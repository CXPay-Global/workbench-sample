export const env = {
  CXPAY_KEY_ID: `ak_test_${"a".repeat(32)}`,
  CXPAY_API_SECRET: Buffer.alloc(32, 7).toString("base64"),
  CXPAY_WEBHOOK_SECRET: "whsec_fixture",
  CXPAY_PUBLIC_ORIGIN: "https://tunnel.example",
};

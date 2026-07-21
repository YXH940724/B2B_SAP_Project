import assert from "node:assert/strict";
import https from "node:https";
import test from "node:test";
import type { SapConfig } from "../src/config.js";
import { SapODataClient } from "../src/odata-client.js";

const config: SapConfig = {
  baseUrl: "https://sap.example.com/sales-order", client: "100", username: "user", password: "secret", timeoutMs: 30000,
  writeEnabled: true, writeAllowedFields: new Set(), httpsAgent: new https.Agent(),
  services: { product: "https://sap.example.com/product", businessPartner: "https://sap.example.com/bp", pricing: "https://sap.example.com/pricing" },
};

test("reuses SAP session cookies with the fetched CSRF token for writes", async () => {
  const client = new SapODataClient(config);
  let headers: Record<string, string> = {};
  Object.defineProperty(client, "http", {
    value: {
      get: async () => ({ headers: { "x-csrf-token": "csrf-token", "set-cookie": ["SAP_SESSIONID=abc; Path=/; Secure", "sap-usercontext=sap-client=100; Path=/"] } }),
      request: async (request: { headers: Record<string, string> }) => {
        headers = request.headers;
        return { data: { d: { SalesOrder: "0000000001" } }, headers: {} };
      },
    },
  });

  await client.write("post", "/A_SalesOrder", { SalesOrderType: "OR" });

  assert.equal(headers["X-CSRF-Token"], "csrf-token");
  assert.equal(headers.Cookie, "SAP_SESSIONID=abc; sap-usercontext=sap-client=100");
});

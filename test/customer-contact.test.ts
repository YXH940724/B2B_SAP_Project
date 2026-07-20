import assert from "node:assert/strict";
import test from "node:test";
import https from "node:https";
import type { SapConfig } from "../src/config.js";
import { getCustomerRegistrationContact } from "../src/customer-contact.js";
import { createVerificationDelivery } from "../src/verification-delivery.js";

const config: SapConfig = {
  baseUrl: "https://sap.example.test/orders", client: "200", username: "user", password: "secret", timeoutMs: 30000,
  writeEnabled: false, writeAllowedFields: new Set(), httpsAgent: new https.Agent(),
  services: { product: "https://sap.example.test/products", businessPartner: "https://sap.example.test/bp", pricing: "https://sap.example.test/pricing" },
};

test("resolves an email through the customer's business partner address", async () => {
  const calls: Array<{ path: string; params?: Record<string, string | number | undefined> }> = [];
  const client = {
    getAt: async (_base: string, path: string, params?: Record<string, string | number | undefined>) => {
      calls.push({ path, params });
      if (path.startsWith("/A_Customer")) return { data: { Customer: "0000100001", BusinessPartner: "0000100001" } };
      return { data: { results: [{ to_EmailAddress: { results: [{ EmailAddress: "buyer@example.test" }] } }] } };
    },
  };
  assert.deepEqual(await getCustomerRegistrationContact(client as never, config, "100001"), { customer: "0000100001", email: "buyer@example.test" });
  assert.deepEqual(calls.map((call) => call.path), ["/A_Customer('0000100001')", "/A_BusinessPartnerAddress"]);
});

test("refuses log delivery outside development", () => {
  assert.throws(() => createVerificationDelivery({ NODE_ENV: "production", VERIFICATION_DELIVERY: "log" }), /production/);
});

test("writes the development verification code only to the server logger", async () => {
  const lines: string[] = [];
  const delivery = createVerificationDelivery({ NODE_ENV: "development", VERIFICATION_DELIVERY: "log" }, (line) => lines.push(line));
  await delivery.send("0000100001", "123456");
  assert.deepEqual(lines, ["[development] verification code for 0000100001: 123456"]);
});

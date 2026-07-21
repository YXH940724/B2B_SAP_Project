import assert from "node:assert/strict";
import https from "node:https";
import test from "node:test";
import { getOrderDefaults } from "../src/order-defaults.js";
import type { SapConfig } from "../src/config.js";
import type { SalesArea } from "../src/sales-areas.js";

const config: SapConfig = { baseUrl: "https://sap.example.test/orders", client: "200", username: "user", password: "secret", timeoutMs: 30_000, writeEnabled: false, writeAllowedFields: new Set(), httpsAgent: new https.Agent(), services: { product: "https://sap.example.test/product", businessPartner: "https://sap.example.test/bp", pricing: "https://sap.example.test/pricing" } };
const area: SalesArea = { salesOrganization: "1310", distributionChannel: "10", division: "00", key: "1310/10/00" };

test("reads payment and Incoterms defaults from the selected customer sales area", async () => {
  let filter = "";
  const client = { getAt: async (_service: string, path: string, params?: Record<string, string | number | undefined>) => {
    assert.equal(path, "/A_CustomerSalesArea");
    filter = String(params?.["$filter"]);
    return { data: { results: [{ CustomerPaymentTerms: "0001", IncotermsClassification: "FOB", IncotermsVersion: "2020", IncotermsTransferLocation: "Shanghai", IncotermsLocation1: "CN SHA" }] } };
  } };
  const defaults = await getOrderDefaults(client as never, config, "100001", area);
  assert.match(filter, /Customer eq '0000100001'/);
  assert.match(filter, /SalesOrganization eq '1310'/);
  assert.equal(defaults.paymentTerms, "0001");
  assert.equal(defaults.incotermsClassification, "FOB");
  assert.equal(defaults.incotermsLocation, "Shanghai");
});

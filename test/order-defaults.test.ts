import assert from "node:assert/strict";
import https from "node:https";
import test from "node:test";
import { getOrderDefaults } from "../src/order-defaults.js";
import type { SapConfig } from "../src/config.js";
import type { SalesArea } from "../src/sales-areas.js";

const config: SapConfig = { baseUrl: "https://sap.example.test/orders", client: "200", username: "user", password: "secret", timeoutMs: 30_000, writeEnabled: false, writeAllowedFields: new Set(), httpsAgent: new https.Agent(), services: { product: "https://sap.example.test/product", businessPartner: "https://sap.example.test/bp", pricing: "https://sap.example.test/pricing" } };
const area: SalesArea = { salesOrganization: "1310", distributionChannel: "10", division: "00", key: "1310/10/00" };

test("reads payment and Incoterms defaults from the exact customer sales area without an Incoterms version", async () => {
  let filter = "";
  let select = "";
  const client = { getAt: async (_service: string, path: string, params?: Record<string, string | number | undefined>) => {
    assert.equal(path, "/A_CustomerSalesArea");
    filter = String(params?.["$filter"]);
    select = String(params?.["$select"]);
    return { data: { results: [{ CustomerPaymentTerms: "0001", IncotermsClassification: "FOB", IncotermsTransferLocation: "Legacy location", IncotermsLocation1: "CN SHA" }] } };
  } };
  const defaults = await getOrderDefaults(client as never, config, "100001", area);
  assert.equal(filter, "Customer eq '0000100001' and SalesOrganization eq '1310' and DistributionChannel eq '10' and Division eq '00'");
  assert.equal(select.includes("IncotermsVersion"), false);
  assert.equal(select.includes("IncotermsTransferLocation"), false);
  assert.equal(select.includes("IncotermsLocation1"), true);
  assert.deepEqual(defaults, { paymentTerms: "0001", incotermsClassification: "FOB", incotermsLocation: "CN SHA" });
});

import assert from "node:assert/strict";
import https from "node:https";
import test from "node:test";
import { listCustomerSalesAreas } from "../src/sales-areas.js";
import type { SapConfig } from "../src/config.js";

const config: SapConfig = {
  baseUrl: "https://sap.example.test/orders",
  client: "200",
  username: "user",
  password: "secret",
  timeoutMs: 30000,
  writeEnabled: false,
  writeAllowedFields: new Set(),
  httpsAgent: new https.Agent(),
  services: {
    product: "https://sap.example.test/products",
    businessPartner: "https://sap.example.test/bp",
    pricing: "https://sap.example.test/pricing",
  },
};

test("returns sorted customer sales areas with a normalized customer filter", async () => {
  let filter = "";
  const client = {
    getAt: async (_base: string, path: string, params?: Record<string, string | number | undefined>) => {
      assert.equal(path, "/A_CustomerSalesArea");
      filter = String(params?.["$filter"] ?? "");
      return {
        data: {
          results: [
            { SalesOrganization: "2000", DistributionChannel: "20", Division: "00" },
            { SalesOrganization: "1000", DistributionChannel: "10", Division: "00" },
            { SalesOrganization: "", DistributionChannel: "10", Division: "00" },
          ],
        },
      };
    },
  };

  const areas = await listCustomerSalesAreas(client as never, config, "100001");

  assert.equal(filter, "Customer eq '0000100001'");
  assert.deepEqual(areas, [
    { salesOrganization: "1000", distributionChannel: "10", division: "00", key: "1000/10/00" },
    { salesOrganization: "2000", distributionChannel: "20", division: "00", key: "2000/20/00" },
  ]);
});

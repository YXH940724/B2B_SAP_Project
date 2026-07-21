import assert from "node:assert/strict";
import https from "node:https";
import test from "node:test";
import { getProductDetails, getProductFulfillmentOptions } from "../src/master-data.js";
import type { SapConfig } from "../src/config.js";

const config: SapConfig = {
  baseUrl: "https://sap.example.test/orders",
  client: "200",
  username: "user",
  password: "secret",
  timeoutMs: 30_000,
  writeEnabled: false,
  writeAllowedFields: new Set(),
  httpsAgent: new https.Agent(),
  services: { product: "https://sap.example.test/products", businessPartner: "https://sap.example.test/bp", pricing: "https://sap.example.test/pricing" },
};

function client() {
  return {
    getAt: async (_service: string, path: string, params?: Record<string, string | number | undefined>) => {
      if (path === "/A_Product('MAT-01')") return { data: { Product: "MAT-01", ProductGroup: "FG", BaseUnit: "EA" } };
      if (path === "/A_ProductDescription") {
        if (params?.["$filter"]?.includes("Language eq 'EN'")) return { data: { results: [{ Product: "MAT-01", Language: "EN", ProductDescription: "English description" }] } };
        return { data: { results: [] } };
      }
      if (path === "/A_ProductPlant") return { data: { results: [{ Product: "MAT-01", Plant: "1320" }, { Product: "MAT-01", Plant: "1310" }] } };
      if (path === "/A_ProductStorageLocation") return { data: { results: [{ Product: "MAT-01", Plant: "1310", StorageLocation: "0002" }, { Product: "MAT-01", Plant: "1310", StorageLocation: "0001" }] } };
      throw new Error(`Unexpected SAP request: ${path}`);
    },
  };
}

test("prefers the requested SAP product description language", async () => {
  const details = await getProductDetails(client() as never, config, "MAT-01", "EN");
  assert.equal(details.description, "English description");
  assert.equal(details.descriptionLanguage, "EN");
  assert.equal(details.descriptionFallback, false);
});

test("marks a product-number fallback when SAP has no requested description", async () => {
  const details = await getProductDetails(client() as never, config, "MAT-01", "ZH");
  assert.equal(details.description, "MAT-01");
  assert.equal(details.descriptionFallback, true);
});

test("uses the first product plant and exposes sorted storage locations", async () => {
  const options = await getProductFulfillmentOptions(client() as never, config, "MAT-01");
  assert.deepEqual(options, { defaultPlant: "1310", plants: ["1310", "1320"], storageLocationsByPlant: { "1310": ["0001", "0002"], "1320": [] } });
});

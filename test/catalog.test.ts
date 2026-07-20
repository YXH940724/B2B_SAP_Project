import assert from "node:assert/strict";
import https from "node:https";
import test from "node:test";
import { CatalogService } from "../src/catalog.js";
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

function makeClient() {
  return {
    getAt: async (_base: string, path: string, params?: Record<string, string | number | undefined>) => {
      if (path === "/A_SlsPrcgCndnRecdValidity") {
        if (params?.["$skip"] === 200) return { data: { results: [] } };
        return {
          data: {
            results: [
              {
                Material: "000000000000001386",
                ConditionRecord: "0000000123",
                ConditionValidityStartDate: "/Date(1782777600000)/",
                ConditionValidityEndDate: "/Date(1790812800000)/",
                to_SlsPrcgConditionRecord: { ConditionTable: "305", ConditionRateValue: "30.00", ConditionRateValueUnit: "CNY", ConditionQuantityUnit: "PC", ConditionIsDeleted: false },
              },
              {
                Material: "000000000000001387",
                ConditionRecord: "0000000124",
                ConditionValidityStartDate: "/Date(1782777600000)/",
                ConditionValidityEndDate: "/Date(1790812800000)/",
                to_SlsPrcgConditionRecord: { ConditionTable: "305", ConditionRateValue: "12.00", ConditionRateValueUnit: "CNY", ConditionQuantityUnit: "EA", ConditionIsDeleted: false },
              },
              {
                Material: "000000000000001388",
                ConditionRecord: "0000000125",
                ConditionValidityStartDate: "/Date(1719792000000)/",
                ConditionValidityEndDate: "/Date(1751328000000)/",
                to_SlsPrcgConditionRecord: { ConditionTable: "305", ConditionRateValue: "1.00", ConditionRateValueUnit: "CNY", ConditionQuantityUnit: "EA", ConditionIsDeleted: false },
              },
              {
                Material: "000000000000001389",
                ConditionRecord: "0000000126",
                ConditionValidityStartDate: "/Date(1782777600000)/",
                ConditionValidityEndDate: "/Date(1790812800000)/",
                to_SlsPrcgConditionRecord: { ConditionTable: "304", ConditionRateValue: "1.00", ConditionRateValueUnit: "CNY", ConditionQuantityUnit: "EA", ConditionIsDeleted: false },
              },
            ],
          },
        };
      }
      if (path === "/A_Product('000000000000001386')") {
        return { data: { Product: "000000000000001386", ProductGroup: "FG", BaseUnit: "PC", to_Description: { results: [{ ProductDescription: "演示物料" }] } } };
      }
      if (path === "/A_Product('000000000000001387')") {
        return { data: { Product: "000000000000001387", BaseUnit: "EA", to_Description: { results: [] } } };
      }
      throw new Error(`Unexpected OData request: ${path}`);
    },
  };
}

test("lists only current A305 ZR01 products with product details and pagination", async () => {
  const catalog = new CatalogService(makeClient() as never, config, () => new Date("2026-07-20T00:00:00Z"));
  const page = await catalog.list({ page: 1, pageSize: 1, sort: "material" });

  assert.equal(page.total, 2);
  assert.deepEqual(page.groups, [
    { code: "FG", label: "FG", count: 1 },
    { code: "UNCLASSIFIED", label: "未分类", count: 1 },
  ]);
  assert.deepEqual(page.items[0], {
    product: "000000000000001386",
    description: "演示物料",
    productGroup: "FG",
    baseUnit: "PC",
    conditionRecord: "0000000123",
    unitPrice: "30.00",
    currency: "CNY",
    priceUnit: "PC",
  });
  assert.equal(page.pageCount, 2);
});

test("filters a catalog by material group and a material-number-or-description query", async () => {
  const catalog = new CatalogService(makeClient() as never, config, () => new Date("2026-07-20T00:00:00Z"));
  assert.equal((await catalog.list({ query: "1386", page: 1, pageSize: 20, sort: "material" })).items.length, 1);
  const fallback = await catalog.list({ query: "1387", group: "UNCLASSIFIED", page: 1, pageSize: 20, sort: "material" });
  assert.equal(fallback.items.length, 1);
  assert.equal(fallback.items[0].description, "000000000000001387");
});

import assert from "node:assert/strict";
import https from "node:https";
import test from "node:test";
import { CatalogService } from "../src/catalog.js";
import type { SapConfig } from "../src/config.js";
import type { SalesArea } from "../src/sales-areas.js";

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
      if (path === "/A_SlsPrcgConditionRecord") {
        if (params?.["$skip"] === 200) return { data: { results: [] } };
        return { data: { results: [
          { ConditionRecord: "0000000123", ConditionTable: "305", ConditionRateValue: "30.00", ConditionRateValueUnit: "CNY", ConditionQuantityUnit: "PC", ConditionIsDeleted: false },
          { ConditionRecord: "0000000124", ConditionTable: "305", ConditionRateValue: "12.00", ConditionRateValueUnit: "CNY", ConditionQuantityUnit: "EA", ConditionIsDeleted: false },
          { ConditionRecord: "0000000125", ConditionTable: "305", ConditionRateValue: "1.00", ConditionRateValueUnit: "CNY", ConditionQuantityUnit: "EA", ConditionIsDeleted: false },
          { ConditionRecord: "0000000126", ConditionTable: "304", ConditionRateValue: "1.00", ConditionRateValueUnit: "CNY", ConditionQuantityUnit: "EA", ConditionIsDeleted: false },
        ] } };
      }
      if (path === "/A_SlsPrcgCndnRecdValidity") {
        if (params?.["$skip"] === 200) return { data: { results: [] } };
        return {
          data: {
            results: [
              {
                Material: "000000000000001386",
                Customer: "0000100001",
                SalesOrganization: "1310",
                DistributionChannel: "10",
                ConditionRecord: "0000000123",
                ConditionValidityStartDate: "/Date(1782777600000)/",
                ConditionValidityEndDate: "/Date(1790812800000)/",
              },
              {
                Material: "000000000000001387",
                Customer: "0000100001",
                SalesOrganization: "1310",
                DistributionChannel: "10",
                ConditionRecord: "0000000124",
                ConditionValidityStartDate: "/Date(1782777600000)/",
                ConditionValidityEndDate: "/Date(1790812800000)/",
              },
              {
                Material: "000000000000001390",
                Customer: "0000100002",
                SalesOrganization: "1310",
                DistributionChannel: "10",
                ConditionRecord: "0000000127",
                ConditionValidityStartDate: "/Date(1782777600000)/",
                ConditionValidityEndDate: "/Date(1790812800000)/",
                to_SlsPrcgConditionRecord: { ConditionTable: "305", ConditionRateValue: "8.00", ConditionRateValueUnit: "CNY", ConditionQuantityUnit: "EA", ConditionIsDeleted: false },
              },
              {
                Material: "000000000000001391",
                Customer: "0000100001",
                SalesOrganization: "2000",
                DistributionChannel: "10",
                ConditionRecord: "0000000128",
                ConditionValidityStartDate: "/Date(1782777600000)/",
                ConditionValidityEndDate: "/Date(1790812800000)/",
                to_SlsPrcgConditionRecord: { ConditionTable: "305", ConditionRateValue: "9.00", ConditionRateValueUnit: "CNY", ConditionQuantityUnit: "EA", ConditionIsDeleted: false },
              },
              {
                Material: "000000000000001388",
                Customer: "0000100001",
                SalesOrganization: "1310",
                DistributionChannel: "10",
                ConditionRecord: "0000000125",
                ConditionValidityStartDate: "/Date(1719792000000)/",
                ConditionValidityEndDate: "/Date(1751328000000)/",
              },
              {
                Material: "000000000000001389",
                Customer: "0000100001",
                SalesOrganization: "1310",
                DistributionChannel: "10",
                ConditionRecord: "0000000126",
                ConditionValidityStartDate: "/Date(1782777600000)/",
                ConditionValidityEndDate: "/Date(1790812800000)/",
              },
            ],
          },
        };
      }
      if (path === "/A_ProductDescription") {
        const filter = String(params?.["$filter"] ?? "");
        if (filter.includes("000000000000001386")) return { data: { results: [{ ProductDescription: "演示物料" }] } };
        return { data: { results: [] } };
      }
      if (path === "/A_Product('000000000000001386')") {
        return { data: { Product: "000000000000001386", ProductGroup: "FG", BaseUnit: "PC" } };
      }
      if (path === "/A_Product('000000000000001387')") {
        return { data: { Product: "000000000000001387", BaseUnit: "EA" } };
      }
      throw new Error(`Unexpected OData request: ${path}`);
    },
  };
}

const salesArea: SalesArea = { salesOrganization: "1310", distributionChannel: "10", division: "00", key: "1310/10/00" };

test("lists only current A305 PR00 products with product details and pagination", async () => {
  const catalog = new CatalogService(makeClient() as never, config, () => new Date("2026-07-20T00:00:00Z"));
  const page = await catalog.list("0000100001", salesArea, { page: 1, pageSize: 1, sort: "material" });

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
  assert.equal((await catalog.list("0000100001", salesArea, { query: "1386", page: 1, pageSize: 20, sort: "material" })).items.length, 1);
  const fallback = await catalog.list("0000100001", salesArea, { query: "1387", group: "UNCLASSIFIED", page: 1, pageSize: 20, sort: "material" });
  assert.equal(fallback.items.length, 1);
  assert.equal(fallback.items[0].description, "000000000000001387");
});

test("keeps only prices matching the customer and selected sales area", async () => {
  const requests: Array<Record<string, string | number | undefined>> = [];
  const base = makeClient();
  const client = {
    getAt: async (service: string, path: string, params?: Record<string, string | number | undefined>) => {
      if (path === "/A_SlsPrcgCndnRecdValidity") requests.push(params ?? {});
      return base.getAt(service, path, params);
    },
  };
  const catalog = new CatalogService(client as never, config, () => new Date("2026-07-20T00:00:00Z"));

  const page = await catalog.list("100001", salesArea, { page: 1, pageSize: 20, sort: "material" });

  assert.match(String(requests[0]?.["$filter"]), /Customer eq '0000100001'/);
  assert.match(String(requests[0]?.["$filter"]), /SalesOrganization eq '1310'/);
  assert.match(String(requests[0]?.["$filter"]), /DistributionChannel eq '10'/);
  assert.deepEqual(page.items.map((item) => item.product), ["000000000000001386", "000000000000001387"]);
});

test("loads A305 condition records before looking up their scoped price validities", async () => {
  const calls: Array<{ path: string; params?: Record<string, string | number | undefined> }> = [];
  const client = {
    getAt: async (_service: string, path: string, params?: Record<string, string | number | undefined>) => {
      calls.push({ path, params });
      if (path === "/A_SlsPrcgConditionRecord") {
        return { data: { results: [{ ConditionRecord: "0000000123", ConditionTable: "305", ConditionRateValue: "30.00", ConditionRateValueUnit: "CNY", ConditionQuantityUnit: "PC", ConditionIsDeleted: false }] } };
      }
      if (path === "/A_SlsPrcgCndnRecdValidity") {
        return { data: { results: [{ Material: "000000000000001386", Customer: "0000100001", SalesOrganization: "1310", DistributionChannel: "10", ConditionRecord: "0000000123", ConditionValidityStartDate: "/Date(1782777600000)/", ConditionValidityEndDate: "/Date(1790812800000)/" }] } };
      }
      if (path === "/A_ProductDescription") return { data: { results: [{ ProductDescription: "演示物料" }] } };
      if (path === "/A_Product('000000000000001386')") {
        return { data: { Product: "000000000000001386", ProductGroup: "FG", BaseUnit: "PC" } };
      }
      throw new Error(`Unexpected request ${path}`);
    },
  };
  const catalog = new CatalogService(client as never, config, () => new Date("2026-07-20T00:00:00Z"));

  const page = await catalog.list("100001", salesArea, { page: 1, pageSize: 20, sort: "material" });

  assert.equal(calls[0]?.path, "/A_SlsPrcgConditionRecord");
  assert.match(String(calls[0]?.params?.["$filter"]), /ConditionTable eq '305'/);
  assert.match(String(calls[0]?.params?.["$filter"]), /ConditionType eq 'PR00'/);
  assert.equal(calls[1]?.path, "/A_SlsPrcgCndnRecdValidity");
  assert.deepEqual(page.items.map((item) => item.product), ["000000000000001386"]);
});

test("scopes A305 catalog pricing to the selected customer sales organization and PR00", async () => {
  const calls: Array<{ path: string; params?: Record<string, string | number | undefined> }> = [];
  const client = {
    getAt: async (_service: string, path: string, params?: Record<string, string | number | undefined>) => {
      calls.push({ path, params });
      if (path === "/A_SlsPrcgConditionRecord") return { data: { results: [] } };
      if (path === "/A_SlsPrcgCndnRecdValidity") return { data: { results: [] } };
      throw new Error(`Unexpected request ${path}`);
    },
  };
  const catalog = new CatalogService(client as never, config);

  await catalog.list("100001", { salesOrganization: "9999", distributionChannel: "10", division: "00", key: "9999/10/00" }, { page: 1, pageSize: 20, sort: "material" });

  assert.match(String(calls[0]?.params?.["$filter"]), /ConditionType eq 'PR00'/);
  assert.match(String(calls[1]?.params?.["$filter"]), /ConditionType eq 'PR00'/);
  assert.match(String(calls[1]?.params?.["$filter"]), /SalesOrganization eq '9999'/);
});

test("accepts SAP price-validity customer numbers returned without leading zeroes", async () => {
  const client = {
    getAt: async (_service: string, path: string) => {
      if (path === "/A_SlsPrcgConditionRecord") return { data: { results: [{ ConditionRecord: "0000000123", ConditionTable: "305", ConditionRateValue: "30.00", ConditionRateValueUnit: "CNY", ConditionQuantityUnit: "PC", ConditionIsDeleted: false }] } };
      if (path === "/A_SlsPrcgCndnRecdValidity") return { data: { results: [{ Material: "000000000000001386", Customer: "100001", SalesOrganization: "1310", DistributionChannel: "10", ConditionRecord: "0000000123", ConditionValidityStartDate: "/Date(1782777600000)/", ConditionValidityEndDate: "/Date(1790812800000)/" }] } };
      if (path === "/A_ProductDescription") return { data: { results: [{ ProductDescription: "演示物料" }] } };
      if (path === "/A_Product('000000000000001386')") return { data: { Product: "000000000000001386", ProductGroup: "FG", BaseUnit: "PC" } };
      throw new Error(`Unexpected request ${path}`);
    },
  };
  const catalog = new CatalogService(client as never, config, () => new Date("2026-07-20T00:00:00Z"));

  const page = await catalog.list("0000100001", { salesOrganization: "1310", distributionChannel: "10", division: "00", key: "1310/10/00" }, { page: 1, pageSize: 20, sort: "material" });

  assert.equal(page.total, 1);
});

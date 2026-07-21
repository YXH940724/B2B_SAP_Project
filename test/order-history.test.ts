import assert from "node:assert/strict";
import test from "node:test";
import { OrderHistoryService } from "../src/order-history.js";

function fakeSapOrders() {
  const calls: Array<{ path: string; params?: Record<string, string | number | undefined> }> = [];
  const ownOrders = Array.from({ length: 11 }, (_, index) => ({
    SalesOrder: String(1372 + index).padStart(10, "0"),
    SalesOrderType: "OR",
    CreationDate: `2026-07-${String(index + 1).padStart(2, "0")}`,
    SoldToParty: "0000100001",
    SalesOrganization: "1310",
    DistributionChannel: "10",
    OrganizationDivision: "00",
    PurchaseOrderByCustomer: `PO-${index + 1}`,
    TotalNetAmount: String((index + 1) * 100),
    TransactionCurrency: "CNY",
    OverallSDProcessStatus: index === 0 ? "B" : "A",
    OverallDeliveryStatus: index === 0 ? "B" : "A",
    OverallOrdReltdBillgStatus: "A",
  }));
  return {
    calls,
    get: async (path: string, params?: Record<string, string | number | undefined>) => {
      calls.push({ path, params });
      return { data: { results: [...ownOrders, {
        SalesOrder: "0000009999", CreationDate: "2026-07-20", SoldToParty: "0000100002", SalesOrganization: "1310",
        TotalNetAmount: "9999", TransactionCurrency: "CNY", OverallSDProcessStatus: "C",
      }] } };
    },
  };
}

function fakeForeignOrderDetail() {
  return {
    get: async (path: string) => {
      assert.equal(path, "/A_SalesOrder('0000001372')");
      return { data: { SalesOrder: "0000001372", SoldToParty: "0000100002" } };
    },
  };
}

test("filters only the logged-in customer's orders and paginates the mapped SAP rows", async () => {
  const client = fakeSapOrders();
  const service = new OrderHistoryService(client, () => new Date("2026-07-21T00:00:00.000Z"));

  const result = await service.list("100001", { page: 2, pageSize: 10, salesOrganization: "1310", sort: "total:desc" });

  assert.match(String(client.calls[0].params?.$filter), /0000100001/);
  assert.equal(result.page, 2);
  assert.equal(result.pageSize, 10);
  assert.equal(result.total, 11);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].salesOrganization, "1310");
  assert.equal(result.dashboard.orderCount, 11);
  assert.equal(result.insights.topSalesOrganizations[0].salesOrganization, "1310");
});

test("rejects an order detail whose SAP sold-to party differs from the session customer", async () => {
  const service = new OrderHistoryService(fakeForeignOrderDetail());

  await assert.rejects(() => service.detail("100001", "1372"), /订单不存在/);
});

import assert from "node:assert/strict";
import test from "node:test";
import { OrderHistoryService } from "../src/order-history.js";

test("combines SAP history with portal submissions and calculates a twelve-month dashboard", async () => {
  const service = new OrderHistoryService({
    get: async () => ({ data: { results: [
      { SalesOrder: "0000001372", CreationDate: "2026-06-15", TotalNetAmount: "120.00", TransactionCurrency: "CNY", OverallSDProcessStatus: "A", SalesOrganization: "1310" },
      { SalesOrder: "0000001371", CreationDate: "2025-01-01", TotalNetAmount: "999.00", TransactionCurrency: "CNY", OverallSDProcessStatus: "C", SalesOrganization: "1310" },
    ] } }),
  }, () => new Date("2026-07-21T00:00:00.000Z"));
  service.recordPortalSubmission({ customer: "0000100001", salesOrder: "0000002001", createdAt: "2026-07-20", salesOrganization: "1310", total: 50, currency: "CNY", status: "已同步" });

  const history = await service.list("0000100001");

  assert.equal(history.sapOrders.length, 1);
  assert.equal(history.portalOrders.length, 1);
  assert.equal(history.dashboard.orderCount, 2);
  assert.equal(history.dashboard.totalAmount, 170);
  assert.equal(history.dashboard.months.at(-1)?.month, "2026-07");
});

import assert from "node:assert/strict";
import test from "node:test";
import { OrderHistoryService } from "../src/order-history.js";

test("reads only SAP orders for the normalized customer and calculates a twelve-month dashboard", async () => {
  const calls: Array<Record<string, string | number | undefined>> = [];
  const service = new OrderHistoryService({
    get: async (_path, params) => {
      calls.push(params ?? {});
      return { data: { results: [
        { SalesOrder: "0000001372", CreationDate: "2026-06-15", SoldToParty: "0000100001", TotalNetAmount: "120.00", TransactionCurrency: "CNY", OverallSDProcessStatus: "A", SalesOrganization: "1310" },
        { SalesOrder: "0000001373", CreationDate: "2026-06-16", SoldToParty: "0000100002", TotalNetAmount: "999.00", TransactionCurrency: "CNY", OverallSDProcessStatus: "A", SalesOrganization: "1310" },
      ] } };
    },
  }, () => new Date("2026-07-21T00:00:00.000Z"));

  const history = await service.list("100001");

  assert.match(String(calls[0].$filter), /0000100001/);
  assert.equal(history.sapOrders.length, 1);
  assert.equal("portalOrders" in history, false);
  assert.equal(history.dashboard.orderCount, 1);
  assert.equal(history.dashboard.totalAmount, 120);
  assert.equal(history.dashboard.months.at(-1)?.month, "2026-07");
});

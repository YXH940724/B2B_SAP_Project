import assert from "node:assert/strict";
import test from "node:test";
import { createAuthStore } from "../src/auth-store.js";

test("persists one mall parent order and two sales-area children atomically", () => {
  const store = createAuthStore(":memory:");
  store.createMallOrder({ id: "MALL-20260721-ABCDEF12", customer: "0000100001", now: 1 }, [
    { id: "MALL-20260721-ABCDEF12-01", salesArea: "1310/10/00", requestJson: "{}" },
    { id: "MALL-20260721-ABCDEF12-02", salesArea: "2000/10/00", requestJson: "{}" },
  ]);

  const order = store.getMallOrder("0000100001", "MALL-20260721-ABCDEF12");
  assert.deepEqual(order?.children.map((child) => [child.id, child.status, child.salesArea]), [
    ["MALL-20260721-ABCDEF12-01", "PENDING", "1310/10/00"],
    ["MALL-20260721-ABCDEF12-02", "PENDING", "2000/10/00"],
  ]);
  store.close();
});

test("keeps completed SAP order number when a child is loaded again", () => {
  const store = createAuthStore(":memory:");
  store.createMallOrder({ id: "MALL-20260721-ABCDEF12", customer: "0000100001", now: 1 }, [
    { id: "MALL-20260721-ABCDEF12-01", salesArea: "1310/10/00", requestJson: "{}" },
  ]);
  store.markMallOrderChildSubmitted("MALL-20260721-ABCDEF12-01", "0000001394", 2);
  assert.equal(store.getMallOrderChild("MALL-20260721-ABCDEF12-01")?.sapSalesOrder, "0000001394");
  store.close();
});

test("reserves a marketplace parent ID only once", () => {
  const store = createAuthStore(":memory:");
  store.reserveMallOrder("0000100001", "MALL-20260721-ABCDEF12", 1);
  assert.throws(() => store.reserveMallOrder("0000100001", "MALL-20260721-ABCDEF12", 2), /已存在/);
  store.close();
});

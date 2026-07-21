import assert from "node:assert/strict";
import test from "node:test";
import { createAuthStore } from "../src/auth-store.js";
import { MallOrderSubmissionService } from "../src/mall-orders.js";

const area = { salesOrganization: "1310", distributionChannel: "10", division: "00", key: "1310/10/00" };

function submission(mallOrderId = "MALL-20260721-ABCDEF12") {
  return {
    mallOrderId,
    customer: "0000100001",
    groups: [{
      salesArea: area,
      payload: {
        sales_order_type: "OR", sales_organization: "1310", distribution_channel: "10", organization_division: "00", sold_to_party: "0000100001",
        items: [{ material: "361", requested_quantity: 1, requested_quantity_unit: "PC" }], dry_run: false, response_format: "json" as const,
      },
    }],
  };
}

test("does not call SAP POST again when the local child was already submitted", async () => {
  const store = createAuthStore(":memory:");
  store.createMallOrder({ id: "MALL-20260721-ABCDEF12", customer: "0000100001", now: 1 }, [
    { id: "MALL-20260721-ABCDEF12-01", salesArea: area.key, requestJson: "{}" },
  ]);
  store.markMallOrderChildSubmitted("MALL-20260721-ABCDEF12-01", "0000001394", 2);
  const writes: unknown[] = [];
  const service = new MallOrderSubmissionService(store, {
    get: async () => { throw new Error("completed child must not be queried"); },
    write: async (_method: never, _path: string, payload: unknown) => { writes.push(payload); return { data: { SalesOrder: "0000001394" } }; },
  } as never, () => 3);

  const result = await service.submit(submission());
  assert.equal(result.groups[0].salesOrder, "0000001394");
  assert.equal(result.groups[0].status, "SUBMITTED");
  assert.equal(writes.length, 0);
  store.close();
});

test("recovers a lost create response by finding the child ID in SAP before retrying POST", async () => {
  const store = createAuthStore(":memory:");
  const writes: unknown[] = [];
  const service = new MallOrderSubmissionService(store, {
    get: async () => ({ data: { d: { results: [{ SalesOrder: "0000001394" }] } } }),
    write: async (_method: never, _path: string, payload: unknown) => { writes.push(payload); throw new Error("POST must not run"); },
  } as never, () => 3);

  const result = await service.submit(submission());
  assert.equal(result.groups[0].salesOrder, "0000001394");
  assert.equal(result.groups[0].status, "SUBMITTED");
  assert.equal(writes.length, 0);
  assert.equal(store.getMallOrderChild("MALL-20260721-ABCDEF12-01")?.sapSalesOrder, "0000001394");
  store.close();
});

test("recognizes the OData results envelope returned by the SAP client", async () => {
  const store = createAuthStore(":memory:");
  const service = new MallOrderSubmissionService(store, {
    get: async () => ({ data: { results: [{ SalesOrder: "0000001394" }] } }),
    write: async () => { throw new Error("POST must not run"); },
  } as never, () => 3);

  const result = await service.submit(submission());
  assert.equal(result.groups[0].salesOrder, "0000001394");
  store.close();
});

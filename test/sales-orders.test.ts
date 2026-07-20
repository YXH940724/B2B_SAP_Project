import assert from "node:assert/strict";
import test from "node:test";
import https from "node:https";
import type { SapConfig } from "../src/config.js";
import { assertWriteAllowed, createPayload, normalizeSalesOrder, salesOrderPath } from "../src/sales-orders.js";

const guardedConfig: SapConfig = {
  baseUrl: "https://sap.example.com/service", client: "200", username: "user", password: "secret", timeoutMs: 30000,
  writeEnabled: false, writeAllowedFields: new Set(["PurchaseOrderByCustomer"]), httpsAgent: new https.Agent(),
};

test("normalizes SAP sales order IDs to ten digits", () => {
  assert.equal(normalizeSalesOrder("1372"), "0000001372");
  assert.equal(salesOrderPath("1372"), "/A_SalesOrder('0000001372')");
});

test("creates a deep-insert payload with header and line item", () => {
  const payload = createPayload({
    sales_order_type: "OR", sales_organization: "1000", distribution_channel: "10", organization_division: "00", sold_to_party: "100001",
    items: [{ material: "MAT-01", requested_quantity: 2, requested_quantity_unit: "EA", plant: "1000" }],
    dry_run: true, response_format: "json",
  });
  assert.deepEqual(payload, {
    SalesOrderType: "OR", SalesOrganization: "1000", DistributionChannel: "10", OrganizationDivision: "00", SoldToParty: "100001",
    to_Item: { results: [{ Material: "MAT-01", RequestedQuantity: "2", RequestedQuantityUnit: "EA", Plant: "1000" }] },
  });
});

test("requires both the write switch and confirmation phrase", () => {
  assert.throws(() => assertWriteAllowed(guardedConfig, "UPDATE_SALES_ORDER", "UPDATE_SALES_ORDER"), /writes are disabled/);
  const enabled = { ...guardedConfig, writeEnabled: true };
  assert.throws(() => assertWriteAllowed(enabled, undefined, "UPDATE_SALES_ORDER"), /Set confirm/);
  assert.throws(() => assertWriteAllowed(enabled, "UPDATE_SALES_ORDER", "UPDATE_SALES_ORDER", { SoldToParty: "100001" }), /not allowed/);
  assert.doesNotThrow(() => assertWriteAllowed(enabled, "UPDATE_SALES_ORDER", "UPDATE_SALES_ORDER", { PurchaseOrderByCustomer: "PO-1" }));
});

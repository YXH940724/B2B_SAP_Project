import assert from "node:assert/strict";
import test from "node:test";
import https from "node:https";
import type { SapConfig } from "../src/config.js";
import { assertWriteAllowed, createPayload, normalizeSalesOrder, salesOrderPath } from "../src/sales-orders.js";
import { getCustomer, getProduct, normalizeCustomer } from "../src/master-data.js";

const guardedConfig: SapConfig = {
  baseUrl: "https://sap.example.com/service", client: "200", username: "user", password: "secret", timeoutMs: 30000,
  writeEnabled: false, writeAllowedFields: new Set(["PurchaseOrderByCustomer"]), httpsAgent: new https.Agent(),
  services: { product: "https://sap.example.com/product", businessPartner: "https://sap.example.com/bp", pricing: "https://sap.example.com/pricing" },
};

test("normalizes SAP sales order IDs to ten digits", () => {
  assert.equal(normalizeSalesOrder("1372"), "0000001372");
  assert.equal(salesOrderPath("1372"), "/A_SalesOrder('0000001372')");
});

test("normalizes numeric SAP customer IDs to ten digits", () => {
  assert.equal(normalizeCustomer("100001"), "0000100001");
  assert.equal(normalizeCustomer("0000100001"), "0000100001");
  assert.equal(normalizeCustomer(" A'B "), "A'B");
});

test("creates a deep-insert payload with header and line item", () => {
  const payload = createPayload({
    sales_order_type: "OR", sales_organization: "1000", distribution_channel: "10", organization_division: "00", sold_to_party: "100001",
    items: [{ material: "MAT-01", requested_quantity: 2, requested_quantity_unit: "EA", production_plant: "1000" }],
    dry_run: true, response_format: "json",
  });
  assert.deepEqual(payload, {
    SalesOrderType: "OR", SalesOrganization: "1000", DistributionChannel: "10", OrganizationDivision: "00", SoldToParty: "100001",
    to_Item: { results: [{ Material: "MAT-01", RequestedQuantity: "2", RequestedQuantityUnit: "EA", ProductionPlant: "1000" }] },
  });
});

test("maps purchase reference and requested delivery date into the SAP payload", () => {
  const payload = createPayload({
    sales_order_type: "OR", sales_organization: "1000", distribution_channel: "10", organization_division: "00", sold_to_party: "0000100001",
    purchase_order_by_customer: "PO-2026-01", requested_delivery_date: "2026-08-01",
    items: [{ material: "000000000000001386", requested_quantity: 2, requested_quantity_unit: "PC" }],
    dry_run: false, response_format: "json",
  });
  assert.equal(payload.PurchaseOrderByCustomer, "PO-2026-01");
  assert.equal(payload.RequestedDeliveryDate, "2026-08-01T00:00:00");
});

test("maps order terms and fulfillment data into SAP sales-order fields", () => {
  const payload = createPayload({
    sales_order_type: "OR", sales_organization: "1310", distribution_channel: "10", organization_division: "00", sold_to_party: "100001",
    customer_payment_terms: "0001", incoterms_classification: "FOB", incoterms_version: "2020", incoterms_location: "Shanghai",
    items: [{ material: "MAT-01", requested_quantity: 2, requested_quantity_unit: "EA", customer_material: "CUST-MAT-01", production_plant: "1310", storage_location: "0001" }],
    dry_run: true, response_format: "json",
  });
  assert.equal(payload.CustomerPaymentTerms, "0001");
  assert.equal(payload.IncotermsClassification, "FOB");
  assert.equal(payload.IncotermsVersion, "2020");
  assert.equal(payload.IncotermsTransferLocation, "Shanghai");
  assert.deepEqual(payload.to_Item, { results: [{ Material: "MAT-01", RequestedQuantity: "2", RequestedQuantityUnit: "EA", MaterialByCustomer: "CUST-MAT-01", ProductionPlant: "1310", StorageLocation: "0001" }] });
});

test("requires both the write switch and confirmation phrase", () => {
  assert.throws(() => assertWriteAllowed(guardedConfig, "UPDATE_SALES_ORDER", "UPDATE_SALES_ORDER"), /writes are disabled/);
  const enabled = { ...guardedConfig, writeEnabled: true };
  assert.throws(() => assertWriteAllowed(enabled, undefined, "UPDATE_SALES_ORDER"), /Set confirm/);
  assert.throws(() => assertWriteAllowed(enabled, "UPDATE_SALES_ORDER", "UPDATE_SALES_ORDER", { SoldToParty: "100001" }), /not allowed/);
  assert.doesNotThrow(() => assertWriteAllowed(enabled, "UPDATE_SALES_ORDER", "UPDATE_SALES_ORDER", { PurchaseOrderByCustomer: "PO-1" }));
});

test("escapes OData key quotes for product and customer reads", async () => {
  const calls: Array<{ path: string; params?: Record<string, string> }> = [];
  const client = { getAt: async (_base: string, path: string, params?: Record<string, string>) => { calls.push({ path, params }); return { data: {} }; } };
  const config = guardedConfig;
  await getProduct(client as never, config, "A'B");
  await getCustomer(client as never, config, "C'1");
  assert.deepEqual(calls.map(({ path }) => path), ["/A_Product('A''B')", "/A_Customer('C''1')"]);
  assert.doesNotMatch(calls[1].params?.["$select"] ?? "", /LastChangeDate/);
});

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

function fakeOrderDetailWithUnmaintainedOptionalFields() {
  return {
    get: async (path: string) => {
      if (path === "/A_SalesOrder('0000001372')") {
        return {
          data: {
            SalesOrder: "0000001372",
            SalesOrderType: "OR",
            CreationDate: "2026-07-01",
            SoldToParty: "0000100001",
            SalesOrganization: "1310",
            DistributionChannel: "10",
            OrganizationDivision: "00",
            PurchaseOrderByCustomer: "  ",
            TotalNetAmount: "100",
            TransactionCurrency: "CNY",
            RequestedDeliveryDate: " ",
            CustomerPurchaseOrderDate: "\t",
          },
        };
      }
      assert.equal(path, "/A_SalesOrder('0000001372')/to_Item");
      return {
        data: {
          results: [{
            SalesOrderItem: "000010",
            Material: "",
            SalesOrderItemText: " ",
            RequestedQuantity: "2",
            RequestedQuantityUnit: "",
            OrderQuantityUnit: "\t",
            NetPriceAmount: " ",
            NetAmount: "200",
            TransactionCurrency: "",
            OverallDeliveryStatus: "A",
          }],
        },
      };
    },
  };
}

function fakeMixedCurrencyOrders() {
  return {
    get: async () => ({
      data: {
        results: [
          {
            SalesOrder: "0000001372", SalesOrderType: "OR", CreationDate: "2026-07-01", SoldToParty: "0000100001",
            SalesOrganization: "1310", DistributionChannel: "10", OrganizationDivision: "00", TotalNetAmount: "100", TransactionCurrency: "CNY",
            OverallSDProcessStatus: "A", OverallDeliveryStatus: "A", OverallOrdReltdBillgStatus: "A",
          },
          {
            SalesOrder: "0000001373", SalesOrderType: "OR", CreationDate: "2026-07-02", SoldToParty: "0000100001",
            SalesOrganization: "1310", DistributionChannel: "10", OrganizationDivision: "00", TotalNetAmount: "25", TransactionCurrency: "USD",
            OverallSDProcessStatus: "B", OverallDeliveryStatus: "B", OverallOrdReltdBillgStatus: "A",
          },
        ],
      },
    }),
  };
}

function fakeStructuredOrderDetail() {
  return {
    get: async (path: string) => {
      if (path === "/A_SalesOrder('0000001372')") {
        return { data: {
          SalesOrder: "0000001372", SoldToParty: "0000100001", SalesOrderType: "OR", CreationDate: "2026-07-01",
          SalesOrganization: "1310", DistributionChannel: "10", OrganizationDivision: "00", TotalNetAmount: "100", TransactionCurrency: "CNY",
          CustomerPaymentTerms: "0001", IncotermsClassification: "FOB", IncotermsVersion: "2020", IncotermsTransferLocation: "上海",
        } };
      }
      assert.equal(path, "/A_SalesOrder('0000001372')/to_Item");
      return { data: { results: [{
        SalesOrderItem: "000010", Material: "000000000000001386", SalesOrderItemText: "工业零件", RequestedQuantity: "2", RequestedQuantityUnit: "PC",
        NetPriceAmount: "50", NetAmount: "100", TransactionCurrency: "CNY", OverallDeliveryStatus: "B",
        MaterialByCustomer: "CUST-1386", ProductionPlant: "1310", StorageLocation: "0001", TaxCode: "J0", TaxRate: "13", TaxAmount: "13",
      }] } };
    },
  };
}

function fakeOrderDetailWithPricingElements() {
  return {
    get: async (path: string, params?: Record<string, string | number | undefined>) => {
      if (path === "/A_SalesOrder('0000001372')") {
        return { data: { SalesOrder: "0000001372", SoldToParty: "0000100001", SalesOrderType: "OR", CreationDate: "2026-07-01", SalesOrganization: "1310", DistributionChannel: "10", OrganizationDivision: "00", TotalNetAmount: "100", TransactionCurrency: "CNY" } };
      }
      if (path === "/A_SalesOrder('0000001372')/to_Item") {
        return { data: { results: [{ SalesOrderItem: "000010", Material: "000000000000001386", RequestedQuantity: "2", RequestedQuantityUnit: "PC", NetAmount: "100", TransactionCurrency: "CNY" }] } };
      }
      assert.equal(path, "/A_SalesOrderItemPrElement");
      assert.match(String(params?.$filter), /SalesOrder eq '0000001372'/);
      return { data: { results: [
        { SalesOrderItem: "000010", ConditionType: "ZR01", ConditionAmount: "100" },
        { SalesOrderItem: "000010", ConditionType: "ZWSI", TaxCode: "J0", ConditionRateValue: "13", ConditionAmount: "13" },
      ] } };
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

test("filters current customer orders by the complete sales area", async () => {
  const service = new OrderHistoryService(fakeSapOrders(), () => new Date("2026-07-21T00:00:00.000Z"));

  const matching = await service.list("100001", {
    page: 1, pageSize: 20, salesOrganization: "1310", distributionChannel: "10", division: "00", sort: "createdAt:desc",
  });
  const otherChannel = await service.list("100001", {
    page: 1, pageSize: 20, salesOrganization: "1310", distributionChannel: "20", division: "00", sort: "createdAt:desc",
  });

  assert.equal(matching.total, 11);
  assert.equal(otherChannel.total, 0);
});

test("rejects an order detail whose SAP sold-to party differs from the session customer", async () => {
  const service = new OrderHistoryService(fakeForeignOrderDetail());

  await assert.rejects(() => service.detail("100001", "1372"), (error: unknown) => {
    assert.equal((error as { code?: unknown }).code, "ORDER_NOT_FOUND");
    assert.equal((error as { httpStatus?: unknown }).httpStatus, 404);
    assert.equal((error as Error).message, "订单不存在。");
    return true;
  });
});

test("maps a missing SAP order detail to the same safe 404 error contract", async () => {
  const service = new OrderHistoryService({
    get: async () => {
      throw Object.assign(new Error("SAP: Sales order 0000001372 does not exist"), { status: 404 });
    },
  });

  await assert.rejects(() => service.detail("100001", "1372"), (error: unknown) => {
    assert.equal((error as { code?: unknown }).code, "ORDER_NOT_FOUND");
    assert.equal((error as { httpStatus?: unknown }).httpStatus, 404);
    assert.equal((error as Error).message, "订单不存在。");
    return true;
  });
});

test("maps an Axios-style missing order detail to a safe 404 error contract", async () => {
  const sensitiveSapMessage = "sensitive SAP text";
  const service = new OrderHistoryService({
    get: async () => {
      throw { response: { status: 404 }, message: sensitiveSapMessage };
    },
  });

  await assert.rejects(() => service.detail("100001", "1372"), (error: unknown) => {
    assert.equal((error as { code?: unknown }).code, "ORDER_NOT_FOUND");
    assert.equal((error as { httpStatus?: unknown }).httpStatus, 404);
    assert.doesNotMatch((error as Error).message, /sensitive SAP text/);
    return true;
  });
});

test("sanitizes SAP read errors from list and detail operations", async () => {
  const rawSapMessage = "SAP backend: customer 0000100001 authorization DENIED";
  const failingClient = {
    get: async (path: string) => {
      if (path === "/A_SalesOrder('0000001372')") {
        return { data: { SalesOrder: "0000001372", SoldToParty: "0000100001" } };
      }
      throw new Error(rawSapMessage);
    },
  };

  const listService = new OrderHistoryService(failingClient);
  await assert.rejects(() => listService.list("100001"), (error: unknown) => {
    assert.equal((error as { code?: unknown }).code, "SAP_READ_FAILED");
    assert.equal((error as { httpStatus?: unknown }).httpStatus, 502);
    assert.equal((error as Error).message, "暂时无法读取订单数据，请稍后重试。");
    assert.doesNotMatch((error as Error).message, /SAP backend|0000100001|DENIED/);
    return true;
  });

  const detailService = new OrderHistoryService(failingClient);
  await assert.rejects(() => detailService.detail("100001", "1372"), (error: unknown) => {
    assert.equal((error as { code?: unknown }).code, "SAP_READ_FAILED");
    assert.equal((error as { httpStatus?: unknown }).httpStatus, 502);
    assert.equal((error as Error).message, "暂时无法读取订单数据，请稍后重试。");
    assert.doesNotMatch((error as Error).message, /SAP backend|0000100001|DENIED/);
    return true;
  });
});

test("maps unmaintained optional SAP header and line fields to null", async () => {
  const service = new OrderHistoryService(fakeOrderDetailWithUnmaintainedOptionalFields());

  const detail = await service.detail("100001", "1372");

  assert.equal(detail.header.purchaseOrderByCustomer, null);
  assert.equal(detail.header.requestedDeliveryDate, null);
  assert.equal(detail.header.customerPurchaseOrderDate, null);
  assert.equal(detail.header.createdByUser, null);
  assert.equal(detail.header.paymentTerms, null);
  assert.equal(detail.header.incotermsClassification, null);
  assert.equal(detail.header.incotermsVersion, null);
  assert.equal(detail.header.incotermsLocation, null);
  assert.deepEqual(detail.items[0], {
    item: "000010",
    material: null,
    description: null,
    quantity: 2,
    unit: null,
    netPrice: null,
    netAmount: 200,
    currency: null,
    deliveryStatus: { code: "A", label: "未处理", tone: "neutral" },
    customerMaterial: null,
    productionPlant: null,
    storageLocation: null,
    taxCode: null,
    taxRate: null,
    taxAmount: null,
  });
});

test("maps SAP order terms and fulfillment fields into a structured order detail", async () => {
  const service = new OrderHistoryService(fakeStructuredOrderDetail());

  const detail = await service.detail("100001", "1372");

  assert.equal(detail.header.paymentTerms, "0001");
  assert.equal(detail.header.incotermsClassification, "FOB");
  assert.equal(detail.header.incotermsVersion, "2020");
  assert.equal(detail.header.incotermsLocation, "上海");
  assert.deepEqual(detail.items[0], {
    item: "000010", material: "000000000000001386", description: "工业零件", quantity: 2, unit: "PC", netPrice: 50,
    netAmount: 100, currency: "CNY", deliveryStatus: { code: "B", label: "处理中", tone: "warning" },
    customerMaterial: "CUST-1386", productionPlant: "1310", storageLocation: "0001", taxCode: "J0", taxRate: 13, taxAmount: 13,
  });
});

test("derives item tax rate and amount from read-only SAP pricing elements", async () => {
  const detail = await new OrderHistoryService(fakeOrderDetailWithPricingElements()).detail("100001", "1372");

  assert.equal(detail.items[0].taxCode, "J0");
  assert.equal(detail.items[0].taxRate, 13);
  assert.equal(detail.items[0].taxAmount, 13);
});

test("keeps CNY and USD dashboard and sales-organization totals separate", async () => {
  const service = new OrderHistoryService(fakeMixedCurrencyOrders(), () => new Date("2026-07-21T00:00:00.000Z"));

  const result = await service.list("100001");
  const salesOrganization = result.insights.topSalesOrganizations[0];

  assert.deepEqual(result.dashboard.totalsByCurrency, [
    { currency: "CNY", orderCount: 1, totalAmount: 100, averageAmount: 100 },
    { currency: "USD", orderCount: 1, totalAmount: 25, averageAmount: 25 },
  ]);
  assert.equal(result.dashboard.totalAmount, undefined);
  assert.equal(result.dashboard.averageAmount, undefined);
  assert.equal(result.dashboard.currency, undefined);
  const july = result.dashboard.months.find((month) => month.month === "2026-07");
  assert.deepEqual(july?.totalsByCurrency, result.dashboard.totalsByCurrency);
  assert.equal(july?.totalAmount, undefined);
  assert.equal(july?.currency, undefined);
  assert.deepEqual(salesOrganization.totalsByCurrency, [
    { currency: "CNY", orderCount: 1, totalAmount: 100, averageAmount: 100 },
    { currency: "USD", orderCount: 1, totalAmount: 25, averageAmount: 25 },
  ]);
  assert.equal(salesOrganization.totalAmount, undefined);
  assert.equal(salesOrganization.currency, undefined);
});

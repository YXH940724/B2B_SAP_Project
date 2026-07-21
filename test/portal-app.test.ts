import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import request from "supertest";
import { AuthService } from "../src/auth-service.js";
import { createAuthStore } from "../src/auth-store.js";
import { OrderHistoryError } from "../src/order-history.js";
import { createPortalApp } from "../src/portal-app.js";

function makeApp(): { app: ReturnType<typeof createPortalApp>; getCode: () => string } {
  let code = "";
  const auth = new AuthService(createAuthStore(":memory:"), () => 1_700_000_000_000, () => "123456");
  const app = createPortalApp({
    auth,
    contact: { get: async (customer: string) => ({ customer: customer.padStart(10, "0"), email: "buyer@example.test" }) },
    delivery: { send: async (_customer: string, sentCode: string) => { code = sentCode; } },
  });
  return { app, getCode: () => code };
}

function makeStorefrontApp(): { app: ReturnType<typeof createPortalApp>; getCode: () => string } {
  let code = "";
  const auth = new AuthService(createAuthStore(":memory:"), () => 1_700_000_000_000, () => "123456");
  const app = createPortalApp({
    auth,
    contact: { get: async (customer: string) => ({ customer: customer.padStart(10, "0"), email: "buyer@example.test" }) },
    delivery: { send: async (_customer: string, sentCode: string) => { code = sentCode; } },
    salesAreas: { list: async () => [{ salesOrganization: "1000", distributionChannel: "10", division: "00", key: "1000/10/00" }] },
    catalog: { list: async (customer: string, area: { key: string }) => {
      assert.equal(customer, "0000100001");
      assert.equal(area.key, "1000/10/00");
      return {
      items: [{ product: "000000000000001386", description: "演示物料", productGroup: "FG", baseUnit: "PC", conditionRecord: "0000000123", unitPrice: "30.00", currency: "CNY", priceUnit: "PC" }],
      groups: [{ code: "FG", label: "FG", count: 1 }], page: 1, pageSize: 20, total: 1, pageCount: 1,
      };
    } },
    customer: { get: async () => ({ customer: "0000100001", name: "演示客户", accountGroup: "Z001", businessPartner: "0000000046" }) },
    orderHistory: {
      list: async (customer: string, query) => ({
        items: [{
          salesOrder: "0000001372", salesOrderType: "OR", createdAt: "2026-07-01", salesOrganization: query?.salesOrganization ?? "1310",
          distributionChannel: "10", division: "00", purchaseOrderByCustomer: "PO-1", total: 100, currency: "CNY",
          overallStatus: { code: "A", label: "未处理", tone: "neutral" },
          deliveryStatus: { code: "A", label: "未处理", tone: "neutral" },
          billingStatus: { code: "A", label: "未处理", tone: "neutral" },
        }],
        page: query?.page ?? 1,
        pageSize: query?.pageSize ?? 20,
        total: customer === "0000100001" ? 1 : 0,
        pageCount: 1,
        dashboard: {
          orderCount: customer === "0000100001" ? 1 : 0,
          totalsByCurrency: [{ currency: "CNY", orderCount: 1, totalAmount: 100, averageAmount: 100 }],
          totalAmount: 100, averageAmount: 100, currency: "CNY", inFulfillmentCount: 0, months: [], statuses: [],
        },
        insights: { topSalesOrganizations: [], largestOrder: null, latestOrderDate: "2026-07-01", attentionCount: 1 },
      }),
      detail: async (customer: string, salesOrder: string) => {
        assert.equal(customer, "0000100001");
        if (salesOrder === "0000009999") throw new OrderHistoryError("ORDER_NOT_FOUND", 404, "订单不存在。");
        return {
          header: {
            salesOrder, salesOrderType: "OR", createdAt: "2026-07-01", salesOrganization: "1310", distributionChannel: "10", division: "00",
            purchaseOrderByCustomer: "PO-1", total: 100, currency: "CNY", overallStatus: { code: "A", label: "未处理", tone: "neutral" },
            deliveryStatus: { code: "A", label: "未处理", tone: "neutral" }, billingStatus: { code: "A", label: "未处理", tone: "neutral" },
            requestedDeliveryDate: null, customerPurchaseOrderDate: null, createdByUser: null,
          },
          items: [],
        };
      },
    },
  });
  return { app, getCode: () => code };
}

async function registeredAgent(factory: () => { app: ReturnType<typeof createPortalApp>; getCode: () => string }) {
  const { app, getCode } = factory();
  const agent = request.agent(app);
  await agent.post("/api/register/request-code").send({ customer: "100001" }).expect(202);
  await agent.post("/api/register/verify").send({ customer: "100001", code: getCode(), password: "123456789012" }).expect(201);
  await agent.post("/api/login").send({ customer: "100001", password: "123456789012" }).expect(200);
  return agent;
}

test("does not create a cookie when a portal login password is incorrect", async () => {
  const { app } = makeApp();
  const response = await request(app).post("/api/login").send({ customer: "100001", password: "wrong-password" });
  assert.equal(response.status, 401);
  assert.match(response.body.error, /客户号或密码/);
  assert.equal(response.headers["set-cookie"], undefined);
});

test("registers with a code then creates a secure session on login", async () => {
  const { app, getCode } = makeApp();
  await request(app).post("/api/register/request-code").send({ customer: "100001" }).expect(202);
  await request(app).post("/api/register/verify").send({ customer: "100001", code: getCode(), password: "123456789012" }).expect(201);
  const response = await request(app).post("/api/login").send({ customer: "100001", password: "123456789012" }).expect(200);
  assert.match(response.headers["set-cookie"][0], /HttpOnly/);
  assert.match(response.headers["set-cookie"][0], /SameSite=Lax/);
});

test("clears the current session on logout", async () => {
  const { app, getCode } = makeApp();
  await request(app).post("/api/register/request-code").send({ customer: "100001" }).expect(202);
  await request(app).post("/api/register/verify").send({ customer: "100001", code: getCode(), password: "123456789012" }).expect(201);
  const login = await request(app).post("/api/login").send({ customer: "100001", password: "123456789012" }).expect(200);
  const response = await request(app).post("/api/logout").set("Cookie", login.headers["set-cookie"][0]).expect(204);
  assert.match(response.headers["set-cookie"][0], /Max-Age=0/);
});

test("logs a sanitized registration failure in development", async () => {
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (message: string) => { errors.push(message); };
  try {
    const auth = new AuthService(createAuthStore(":memory:"));
    const app = createPortalApp({
      auth,
      contact: { get: async () => { throw new Error("SAP customer email lookup failed"); } },
      delivery: { send: async () => undefined },
      production: false,
    });
    await request(app).post("/api/register/request-code").send({ customer: "100001" }).expect(400);
    assert.deepEqual(errors, ["[portal] registration request failed: SAP customer email lookup failed"]);
  } finally {
    console.error = originalError;
  }
});

test("keeps authentication feedback outside the hidden order portal", () => {
  const html = fs.readFileSync(path.resolve(import.meta.dirname, "../public/index.html"), "utf8");
  assert.match(html, /id="auth-message"/);
  assert.doesNotMatch(html, /<section id="portal" hidden>[\s\S]*id="auth-message"/);
});

test("returns a session-protected, paginated catalog and customer summary", async () => {
  const agent = await registeredAgent(makeStorefrontApp);
  const areas = await agent.get("/api/sales-areas").expect(200);
  assert.equal(areas.body[0].key, "1000/10/00");
  const response = await agent.get("/api/catalog?salesOrganization=1000&distributionChannel=10&division=00&query=1386&group=FG&page=1&pageSize=20&sort=material").expect(200);
  assert.equal(response.body.items[0].product, "000000000000001386");
  assert.equal(response.body.groups[0].code, "FG");
  assert.equal(response.body.page, 1);
  assert.deepEqual((await agent.get("/api/me").expect(200)).body, {
    customer: "0000100001", name: "演示客户", accountGroup: "Z001", businessPartner: "0000000046",
  });
});

test("rejects catalog requests without a session and rejects invalid page size", async () => {
  await request(makeStorefrontApp().app).get("/api/catalog?pageSize=20").expect(401);
  await request(makeStorefrontApp().app).get("/api/customer-360").expect(401);
  const agent = await registeredAgent(makeStorefrontApp);
  await agent.get("/api/catalog?salesOrganization=1000&distributionChannel=10&division=00&pageSize=51").expect(400);
  await agent.get("/api/catalog?salesOrganization=9999&distributionChannel=10&division=00").expect(400);
});

test("rejects an invalid checkout delivery date before SAP pricing", async () => {
  const agent = await registeredAgent(makeStorefrontApp);
  const response = await agent.post("/api/orders/preview").send({
    items: [{ product: "1386", quantity: 1 }], requestedDeliveryDate: "2026/08/01",
  }).expect(400);
  assert.match(response.body.error, /期望交货日期/);
});

test("uses only the cookie session customer for filtered order history", async () => {
  const agent = await registeredAgent(makeStorefrontApp);
  const response = await agent.get("/api/orders/history?page=1&pageSize=10&salesOrganization=1310&customer=0000000002").expect(200);
  assert.equal(response.body.items[0].salesOrder, "0000001372");
  assert.equal(response.body.total, 1);
  assert.equal(response.body.page, 1);
  assert.equal(response.body.pageSize, 10);
  assert.equal(response.body.dashboard.totalAmount, 100);
  assert.deepEqual(response.body.dashboard.totalsByCurrency, [{ currency: "CNY", orderCount: 1, totalAmount: 100, averageAmount: 100 }]);
  await request(makeStorefrontApp().app).get("/api/orders/history").expect(401);
});

test("returns 404 when the selected sales order is not owned by the logged-in customer", async () => {
  const agent = await registeredAgent(makeStorefrontApp);
  const response = await agent.get("/api/orders/0000009999").expect(404);
  assert.equal(response.body.error, "订单不存在。");
});

test("serves the storefront navigation, catalog controls, cart and checkout fields", () => {
  const html = fs.readFileSync(path.resolve(import.meta.dirname, "../public/index.html"), "utf8");
  const script = fs.readFileSync(path.resolve(import.meta.dirname, "../public/app.js"), "utf8");
  assert.match(html, /id="sales-area-select"/);
  assert.match(script, /api\/sales-areas/);
  assert.match(script, /salesOrganization === "1310" && area\.distributionChannel === "10"/);
  assert.match(script, /salesOrganization/);
  assert.match(html, /id="catalog-search"/);
  assert.match(html, /id="material-groups"/);
  assert.match(html, /id="catalog-grid"/);
  assert.match(html, /id="catalog-pagination"/);
  assert.match(html, /id="cart-items"/);
  assert.match(html, /id="requested-delivery-date"/);
  assert.match(html, /id="purchase-order-by-customer"/);
  assert.match(html, /id="portal-note"/);
});

test("serves independent order-entry and customer-360 views", () => {
  const html = fs.readFileSync(path.resolve(import.meta.dirname, "../public/index.html"), "utf8");
  const script = fs.readFileSync(path.resolve(import.meta.dirname, "../public/app.js"), "utf8");
  assert.match(html, /id="view-order-entry"/);
  assert.match(html, /id="view-customer-360"/);
  assert.match(html, /id="customer-business-illustration"/);
  assert.match(html, /id="order-header-form"/);
  assert.match(html, /id="order-line-items"/);
  assert.match(script, /function showView/);
  assert.match(script, /api\/customer-360/);
});

test("serves an SAP-only order center", () => {
  const html = fs.readFileSync(path.resolve(import.meta.dirname, "../public/index.html"), "utf8");
  const script = fs.readFileSync(path.resolve(import.meta.dirname, "../public/app.js"), "utf8");
  assert.match(html, /id="view-orders"/);
  assert.match(html, /id="order-dashboard-summary"/);
  assert.match(html, /id="sap-orders-list"/);
  assert.doesNotMatch(html, /id="portal-orders-list"/);
  assert.match(script, /api\/orders\/history/);
  assert.match(script, /function renderOrderDashboard/);
});

test("serves the rich SAP order workbench controls", () => {
  const html = fs.readFileSync(path.resolve(import.meta.dirname, "../public/index.html"), "utf8");
  for (const id of ["order-filter-form", "order-list", "order-pagination", "order-insights", "order-detail-dialog", "order-detail-lines"]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
});

test("serves filter, pagination and detail renderers for the order workbench", () => {
  const script = fs.readFileSync(path.resolve(import.meta.dirname, "../public/app.js"), "utf8");
  for (const name of ["function renderOrderWorkbench", "function openOrderDetail", "api(`/api/orders/${salesOrder}`)", "order-filter-form"]) {
    assert.match(script, new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("keeps inactive portal views visually hidden", () => {
  const styles = fs.readFileSync(path.resolve(import.meta.dirname, "../public/view-visibility.css"), "utf8");
  assert.match(styles, /\[hidden\]\{display:none!important\}/);
});

test("keeps storefront informational feedback separate from authentication error styling", () => {
  const styles = fs.readFileSync(path.resolve(import.meta.dirname, "../public/styles.css"), "utf8");
  assert.match(styles, /#auth-message\{[^}]*color:#b42318/);
  assert.doesNotMatch(styles, /#auth-message,#portal-message\{[^}]*color:#b42318/);
});

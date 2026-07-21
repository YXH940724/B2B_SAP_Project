# SAP 客户订单工作台 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将客户订单中心升级为带筛选、分页、分析指标和按需订单详情/行项目的 SAP 只读订单工作台。

**Architecture:** `OrderHistoryService` 仍是 SAP 订单唯一读模型，但扩展为分页列表、摘要分析和订单详情三个显式方法。Express 路由从登录会话取得客户号并校验订单归属；浏览器只传递非敏感筛选参数与订单号。前端保持单页门户，通过订单中心的筛选栏、列表和 `<dialog>` 详情抽屉呈现渐进加载结果。

**Tech Stack:** TypeScript、Express、Axios、Zod、node:test、Supertest、原生 HTML/CSS/JavaScript、Playwright。

## Global Constraints

- SAP 是订单唯一事实来源；不得写入或缓存门户订单副本。
- 所有订单查询从会话客户号过滤；浏览器参数不得包含或覆盖客户号。
- 默认查询最近 12 个月，每页 20 条，允许页大小为 10、20、50。
- 订单详情必须在读取 SAP 抬头后复核 `SoldToParty`；不匹配时返回 404。
- 生产环境保持 TLS 验证开启；测试环境例外必须显式配置。
- 不输出 SAP 凭据、Cookie、完整 SAP 原始错误体或其他客户订单明细。

---

## File Structure

- Modify `src/order-history.ts`：定义订单列表、筛选、分析和详情的专属类型；解析 SAP OData；执行客户隔离。
- Modify `src/portal-app.ts`：解析已登录用户的订单筛选参数，提供列表与详情只读端点。
- Modify `public/index.html`：添加订单筛选、指标、洞察、分页和详情对话框语义结构。
- Modify `public/app.js`：加载、渲染和切换订单工作台状态；不在浏览器保存客户号。
- Modify `public/order-center.css`：订单工作台、状态徽章、响应式指标网格和详情抽屉样式。
- Modify `test/order-history.test.ts`：覆盖 SAP 映射、筛选、分页、聚合和详情隔离。
- Modify `test/portal-app.test.ts`：覆盖会话保护、参数约束、订单详情归属与静态页面钩子。
- Create `test/order-workbench-ui.test.py`：Playwright 模拟 API 的浏览器交互验证。

## Interfaces

```ts
export type OrderStatus = { code: string; label: string; tone: "success" | "warning" | "danger" | "neutral" };

export type OrderQuery = {
  page: number;
  pageSize: 10 | 20 | 50;
  from?: string;
  to?: string;
  salesOrganization?: string;
  overallStatus?: string;
  deliveryStatus?: string;
  query?: string;
  sort: "createdAt:desc" | "createdAt:asc" | "total:desc" | "total:asc";
};

export type OrderSummary = {
  salesOrder: string;
  salesOrderType: string;
  createdAt: string;
  salesOrganization: string;
  distributionChannel: string;
  division: string;
  purchaseOrderByCustomer: string | null;
  total: number;
  currency: string;
  overallStatus: OrderStatus;
  deliveryStatus: OrderStatus;
  billingStatus: OrderStatus;
};

export type PaginatedOrderHistory = {
  items: OrderSummary[];
  page: number;
  pageSize: number;
  total: number;
  pageCount: number;
  dashboard: OrderDashboard;
  insights: OrderInsights;
};

export type OrderDetail = {
  header: OrderSummary & { requestedDeliveryDate: string | null; customerPurchaseOrderDate: string | null; createdByUser: string | null };
  items: Array<{ item: string; material: string | null; description: string | null; quantity: number; unit: string | null; netPrice: number | null; netAmount: number; currency: string | null; deliveryStatus: OrderStatus }>;
};

export type OrderDashboard = {
  orderCount: number;
  totalAmount: number;
  averageAmount: number;
  currency: string;
  inFulfillmentCount: number;
  months: Array<{ month: string; orderCount: number; totalAmount: number }>;
  statuses: Array<{ status: OrderStatus; count: number }>;
};

export type OrderInsights = {
  topSalesOrganizations: Array<{ salesOrganization: string; orderCount: number; totalAmount: number; currency: string }>;
  largestOrder: OrderSummary | null;
  latestOrderDate: string;
  attentionCount: number;
};
```

### Task 1: Build the SAP order read model and analytics

**Files:**
- Modify: `src/order-history.ts:7-111`
- Test: `test/order-history.test.ts`

**Consumes:** Existing `ODataReader.get(path, params)` and `normalizeCustomer`.

**Produces:** `OrderHistoryService.list(customer, query): Promise<PaginatedOrderHistory>` and `OrderHistoryService.detail(customer, salesOrder): Promise<OrderDetail>`.

- [ ] **Step 1: Write failing tests for filters, sorting, pagination and insights**

```ts
test("filters only the logged-in customer's orders and paginates the mapped SAP rows", async () => {
  const service = new OrderHistoryService(fakeSapOrders(), () => new Date("2026-07-21T00:00:00.000Z"));
  const result = await service.list("100001", { page: 2, pageSize: 10, salesOrganization: "1310", sort: "total:desc" });
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
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `npm test -- --test-name-pattern='filters only|rejects an order detail'`

Expected: FAIL because `list` has no query argument and `detail` does not exist.

- [ ] **Step 3: Add the model types, normalizers and status mapping**

```ts
const STATUS: Record<string, OrderStatus> = {
  A: { code: "A", label: "未处理", tone: "neutral" },
  B: { code: "B", label: "处理中", tone: "warning" },
  C: { code: "C", label: "已完成", tone: "success" },
};

function status(value: unknown): OrderStatus {
  const code = text(value);
  return STATUS[code] ?? { code, label: code ? `SAP 状态 ${code}` : "SAP 未维护", tone: code ? "neutral" : "neutral" };
}

function optionalText(value: unknown): string | null {
  const normalized = text(value);
  return normalized || null;
}

function optionalAmount(value: unknown): number | null {
  if (value === undefined || value === null || text(value) === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function optionalCreatedAt(value: unknown): string | null {
  const normalized = createdAt(value);
  return normalized || null;
}

function normalizeQuery(input: Partial<OrderQuery>): OrderQuery {
  const page = Number(input.page ?? 1);
  const pageSize = Number(input.pageSize ?? 20);
  if (!Number.isInteger(page) || page < 1) throw new Error("页码必须为正整数。");
  if (![10, 20, 50].includes(pageSize)) throw new Error("每页条数仅支持 10、20 或 50。");
  return { page, pageSize: pageSize as 10 | 20 | 50, from: input.from, to: input.to, salesOrganization: input.salesOrganization, overallStatus: input.overallStatus, deliveryStatus: input.deliveryStatus, query: input.query?.trim(), sort: input.sort ?? "createdAt:desc" };
}

function toOrderSummary(row: Record<string, unknown>): OrderSummary {
  return {
    salesOrder: text(row.SalesOrder), salesOrderType: text(row.SalesOrderType), createdAt: createdAt(row.CreationDate),
    salesOrganization: text(row.SalesOrganization), distributionChannel: text(row.DistributionChannel), division: text(row.OrganizationDivision),
    purchaseOrderByCustomer: optionalText(row.PurchaseOrderByCustomer), total: amount(row.TotalNetAmount), currency: text(row.TransactionCurrency),
    overallStatus: status(row.OverallSDProcessStatus), deliveryStatus: status(row.OverallDeliveryStatus), billingStatus: status(row.OverallOrdReltdBillgStatus),
  };
}

function matchesTwelveMonthsAndQuery(order: OrderSummary, query: OrderQuery, now: Date): boolean {
  const start = twelveMonths(now)[0];
  const minimumDate = query.from || `${start}-01`;
  const haystack = `${order.salesOrder} ${order.purchaseOrderByCustomer ?? ""}`.toLowerCase();
  return order.createdAt >= minimumDate && (!query.to || order.createdAt <= query.to)
    && (!query.salesOrganization || order.salesOrganization === query.salesOrganization)
    && (!query.overallStatus || order.overallStatus.code === query.overallStatus)
    && (!query.deliveryStatus || order.deliveryStatus.code === query.deliveryStatus)
    && (!query.query || haystack.includes(query.query.toLowerCase()));
}

function sortOrders(orders: OrderSummary[], sort: OrderQuery["sort"]): OrderSummary[] {
  const multiplier = sort.endsWith(":asc") ? 1 : -1;
  const value = (order: OrderSummary) => sort.startsWith("total") ? order.total : order.createdAt;
  return [...orders].sort((left, right) => value(left) < value(right) ? -multiplier : value(left) > value(right) ? multiplier : 0);
}

function toDetailHeader(row: Record<string, unknown>): OrderDetail["header"] {
  return { ...toOrderSummary(row), requestedDeliveryDate: optionalCreatedAt(row.RequestedDeliveryDate), customerPurchaseOrderDate: optionalCreatedAt(row.CustomerPurchaseOrderDate), createdByUser: optionalText(row.CreatedByUser) };
}

function toOrderLine(row: Record<string, unknown>): OrderDetail["items"][number] {
  return { item: text(row.SalesOrderItem), material: optionalText(row.Material), description: optionalText(row.SalesOrderItemText), quantity: amount(row.RequestedQuantity), unit: optionalText(row.RequestedQuantityUnit) ?? optionalText(row.OrderQuantityUnit), netPrice: optionalAmount(row.NetPriceAmount), netAmount: amount(row.NetAmount), currency: optionalText(row.TransactionCurrency), deliveryStatus: status(row.OverallDeliveryStatus) };
}
```

- [ ] **Step 4: Implement `list` and analytics with one SAP OData read**

```ts
async list(customerInput: string, input: Partial<OrderQuery> = {}): Promise<PaginatedOrderHistory> {
  const customer = normalizeCustomer(customerInput);
  const query = normalizeQuery(input);
  const response = await this.client.get<unknown>("/A_SalesOrder", {
    "$filter": `SoldToParty eq '${customer}'`, "$orderby": "CreationDate desc", "$top": 200,
  });
  const all = rows(response.data)
    .filter((row) => normalizeCustomer(text(row.SoldToParty)) === customer)
    .map(toOrderSummary)
    .filter((order) => matchesTwelveMonthsAndQuery(order, query, this.now()));
  const sorted = sortOrders(all, query.sort);
  const start = (query.page - 1) * query.pageSize;
  return { items: sorted.slice(start, start + query.pageSize), page: query.page, pageSize: query.pageSize, total: sorted.length, pageCount: Math.ceil(sorted.length / query.pageSize), dashboard: dashboard(sorted), insights: insights(sorted) };
}
```

- [ ] **Step 5: Implement `detail` with ownership verification and line-item mapping**

```ts
async detail(customerInput: string, salesOrderInput: string): Promise<OrderDetail> {
  const customer = normalizeCustomer(customerInput);
  const salesOrder = normalizeSalesOrder(salesOrderInput);
  const header = await this.client.get<Record<string, unknown>>(`/A_SalesOrder('${salesOrder}')`);
  if (normalizeCustomer(text(header.data.SoldToParty)) !== customer) throw new Error("订单不存在。");
  const lines = await this.client.get<unknown>(`/A_SalesOrder('${salesOrder}')/to_Item`);
  return { header: toDetailHeader(header.data), items: rows(lines.data).map(toOrderLine) };
}
```

- [ ] **Step 6: Run focused and full backend tests**

Run: `npm test -- --test-name-pattern='orders|order detail' && npm test`

Expected: PASS; no order belongs to a customer other than the requested session customer.

- [ ] **Step 7: Commit the read model**

```bash
git add src/order-history.ts test/order-history.test.ts
git commit -m '[AI-ADD]订单工作台查询模型'
```

### Task 2: Expose session-bound workbench routes

**Files:**
- Modify: `src/portal-app.ts:218-222`
- Modify: `test/portal-app.test.ts:17-53,135-142`

**Consumes:** `orderHistory.list(customer, query)` and `orderHistory.detail(customer, salesOrder)`.

**Produces:** `GET /api/orders/history` and `GET /api/orders/:salesOrder`.

- [ ] **Step 1: Write failing route tests**

```ts
test("uses only the cookie session customer for filtered order history", async () => {
  const agent = await registeredAgent(makeStorefrontApp);
  const response = await agent.get("/api/orders/history?page=1&pageSize=10&salesOrganization=1310&customer=0000000002").expect(200);
  assert.equal(response.body.items[0].salesOrder, "0000001372");
  assert.equal(response.body.total, 1);
});

test("returns 404 when the selected sales order is not owned by the logged-in customer", async () => {
  const agent = await registeredAgent(makeStorefrontApp);
  await agent.get("/api/orders/0000009999").expect(404);
});
```

- [ ] **Step 2: Run the route tests and verify failure**

Run: `npm test -- --test-name-pattern='cookie session customer|selected sales order'`

Expected: FAIL because the pagination response shape and detail route do not exist.

- [ ] **Step 3: Parse allow-listed query parameters and invoke the service from the session**

```ts
app.get("/api/orders/history", async (req, res) => {
  try {
    const result = await orderHistoryDependencies().list(session(req).customer, {
      page: numberQuery(req.query.page), pageSize: numberQuery(req.query.pageSize),
      from: stringQuery(req.query.from), to: stringQuery(req.query.to), salesOrganization: stringQuery(req.query.salesOrganization),
      overallStatus: stringQuery(req.query.overallStatus), deliveryStatus: stringQuery(req.query.deliveryStatus),
      query: stringQuery(req.query.query), sort: stringQuery(req.query.sort) as OrderQuery["sort"] | undefined,
    });
    res.json(result);
  } catch (error) { res.status(400).json({ error: message(error) }); }
});

function stringQuery(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value.trim() : undefined; }
function numberQuery(value: unknown): number | undefined { const parsed = Number(stringQuery(value)); return Number.isFinite(parsed) ? parsed : undefined; }
function message(error: unknown): string { return error instanceof Error ? error.message : "请求失败。"; }
```

- [ ] **Step 4: Add the ownership-protected detail route**

```ts
app.get("/api/orders/:salesOrder", async (req, res) => {
  try {
    res.json(await orderHistoryDependencies().detail(session(req).customer, req.params.salesOrder));
  } catch (error) {
    const text = message(error);
    res.status(text === "订单不存在。" ? 404 : 400).json({ error: text });
  }
});
```

- [ ] **Step 5: Run route tests and the full suite**

Run: `npm test -- --test-name-pattern='order history|sales order' && npm test`

Expected: PASS; unauthenticated requests remain 401 and foreign details remain 404.

- [ ] **Step 6: Commit the portal routes**

```bash
git add src/portal-app.ts test/portal-app.test.ts
git commit -m '[AI-ADD]订单工作台接口'
```

### Task 3: Build the order workbench markup and visual system

**Files:**
- Modify: `public/index.html:99-103`
- Modify: `public/order-center.css`
- Modify: `test/portal-app.test.ts:173-182`

**Consumes:** `PaginatedOrderHistory` and `OrderDetail` browser payloads.

**Produces:** Semantically named DOM targets for filters, metrics, trend, insights, list pagination and order detail dialog.

- [ ] **Step 1: Write failing static markup tests**

```ts
test("serves the rich SAP order workbench controls", () => {
  const html = fs.readFileSync(path.resolve(import.meta.dirname, "../public/index.html"), "utf8");
  for (const id of ["order-filter-form", "order-list", "order-pagination", "order-insights", "order-detail-dialog", "order-detail-lines"]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
});
```

- [ ] **Step 2: Run the markup test and verify failure**

Run: `npm test -- --test-name-pattern='rich SAP order workbench controls'`

Expected: FAIL because the six DOM targets are absent.

- [ ] **Step 3: Replace the simple order-center body with semantic sections**

```html
<form id="order-filter-form" class="order-filters">
  <input id="order-query" type="search" placeholder="订单号或客户采购订单号">
  <input id="order-from" type="date"><input id="order-to" type="date">
  <select id="order-sales-organization"><option value="">全部销售组织</option></select>
  <select id="order-overall-status"><option value="">全部整体状态</option></select>
  <select id="order-delivery-status"><option value="">全部交货状态</option></select>
  <select id="order-sort"><option value="createdAt:desc">最新创建</option><option value="total:desc">金额从高到低</option></select>
  <button>查询</button>
</form>
<section id="order-dashboard-summary" class="dashboard-summary" aria-live="polite"></section>
<section id="order-analytics" class="order-analytics"></section>
<section id="order-insights" class="order-insights"></section>
<section id="order-list" class="order-list" aria-live="polite"></section>
<nav id="order-pagination" class="pagination" aria-label="订单分页"></nav>
<dialog id="order-detail-dialog"><button id="close-order-detail" type="button">关闭</button><div id="order-detail-header"></div><div id="order-detail-lines"></div></dialog>
```

- [ ] **Step 4: Add responsive presentation rules**

```css
.order-analytics{display:grid;grid-template-columns:2fr 1fr;gap:16px}.order-insights{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}.status-badge{display:inline-flex;padding:4px 8px;border-radius:999px;font-size:.78rem}.status-success{background:#e7f7ee;color:#16794b}.status-warning{background:#fff4db;color:#9a6700}.status-neutral{background:#edf2f7;color:#526273}.order-detail-dialog{width:min(760px,94vw);border:0;border-radius:18px;padding:24px}@media(max-width:860px){.order-analytics,.order-insights{grid-template-columns:1fr}.order-filters{grid-template-columns:1fr 1fr}}
```

- [ ] **Step 5: Run markup tests and build**

Run: `npm test -- --test-name-pattern='order workbench|SAP-only order center' && npm run build`

Expected: PASS; the existing SAP-only constraint remains intact.

- [ ] **Step 6: Commit the layout**

```bash
git add public/index.html public/order-center.css test/portal-app.test.ts
git commit -m '[AI-IMP]订单工作台布局'
```

### Task 4: Render filters, analytics, paging and details in the browser

**Files:**
- Modify: `public/app.js:228-265`
- Test: `test/portal-app.test.ts`

**Consumes:** `GET /api/orders/history` and `GET /api/orders/:salesOrder`.

**Produces:** `loadOrderCenter`, `renderOrderWorkbench`, `openOrderDetail` and resilient loading/error states.

- [ ] **Step 1: Write failing browser-facing script assertions**

```ts
test("serves filter, pagination and detail renderers for the order workbench", () => {
  const script = fs.readFileSync(path.resolve(import.meta.dirname, "../public/app.js"), "utf8");
  for (const name of ["function renderOrderWorkbench", "function openOrderDetail", "api(`/api/orders/${salesOrder}`)", "order-filter-form"]) {
    assert.match(script, new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});
```

- [ ] **Step 2: Run the script assertion and verify failure**

Run: `npm test -- --test-name-pattern='filter, pagination and detail renderers'`

Expected: FAIL because the workbench rendering functions do not exist.

- [ ] **Step 3: Replace the old one-shot renderer with stateful query loading**

```js
const orderState = { page: 1, pageSize: 20, from: "", to: "", salesOrganization: "", overallStatus: "", deliveryStatus: "", query: "", sort: "createdAt:desc" };

async function loadOrderCenter(next = {}) {
  Object.assign(orderState, next);
  const params = new URLSearchParams(Object.entries(orderState).filter(([, value]) => value !== "").map(([key, value]) => [key, String(value)]));
  portalNote("正在加载订单中心…");
  try { renderOrderWorkbench(await api(`/api/orders/history?${params}`)); portalNote(""); }
  catch (error) { $("order-list").replaceChildren(element("p", "empty-state", error.message)); portalNote(error.message); }
}
```

- [ ] **Step 4: Render status badges, metric cards, trend, insights and paginated rows**

```js
function statusBadge(status) {
  return element("span", `status-badge status-${status.tone || "neutral"}`, status.label || "SAP 未维护");
}

function renderOrderWorkbench(data) {
  renderOrderDashboard(data.dashboard, data.items.length);
  renderOrderAnalytics(data.dashboard);
  renderOrderInsights(data.insights);
  renderOrderRows($("order-list"), data.items, "未找到符合当前条件的 SAP 销售订单。", true);
  renderOrderPagination(data);
}
```

- [ ] **Step 5: Implement on-demand dialog loading without changing customer scope**

```js
async function openOrderDetail(salesOrder) {
  const dialog = $("order-detail-dialog");
  $("order-detail-header").textContent = "正在加载订单详情…";
  $("order-detail-lines").replaceChildren();
  dialog.showModal();
  try { renderOrderDetail(await api(`/api/orders/${encodeURIComponent(salesOrder)}`)); }
  catch (error) { $("order-detail-header").textContent = error.message; }
}

$("order-filter-form").addEventListener("submit", (event) => { event.preventDefault(); loadOrderCenter({ page: 1, query: $("order-query").value.trim(), from: $("order-from").value, to: $("order-to").value, salesOrganization: $("order-sales-organization").value, overallStatus: $("order-overall-status").value, deliveryStatus: $("order-delivery-status").value, sort: $("order-sort").value }); });
$("close-order-detail").addEventListener("click", () => $("order-detail-dialog").close());
```

- [ ] **Step 6: Run static tests, full tests and build**

Run: `npm test && npm run build`

Expected: PASS.

- [ ] **Step 7: Commit the interaction layer**

```bash
git add public/app.js test/portal-app.test.ts
git commit -m '[AI-ADD]订单工作台交互'
```

### Task 5: Add end-to-end browser coverage and SAP read-only verification

**Files:**
- Create: `test/order-workbench-ui.test.py`
- Modify: `README.md:48-83`

**Consumes:** Static portal page and intercepted `GET /api/orders/history`, `GET /api/orders/:salesOrder` responses.

**Produces:** A reproducible Playwright check of filtering, paging, details and independent failure handling.

- [ ] **Step 1: Write the failing Playwright test with mocked API contracts**

```python
page.get_by_role("link", name="订单中心").click()
page.locator("#order-list tbody tr").first.click()
page.locator("#order-detail-dialog").wait_for(state="visible")
assert page.locator("#order-detail-lines tbody tr").count() == 2
page.locator("#order-filter-form").get_by_role("button", name="查询").click()
assert "/api/orders/history?page=1" in observed_history_url[0]
```

- [ ] **Step 2: Run the browser test and verify failure**

Run: `python3 test/order-workbench-ui.test.py`

Expected: FAIL because filter controls, detail dialog and row click interaction do not exist.

- [ ] **Step 3: Implement API routing fixtures and assertions for normal, empty and detail-failure states**

```python
def route_api(route):
    path = urlparse(route.request.url).path
    if path == "/api/orders/history": route.fulfill(status=200, content_type="application/json", body=json.dumps(history_payload))
    elif path == "/api/orders/0000001372": route.fulfill(status=200, content_type="application/json", body=json.dumps(detail_payload))
    elif path == "/api/orders/0000001373": route.fulfill(status=500, content_type="application/json", body=json.dumps({"error": "订单详情暂不可读取。"}))
    else: route.continue_()
```

- [ ] **Step 4: Run browser test using the supplied server lifecycle helper**

Run: `python3 /home/cheng.qian/.ccfb-accounts/codex/QC.Account1/skills/webapp-testing/scripts/with_server.py --server 'python3 -m http.server 4180 --directory public' --port 4180 --timeout 30 -- python3 test/order-workbench-ui.test.py`

Expected: PASS; screenshot contains dashboard, list and dialog without showing real SAP data.

- [ ] **Step 5: Document test-environment TLS behavior without weakening production guidance**

```md
测试 SAP 若使用自签名证书，仅可在 `NODE_ENV=development` 下显式设置 `SAP_TLS_REJECT_UNAUTHORIZED=false` 用于临时联调。生产环境必须配置 `SAP_CA_CERT_PATH` 并保持 TLS 校验开启。
```

- [ ] **Step 6: Run all verification commands**

Run: `npm test && npm run build && git diff --check`

Expected: PASS; no tracked credentials, portal database or generated test screenshots are staged.

- [ ] **Step 7: Commit and push the verification documentation**

```bash
git add test/order-workbench-ui.test.py README.md
git commit -m '[AI-ADD]订单工作台端到端验证'
git push origin session/d1f90d2aa648
```

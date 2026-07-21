# 客户 360 与订单工作台 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为登录客户提供美观的商城、SAP 风格订单录入、客户 360 和最近 12 个月订单分析工作台。

**Architecture:** 保持 Express + 原生浏览器 JavaScript。服务端新增按会话客户隔离的客户 360、SAP 历史订单与门户订单聚合服务；前端采用一个 `activeView` 状态切换四个视图。客户资料与订单统计从 SAP 只读获取，门户订单状态保存在 SQLite，SAP 写入仍由既有开关和确认保护。

**Tech Stack:** TypeScript、Express 5、better-sqlite3、Axios、Node test runner、Supertest、原生 JavaScript/CSS、SAP OData V2。

## Global Constraints

- 仅在 `/tmp/wt-d1f90d2aa648` 的 `session/d1f90d2aa648` 分支修改；每个阶段必须 `npm test && npm run build`、提交并推送。
- 所有 SAP 读取只使用当前会话客户；请求中的客户号一律忽略或拒绝。
- 银行信息完整展示，但不得写入 localStorage、分析事件或日志。
- 历史订单默认最近 12 个月；门户已同步订单与 SAP 订单按 SAP 单号去重。
- 订单创建继续要求 `confirm=true`、`SAP_WRITE_ENABLED=true`、重新定价与销售范围校验。
- 任何 SAP POST、PATCH、DELETE 不得用于字段核验或自动化测试。

---

### Task 1: SAP 只读字段核验与客户 360 聚合服务

**Files:**
- Create: `src/customer-360.ts`, `test/customer-360.test.ts`
- Modify: `src/customer-contact.ts`, `src/web-server.ts`, `src/portal-app.ts`, `test/portal-app.test.ts`

**Interfaces:**
- Produces `Customer360Profile`：`profile`、`addresses`、`phones`、`emails`、`banks`、`salesAreas`。
- Produces `getCustomer360(client, config, customer): Promise<Customer360Profile>`。
- Produces `GET /api/customer-360`，不接受客户号参数。

- [ ] **Step 1: 核验真实 SAP 元数据与实体（只读）**

运行以下命令，仅记录实体名和字段名，不输出银行账号、地址或邮箱：

```bash
curl -k -sS -H 'Accept: application/json' -u "$SAP_USER:$SAP_PASSWORD" \
  "$SAP_BUSINESS_PARTNER_SERVICE_URL/\$metadata?sap-client=$SAP_CLIENT" > /tmp/bp-metadata.xml
rg -n 'A_BusinessPartnerAddress|A_BusinessPartnerBank|to_PhoneNumber|to_EmailAddress|BankAccount|StreetName|PhoneNumber' /tmp/bp-metadata.xml
```

确认实际银行实体/字段后，将字段名写入 `Customer360Profile` 映射；若实体不可用，`banks` 返回空数组并记录安全的“SAP 未维护”状态。

- [ ] **Step 2: 写失败测试**

```ts
test("aggregates only the current customer's 360 profile", async () => {
  const profile = await getCustomer360(client as never, config, "100001");
  assert.equal(profile.customer, "0000100001");
  assert.equal(profile.addresses[0]?.city, "上海");
  assert.equal(profile.banks[0]?.account, "6222...");
  assert.match(calls.join("\n"), /BusinessPartner eq '0000000046'/);
  assert.doesNotMatch(calls.join("\n"), /0000100002/);
});

test("does not return a customer 360 profile without a session", async () => {
  await request(app).get("/api/customer-360").expect(401);
});
```

- [ ] **Step 3: 验证失败测试**

Run: `npm test -- --test-name-pattern='current.customer.*360|without a session'`

Expected: FAIL because `getCustomer360` and `/api/customer-360` do not exist.

- [ ] **Step 4: 实现最小聚合和会话路由**

```ts
export interface Customer360Profile {
  customer: string; name: string; businessPartner: string; accountGroup: string;
  addresses: Array<{ street: string; city: string; postalCode: string; country: string }>;
  phones: string[]; emails: string[];
  banks: Array<{ bankName: string; bankCountry: string; account: string; iban: string }>;
  salesAreas: SalesArea[];
}

app.get("/api/customer-360", async (req, res) => {
  try { res.json(await customer360Dependencies().get(session(req).customer)); }
  catch (error) { respondRouteError(res, error); }
});
```

读取客户主数据后先解析其业务伙伴，再以业务伙伴过滤地址、电话、邮箱和银行实体；每个缺失集合返回 `[]`，不抛出含敏感明细的错误。

- [ ] **Step 5: 验证、提交与推送**

Run: `npm test && npm run build`

```bash
git add src/customer-360.ts src/customer-contact.ts src/web-server.ts src/portal-app.ts test/customer-360.test.ts test/portal-app.test.ts
git commit -m '[AI-ADD]客户360资料服务'
git push origin session/d1f90d2aa648
```

### Task 2: 门户提交记录与 SAP 历史订单/仪表盘服务

**Files:**
- Create: `src/order-submissions.ts`, `src/order-history.ts`, `test/order-submissions.test.ts`, `test/order-history.test.ts`
- Modify: `src/auth-store.ts`, `src/portal-app.ts`, `src/web-server.ts`, `test/portal-app.test.ts`

**Interfaces:**
- Produces `PortalOrderRecord` 和 `OrderDashboard`。
- Produces `OrderSubmissionStore.save/listByCustomer`，唯一键为客户、销售范围、项目指纹。
- Produces `getOrderHistory(client, config, customer, from, to)` 与 `getOrderDashboard(customer, from, to)`。
- Produces `GET /api/orders/history`、`GET /api/orders/dashboard`、`GET /api/portal-orders`。

- [ ] **Step 1: 写失败测试**

```ts
test("does not count a synced portal order twice in the dashboard", async () => {
  const dashboard = buildOrderDashboard([
    sapOrder("0000001372", 100), portalOrder("0000001372", 100, "success"),
  ]);
  assert.equal(dashboard.orderCount, 1);
  assert.equal(dashboard.totalAmount, 100);
});

test("limits history to the requested twelve month range and current customer", async () => {
  const orders = await getOrderHistory(client as never, config, "100001", "2025-07-20", "2026-07-20");
  assert.equal(orders.every((order) => order.soldToParty === "0000100001"), true);
  assert.match(calls[0].filter, /SoldToParty eq '0000100001'/);
});
```

- [ ] **Step 2: 验证失败测试**

Run: `npm test -- --test-name-pattern='does not count a synced|limits history'`

Expected: FAIL because order submission storage and history service do not exist.

- [ ] **Step 3: 实现持久化、历史订单与统计**

```sql
CREATE TABLE IF NOT EXISTS portal_order_submissions (
  id TEXT PRIMARY KEY, customer TEXT NOT NULL, sales_area_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL, status TEXT NOT NULL, sales_order TEXT,
  amount REAL, currency TEXT, error_summary TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE(customer, sales_area_key, fingerprint)
);
```

```ts
export interface OrderDashboard {
  orderCount: number; totalAmount: number; currency: string;
  monthly: Array<{ month: string; amount: number; count: number }>;
  statuses: Array<{ status: string; count: number }>;
  recent: SalesOrderSummary[]; portal: PortalOrderRecord[];
}
```

从 `A_SalesOrder` 读取 `SoldToParty`、日期、金额、币种和整体状态，以服务端计算的最近 12 个月下限覆盖客户端日期；分页最多读取 500 条，超出时返回明确截断标志。

- [ ] **Step 4: 接入订单路由**

```ts
app.get("/api/orders/dashboard", async (req, res) => {
  try { res.json(await dashboardDependencies().get(session(req).customer, historyRange(req))); }
  catch (error) { respondRouteError(res, error); }
});
```

订单创建成功/失败时保存脱敏错误摘要和 SAP 订单号；不得持久化 SAP 凭据或银行信息。

- [ ] **Step 5: 验证、提交与推送**

Run: `npm test && npm run build`

```bash
git add src/order-submissions.ts src/order-history.ts src/auth-store.ts src/portal-app.ts src/web-server.ts test/order-submissions.test.ts test/order-history.test.ts test/portal-app.test.ts
git commit -m '[AI-ADD]客户订单中心服务'
git push origin session/d1f90d2aa648
```

### Task 3: SAP 风格订单录入视图和客户 360 视图

**Files:**
- Modify: `public/index.html`, `public/app.js`, `public/styles.css`, `test/portal-app.test.ts`

**Interfaces:**
- Produces `showView("catalog" | "entry" | "customer" | "orders")`。
- Produces `loadCustomer360()`、`loadOrderEntry()` 和 `renderOrderEntry()`。

- [ ] **Step 1: 写失败静态合同测试**

```ts
test("serves independent order-entry and customer-360 views", () => {
  const html = fs.readFileSync(path.resolve(import.meta.dirname, "../public/index.html"), "utf8");
  assert.match(html, /id="view-order-entry"/);
  assert.match(html, /id="view-customer-360"/);
  assert.match(html, /id="customer-business-illustration"/);
  assert.match(html, /id="order-header-form"/);
  assert.match(html, /id="order-line-items"/);
});
```

- [ ] **Step 2: 验证失败测试**

Run: `npm test -- --test-name-pattern='independent order-entry'`

Expected: FAIL because the views and identifiers do not exist.

- [ ] **Step 3: 实现商城、订单录入与客户 360 页面**

```js
function showView(name) {
  ["catalog", "order-entry", "customer-360", "orders"].forEach((id) => {
    $(`view-${id}`).hidden = id !== name;
  });
}

async function loadCustomer360() {
  renderCustomer360(await api("/api/customer-360"));
  showView("customer-360");
}
```

“去结算”只调用 `showView("order-entry")`；将既有购物车行转换为订单行表。客户摘要使用内联 SVG 商务插画，客户 360 使用 `<dl>` 显示完整银行字段，避免把敏感值写入 DOM 属性或浏览器存储。

- [ ] **Step 4: 验证、提交与推送**

Run: `npm test && npm run build`

```bash
git add public/index.html public/app.js public/styles.css test/portal-app.test.ts
git commit -m '[AI-IMP]客户订单录入界面'
git push origin session/d1f90d2aa648
```

### Task 4: 订单中心 Dashboard、浏览器冒烟与运行说明

**Files:**
- Modify: `public/index.html`, `public/app.js`, `public/styles.css`, `README.md`, `test/portal-app.test.ts`

**Interfaces:**
- Produces `loadOrderCenter()`、`renderDashboard(data)`、`renderOrderTables(data)`。

- [ ] **Step 1: 写失败静态合同测试**

```ts
test("serves an order dashboard with SAP and portal order sections", () => {
  const html = fs.readFileSync(path.resolve(import.meta.dirname, "../public/index.html"), "utf8");
  assert.match(html, /id="order-kpis"/);
  assert.match(html, /id="order-monthly-trend"/);
  assert.match(html, /id="sap-order-table"/);
  assert.match(html, /id="portal-order-table"/);
});
```

- [ ] **Step 2: 验证失败测试**

Run: `npm test -- --test-name-pattern='order dashboard'`

Expected: FAIL because dashboard sections do not exist.

- [ ] **Step 3: 实现 Dashboard 与空状态**

```js
async function loadOrderCenter() {
  const data = await api("/api/orders/dashboard");
  renderDashboard(data);
  showView("orders");
}
```

KPI 使用订单数、总金额、成功同步数和待处理数；月度趋势使用 CSS 柱图，不增加图表依赖；订单表显示状态、日期、金额和 SAP 单号。加载、无订单和接口失败都写入对应视图，不允许页面永久显示加载状态。

- [ ] **Step 4: 浏览器冒烟、文档和提交**

Run: `npm test && npm run build`

使用本地 fake-SAP 启动门户并验证：登录后目录可见、购物车进入订单录入、客户中心展示资料、订单中心展示 KPI 与两张订单表。README 说明最近 12 个月统计、银行信息权限边界和不在开发测试中创建 SAP 订单。

```bash
git add public/index.html public/app.js public/styles.css README.md test/portal-app.test.ts
git commit -m '[AI-IMP]订单中心分析看板'
git push origin session/d1f90d2aa648
```

## Self-Review

- 客户插画、摘要、客户 360 和完整银行展示由 Task 1 与 Task 3 覆盖。
- 独立 SAP 头行/行项目订单录入由 Task 3 覆盖。
- 最近 12 个月、SAP/门户双订单源、去重和分析由 Task 2 与 Task 4 覆盖。
- 每个读取路由从会话而非请求体取得客户号；每个写入仍由既有开关和确认约束。

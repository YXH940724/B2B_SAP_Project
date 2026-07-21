# SAP 客户订单查询实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 订单中心仅从 SAP 读取当前登录客户的销售订单，并基于 SAP 订单生成近 12 个月汇总。

**Architecture:** `OrderHistoryService` 保持 SAP OData 读取与数据规范化职责，但移除进程内门户订单集合。门户路由仅以会话中的十位客户号查询该服务；前端把双来源表格收敛为单一 SAP 销售订单表格和仪表盘。

**Tech Stack:** TypeScript、Express、Axios OData Client、Node test、静态 HTML/CSS/JavaScript。

## Global Constraints

- 订单查询必须为 GET，浏览器请求不能携带客户号。
- 服务端只使用当前会话客户号，规范化为十位 SAP 客户号后构造 `$filter`。
- 不新增数据库表，不写入本地或外部订单数据。
- 保留现有订单创建写入保护，不修改 SAP 写入开关逻辑。
- 每个行为变更先执行失败测试；每个阶段运行 `npm test` 和 `npm run build`。

---

### Task 1: 收敛 SAP 订单历史服务

**Files:**
- Modify: `src/order-history.ts`
- Modify: `test/order-history.test.ts`

**Interfaces:**
- Consumes: `ODataReader.get(path, params)` 与 `normalizeCustomer(customer)`。
- Produces: `OrderHistoryService.list(customer): Promise<CustomerOrderHistory>`，其中 `portalOrders` 不再存在，`dashboard` 只统计 `sapOrders`。

- [ ] **Step 1: 写入失败测试**

```ts
test("reads only SAP orders for the normalized customer and does not retain portal submissions", async () => {
  const calls: Array<Record<string, string | number | undefined>> = [];
  const service = new OrderHistoryService({
    get: async (_path, params) => {
      calls.push(params ?? {});
      return { data: { results: [{ SalesOrder: "0000001372", CreationDate: "2026-07-01", SoldToParty: "0000100001", TotalNetAmount: "100", TransactionCurrency: "CNY" }] } };
    },
  }, () => new Date("2026-07-21T00:00:00.000Z"));
  const history = await service.list("100001");
  assert.match(String(calls[0].$filter), /0000100001/);
  assert.equal(history.sapOrders.length, 1);
  assert.equal("portalOrders" in history, false);
  assert.equal(history.dashboard.orderCount, 1);
});
```

- [ ] **Step 2: 运行失败测试**

Run: `npm test -- --test-name-pattern='reads only SAP orders'`

Expected: FAIL，因为历史响应仍包含 `portalOrders` 或测试中的接口尚不存在。

- [ ] **Step 3: 最小实现**

删除 `PortalOrderSubmission` 类型、`submissions` 数组和 `recordPortalSubmission()`；将 `CustomerOrderHistory` 定义为：

```ts
export interface CustomerOrderHistory {
  sapOrders: OrderHistoryItem[];
  dashboard: OrderDashboard;
}
```

在 SAP 行映射后增加客户匹配，避免异常 SAP 响应泄漏其他客户：

```ts
.filter((item) => item.salesOrder && item.createdAt >= `${start}-01` && normalizeCustomer(text(row.SoldToParty)) === customer)
```

其中 `row` 的客户匹配应在映射前保留，或把 `soldToParty` 作为局部字段参与过滤。返回 `{ sapOrders, dashboard: this.dashboard(sapOrders) }`。

- [ ] **Step 4: 运行通过测试**

Run: `npm test -- --test-name-pattern='reads only SAP orders'`

Expected: PASS。

- [ ] **Step 5: 完整验证并提交**

Run: `npm test && npm run build && git diff --check`

Expected: 测试与编译均成功。

```bash
git add src/order-history.ts test/order-history.test.ts
git commit -m '[AI-REF]SAP订单历史服务'
```

### Task 2: 移除门户订单写入并收敛订单中心界面

**Files:**
- Modify: `src/portal-app.ts`
- Modify: `src/web-server.ts`
- Modify: `test/portal-app.test.ts`
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `public/order-center.css`

**Interfaces:**
- Consumes: `OrderHistoryService.list(customer)` 的 `{ sapOrders, dashboard }`。
- Produces: `GET /api/orders/history` 返回仅含 SAP 订单与仪表盘的 JSON；订单中心仅渲染 `#sap-orders-list`。

- [ ] **Step 1: 写入失败测试**

```ts
test("returns only SAP orders from the session-bound order history", async () => {
  const agent = await registeredAgent(makeStorefrontApp);
  const response = await agent.get("/api/orders/history").expect(200);
  assert.equal(response.body.sapOrders[0].salesOrder, "0000001372");
  assert.equal(response.body.portalOrders, undefined);
});

test("serves an SAP-only order center", () => {
  const html = fs.readFileSync(path.resolve(import.meta.dirname, "../public/index.html"), "utf8");
  assert.match(html, /id="sap-orders-list"/);
  assert.doesNotMatch(html, /id="portal-orders-list"/);
});
```

- [ ] **Step 2: 运行失败测试**

Run: `npm test -- --test-name-pattern='only SAP orders|SAP-only order center'`

Expected: FAIL，因为依赖接口与页面仍包含门户同步订单。

- [ ] **Step 3: 最小实现**

把 `PortalDependencies.orderHistory` 改为只包含 `list(customer)`，并删除 SAP 创建成功后的 `recordPortalSubmission` 调用。`web-server.ts` 继续构造 `new OrderHistoryService(client)`，但不再保存对象状态。

将订单中心 HTML 改为单一来源：

```html
<section class="order-source">
  <h3>SAP 销售订单</h3>
  <div id="sap-orders-list"></div>
</section>
```

将 `renderOrderDashboard(history)` 中的指标改为订单总数、订单金额与 SAP 订单数；删除 `portalOrders` 计数和 `renderOrderRows($("portal-orders-list"), ...)`。更新 CSS 使单个订单来源卡片横跨订单中心的完整宽度。

- [ ] **Step 4: 运行通过测试**

Run: `npm test -- --test-name-pattern='only SAP orders|SAP-only order center'`

Expected: PASS。

- [ ] **Step 5: 浏览器验证、完整验证与提交**

使用静态服务与 Playwright 拦截 `/api/login`、`/api/me`、`/api/sales-areas`、`/api/catalog`、`/api/orders/history`；模拟历史接口仅返回一个 SAP 订单，验证订单中心可见且页面不存在门户同步订单区域。

Run: `npm test && npm run build && git diff --check`

Expected: 测试、编译与差异检查成功。

```bash
git add src/portal-app.ts src/web-server.ts test/portal-app.test.ts public/index.html public/app.js public/order-center.css
git commit -m '[AI-REF]SAP唯一订单中心'
git push origin session/d1f90d2aa648
```

## 自检

- 规格中的唯一 SAP 数据源、会话客户隔离、近 12 个月、单一列表、无本地写入分别由任务 1 和任务 2 覆盖。
- 计划不包含未定义的外部数据库、日期服务或浏览器依赖。
- `OrderHistoryService.list`、`sapOrders` 和 `dashboard` 在所有任务中命名一致。

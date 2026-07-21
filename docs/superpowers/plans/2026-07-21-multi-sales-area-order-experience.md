# 多销售范围订单体验 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让当前客户可按完整销售范围浏览、加购、拆分结算并以结构化页面查看 SAP 订单。

**Architecture:** 以 `SalesArea` 的三段键作为商品、购物车行和订单组的共同边界。服务端在预览和提交时逐组验证范围、重新读取 SAP 价格并独立创建订单；订单历史查询增加完整范围联合过滤。前端把商品、结算和订单详情拆成明确的渲染器，所有金额保留原币种而不跨币种相加。

**Tech Stack:** TypeScript、Express、Node Test Runner、原生浏览器 JavaScript/CSS、Playwright。

## Global Constraints

- 只使用当前登录客户对应的 SAP 销售范围，服务端不得信任浏览器范围。
- 切换销售范围不清空购物车；每个购物车行必须保存 `salesOrganization`、`distributionChannel`、`division` 与 `key`。
- 同一 SAP 销售订单只能含一个完整销售范围；提交按范围分组。
- 真实写入仍受 `SAP_WRITE_ENABLED`、`assertWriteAllowed` 与既有确认流程控制。
- 缺失 SAP 字段统一显示“SAP 未维护”或“SAP 未维护描述”。
- 不将不同币种金额合并为单个总金额。

---

### Task 1: 完整销售范围订单查询契约

**Files:**
- Modify: `src/order-history.ts`
- Modify: `src/portal-app.ts`
- Modify: `test/order-history.test.ts`
- Modify: `test/portal-app.test.ts`

**Interfaces:**
- Consumes: `SalesArea` 的 `salesOrganization`、`distributionChannel`、`division`。
- Produces: `OrderQuery` 新增 `distributionChannel?: string` 与 `division?: string`；`GET /api/orders/history` 支持三段联合筛选。

- [ ] **Step 1: 写出完整销售范围过滤的失败测试**

```ts
test("filters current customer orders by the complete sales area", async () => {
  const result = await history.list("100001", {
    page: 1, pageSize: 20, salesOrganization: "1310", distributionChannel: "10", division: "00", sort: "createdAt:desc",
  });
  assert.deepEqual(result.items.map((item) => item.salesOrder), ["0000000001"]);
});
```

并在门户路由测试中请求：

```ts
await agent.get("/api/orders/history?salesOrganization=1310&distributionChannel=10&division=00").expect(200);
```

- [ ] **Step 2: 运行失败测试**

Run: `npm test -- test/order-history.test.ts test/portal-app.test.ts`  
Expected: FAIL，因为 `OrderQuery` 与过滤器尚不接受完整销售范围。

- [ ] **Step 3: 最小实现联合筛选与路由解析**

```ts
export type OrderQuery = {
  // existing fields
  salesOrganization?: string;
  distributionChannel?: string;
  division?: string;
};

function matchesQuery(order: OrderSummary, query: Partial<OrderQuery>): boolean {
  return (!query.salesOrganization || order.salesOrganization === query.salesOrganization)
    && (!query.distributionChannel || order.distributionChannel === query.distributionChannel)
    && (!query.division || order.division === query.division)
    && existingMatches(order, query);
}
```

`orderHistoryQuery` 解析三个字符串字段，并继续将 `session(req).customer` 作为唯一客户条件传给服务。

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test -- test/order-history.test.ts test/portal-app.test.ts`  
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/order-history.ts src/portal-app.ts test/order-history.test.ts test/portal-app.test.ts
git commit -m "[AI-IMP]订单完整销售范围筛选"
```

### Task 2: 按销售范围分组的预览与 SAP 提交

**Files:**
- Modify: `src/catalog.ts`
- Modify: `src/portal-app.ts`
- Modify: `test/catalog.test.ts`
- Modify: `test/portal-app.test.ts`

**Interfaces:**
- Consumes: `{ items: Array<{ product: string; quantity: number; salesOrganization: string; distributionChannel: string; division: string }>, requestedDeliveryDate?, purchaseOrderByCustomer?, note? }`。
- Produces: `POST /api/orders/preview` 和 `POST /api/orders/submit` 返回 `groups: Array<{ salesArea: SalesArea; items: ...; totalsByCurrency: ...; success?: boolean; salesOrder?: unknown; error?: string }>`。

- [ ] **Step 1: 写出拆组预览的失败测试**

```ts
test("previews cart lines as independent complete-sales-area groups", async () => {
  const response = await agent.post("/api/orders/preview").send({
    items: [
      { product: "1386", quantity: 2, salesOrganization: "1310", distributionChannel: "10", division: "00" },
      { product: "1387", quantity: 1, salesOrganization: "2000", distributionChannel: "20", division: "00" },
    ],
  }).expect(200);
  assert.equal(response.body.groups.length, 2);
  assert.equal(response.body.groups[0].salesArea.key, "1310/10/00");
});
```

- [ ] **Step 2: 运行失败测试**

Run: `npm test -- test/portal-app.test.ts`  
Expected: FAIL，因为当前端点只接受单一销售范围。

- [ ] **Step 3: 实现规范化、验证、重新报价与逐组提交**

```ts
type PortalCartLine = { product: string; quantity: number } & Omit<SalesArea, "key">;

function groupCartLines(lines: PortalCartLine[]): Map<string, { salesArea: SalesArea; items: PortalCartLine[] }> {
  // 从已由 selectedSalesArea 验证的字段构造 key，并按 key 聚合
}
```

为每个组执行 `selectedSalesArea(customer, line)`、`getSellableOffer` 与 `createPayload`。提交结果使用 `Promise.all` 收集，每组返回自己的成功或错误，已成功组不因其他组失败而回滚或重复提交。若所有组失败，端点返回 400；至少一组成功则返回 200 且含完整组结果。

同时移除 `src/catalog.ts` 中将销售组织强制覆盖为 `1310` 的 `pricingSalesArea` 行为，让 `listCurrentPrices` 和 `getOffer` 都直接使用已验证的完整 `SalesArea`。在 `test/catalog.test.ts` 中增加第二个销售组织的有效记录，并断言请求 `$filter` 含所选销售组织、分销渠道及客户号。

- [ ] **Step 4: 增加部分成功与外部销售范围拒绝测试**

```ts
assert.equal(response.body.groups[0].success, true);
assert.equal(response.body.groups[1].success, false);
await agent.post("/api/orders/preview").send({ items: [{ product: "1386", quantity: 1, salesOrganization: "9999", distributionChannel: "10", division: "00" }] }).expect(400);
```

- [ ] **Step 5: 运行测试确认通过并提交**

Run: `npm test -- test/portal-app.test.ts`  
Expected: PASS。

```bash
git add src/catalog.ts src/portal-app.ts test/catalog.test.ts test/portal-app.test.ts
git commit -m "[AI-ADD]销售范围拆分下单"
```

### Task 3: 目录、购物车与 SAP 头行订单录入页面

**Files:**
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `public/order-center.css`
- Modify: `test/order-workbench-ui.test.py`

**Interfaces:**
- Consumes: 目录 `CatalogItem` 的 `product`、`description`、`group`、`unit`、`price` 与 `catalogState.salesArea`；Task 2 的 `groups` 预览响应。
- Produces: `cart` 行保存完整销售范围；`checkoutPayload()` 传递每行范围；订单录入视图按范围显示表头和行项目。

- [ ] **Step 1: 写出浏览器失败测试**

```python
page.get_by_label("销售范围").select_option("1310/10/00")
expect(page.locator(".catalog-card").first).to_contain_text("演示物料描述")
page.get_by_role("button", name="加入购物车").first.click()
expect(page.locator("#cart-panel")).to_contain_text("1310 / 10 / 00")
page.get_by_role("button", name="去结算").click()
expect(page.locator("#order-entry-groups")).to_contain_text("订单表头")
```

- [ ] **Step 2: 运行失败测试**

Run: `python3 test/order-workbench-ui.test.py`  
Expected: FAIL，因为购物车与订单录入尚未按范围渲染。

- [ ] **Step 3: 实现前端数据模型和渲染器**

在 `addToCart` 中复制当前 `catalogState.salesArea` 到新行；相同物料只有在 `product + salesArea.key` 都相同时才合并数量。新增 `salesAreaLabel(area)`、`groupCartBySalesArea(lines)`、`renderOrderEntryGroups(groups)` 和 `renderPreviewGroups(groups)`。`checkoutPayload()` 返回每行的销售范围而不是全局单一范围。

商品卡和购物车行必须含如下字段：

```js
element("p", "product-description", item.description || "SAP 未维护描述");
element("span", "sales-area-tag", salesAreaLabel(item.salesArea));
```

订单录入组使用 `<section class="sales-order-group">`，其中包含订单抬头 `<dl>` 和带“物料号、物料描述、数量、单位、单价、金额”的行项目表格。

- [ ] **Step 4: 实现 CSS 视觉层级**

为 `.product-description`、`.sales-area-tag`、`.sales-order-group`、`.order-header-grid`、`.order-lines-table`、`.group-total` 添加组件化样式。状态色沿用现有 CSS 变量；窄屏下表格允许横向滚动，不隐藏物料描述或价格。

- [ ] **Step 5: 运行 UI 测试确认通过并提交**

Run: `python3 test/order-workbench-ui.test.py`  
Expected: PASS。

```bash
git add public/index.html public/app.js public/order-center.css test/order-workbench-ui.test.py
git commit -m "[AI-IMP]商城订单录入体验"
```

### Task 4: 订单中心完整销售范围与结构化详情

**Files:**
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `public/order-center.css`
- Modify: `test/order-workbench-ui.test.py`

**Interfaces:**
- Consumes: Task 1 的完整范围订单筛选和 `GET /api/sales-areas` 响应；`OrderDetail` 表头和行项目。
- Produces: 订单中心的完整范围筛选参数；三段式订单详情弹窗。

- [ ] **Step 1: 写出订单中心失败测试**

```python
page.get_by_role("link", name="订单中心").click()
expect(page.locator("#order-sales-area")).to_contain_text("1310 / 10 / 00")
page.get_by_role("button", name="查看明细").click()
expect(page.locator("#order-detail-dialog")).to_contain_text("订单表头")
expect(page.locator("#order-detail-dialog")).to_contain_text("行项目")
expect(page.locator("#order-detail-dialog")).to_contain_text("交货状态")
```

- [ ] **Step 2: 运行失败测试**

Run: `python3 test/order-workbench-ui.test.py`  
Expected: FAIL，因为现有订单筛选只展示销售组织，详情结构缺少分区标题。

- [ ] **Step 3: 实现完整范围筛选与三段详情**

将 `order-sales-organization` 替换为 `order-sales-area`，选项 value 使用 `SalesArea.key`。`loadOrderCenter()` 将 key 拆成 `salesOrganization`、`distributionChannel`、`division` 三个查询参数。订单详情调整为：

```html
<section class="order-detail-summary">...</section>
<section class="order-detail-header-section"><h4>订单表头</h4>...</section>
<section class="order-detail-lines-section"><h4>行项目</h4>...</section>
```

摘要含订单金额和三种状态；表头含售达方、订单类型、客户 PO、完整范围、日期和创建人；行项目表保留物料描述、数量、单位、净价、净额和交货状态。

- [ ] **Step 4: 运行 UI 测试确认通过并提交**

Run: `python3 test/order-workbench-ui.test.py`  
Expected: PASS。

```bash
git add public/index.html public/app.js public/order-center.css test/order-workbench-ui.test.py
git commit -m "[AI-IMP]订单详情结构化展示"
```

### Task 5: 全量验证与运行文档

**Files:**
- Modify: `README.md`
- Test: `test/**/*.test.ts`
- Test: `test/order-workbench-ui.test.py`

**Interfaces:**
- Consumes: Tasks 1–4 的 API 与页面行为。
- Produces: 可复现的多销售范围本地验证说明。

- [ ] **Step 1: 更新本地验证说明**

说明销售范围来自当前客户 SAP 主数据、切换范围不会清空购物车、结算将按范围创建多张订单，以及开发环境不应开启真实写入。

- [ ] **Step 2: 运行全量验证**

Run: `npm test && npm run build && python3 test/order-workbench-ui.test.py && git diff --check`  
Expected: Node 测试、TypeScript 构建、Playwright UI 测试和差异检查全部通过。

- [ ] **Step 3: 提交并推送**

```bash
git add README.md
git commit -m "[AI-IMP]多销售范围运行说明"
git push origin session/d1f90d2aa648
```

## 自检

- 设计中的完整销售范围、保留购物车、拆分订单、商品描述、SAP 风格订单录入、订单详情和测试要求均由 Task 1–5 覆盖。
- 所有输入、输出和接口字段均与现有 `SalesArea`、`OrderQuery`、订单预览/提交路由对应。
- 未包含待定项、占位任务或跨币种合计。

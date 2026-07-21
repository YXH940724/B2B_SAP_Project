# 客户订单条款与单据呈现 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按客户及完整销售范围读取 SAP 客户销售范围条款，移除国际贸易版本，并将订单详情和打印预览升级为清晰的业务单据界面。

**Architecture:** 后端继续使用 Business Partner 服务的 `A_CustomerSalesArea`，但将返回契约限定为付款条款、贸易术语和地点。前端以完整销售范围作为默认值请求身份；每次销售范围变更覆盖字段，避免旧范围值残留。订单详情与打印预览只重构 DOM 渲染和 CSS，不写入 SAP。

**Tech Stack:** TypeScript、Express、SAP OData、原生 HTML/CSS/JavaScript、Node test、Playwright。

## Global Constraints

- 只执行 SAP GET；不改变 `SAP_WRITE_ENABLED` 和任何 SAP 写入行为。
- `$filter` 必须同时包含 `Customer`、`SalesOrganization`、`DistributionChannel` 和 `Division`。
- 不展示或提交国际贸易版本字段。
- 打印只使用 `window.print()`；品牌标识使用文本 `HAND / 汉得`，不新增外部图片资源。

---

### Task 1: 收紧客户销售范围条款契约

**Files:**
- Modify: `src/order-defaults.ts`
- Modify: `src/portal-app.ts`
- Modify: `src/sales-orders.ts`
- Test: `test/order-defaults.test.ts`
- Test: `test/portal-app.test.ts`
- Test: `test/sales-orders.test.ts`

**Interfaces:**
- Consumes: `getOrderDefaults(client, config, customer, salesArea)` 和 `SalesArea`。
- Produces: `OrderDefaults = { paymentTerms?: string; incotermsClassification?: string; incotermsLocation?: string }`。

- [ ] **Step 1: 写出失败的精确 OData 与无版本字段测试**

```ts
test("reads terms from the exact customer sales area without an Incoterms version", async () => {
  const defaults = await getOrderDefaults(client as never, config, "100001", { salesOrganization: "1310", distributionChannel: "10", division: "00" });
  assert.equal(seen.params?.["$filter"], "Customer eq '0000100001' and SalesOrganization eq '1310' and DistributionChannel eq '10' and Division eq '00'");
  assert.deepEqual(defaults, { paymentTerms: "0001", incotermsClassification: "FOB", incotermsLocation: "Shanghai" });
  assert.equal(seen.params?.["$select"].includes("IncotermsVersion"), false);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx tsx --test test/order-defaults.test.ts`

Expected: FAIL，因为当前模型与 `$select` 仍包含 `IncotermsVersion`。

- [ ] **Step 3: 实现最小后端变更**

```ts
export type OrderDefaults = {
  paymentTerms?: string;
  incotermsClassification?: string;
  incotermsLocation?: string;
};

"$select": "CustomerPaymentTerms,IncotermsClassification,IncotermsTransferLocation"
```

同时从 `checkoutFields`、`PortalCheckoutSchema` 和 SAP 深度插入映射删除 `incoterms_version` / `IncotermsVersion`。

- [ ] **Step 4: 更新 API 契约测试并验证**

```ts
assert.deepEqual(defaults.body, {
  paymentTerms: "0001",
  incotermsClassification: "FOB",
  incotermsLocation: "上海",
});
```

Run: `npx tsx --test test/order-defaults.test.ts test/portal-app.test.ts test/sales-orders.test.ts`

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/order-defaults.ts src/portal-app.ts src/sales-orders.ts test/order-defaults.test.ts test/portal-app.test.ts test/sales-orders.test.ts
git commit -m '[AI-FIX]客户销售范围条款'
```

### Task 2: 销售范围切换时刷新表头默认值

**Files:**
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `test/order-workbench-ui.test.py`

**Interfaces:**
- Consumes: `GET /api/order-defaults?salesOrganization=...&distributionChannel=...&division=...`。
- Produces: 可编辑的 `#customer-payment-terms`、`#incoterms-classification`、`#incoterms-location` 字段；不再存在 `#incoterms-version`。

- [ ] **Step 1: 写出失败的页面测试**

```python
expect(page.locator("#incoterms-version")).to_have_count(0)
page.locator("#order-entry-groups select").first.select_option("1410")
expect(page.locator("#customer-payment-terms")).to_have_value("0002")
expect(page.locator("#incoterms-classification")).to_have_value("CIF")
```

测试路由按销售组织返回不同 `paymentTerms`、`incotermsClassification` 与 `incotermsLocation`。

- [ ] **Step 2: 运行页面测试确认失败**

Run: `python3 -m http.server 4180 --directory public`（单独终端）然后 `python3 test/order-workbench-ui.test.py`

Expected: FAIL，因为页面仍渲染版本字段且仅在输入框为空时赋值。

- [ ] **Step 3: 实现刷新与无陈旧响应保护**

```js
let defaultsRequestId = 0;
async function loadOrderDefaults(area) {
  const requestId = ++defaultsRequestId;
  const defaults = await api(`/api/order-defaults?${new URLSearchParams(area)}`);
  if (requestId !== defaultsRequestId) return;
  $("customer-payment-terms").value = defaults.paymentTerms || "";
  $("incoterms-classification").value = defaults.incotermsClassification || "";
  $("incoterms-location").value = defaults.incotermsLocation || "";
}
```

在销售范围下拉变动时调用该函数，并删除版本输入框、请求字段及订单摘要中的版本展示。

- [ ] **Step 4: 验证页面流程**

Run: `python3 test/order-workbench-ui.test.py`

Expected: PASS；切换销售范围后付款条款和贸易术语覆盖为新的客户销售范围值。

- [ ] **Step 5: 提交**

```bash
git add public/index.html public/app.js test/order-workbench-ui.test.py
git commit -m '[AI-FIX]销售范围条款默认值'
```

### Task 3: 结构化订单明细与 HAND 打印单据

**Files:**
- Modify: `public/app.js`
- Modify: `public/order-center.css`
- Modify: `public/order-workbench.css`
- Test: `test/order-workbench-ui.test.py`

**Interfaces:**
- Consumes: 既有 `OrderDetail` 的 `header`、`items`、状态、履约、税务与金额字段。
- Produces: `order-line-card`、`print-brand`、`print-document-header`、`print-document-footer` DOM 类。

- [ ] **Step 1: 写出失败的结构化呈现测试**

```python
expect(page.locator("#order-detail-lines .order-line-card")).to_have_count(2)
expect(page.locator("#order-detail-lines .order-line-card").first).to_contain_text("税务")
expect(page.locator("#print-preview-content .print-brand")).to_contain_text("HAND")
expect(page.locator("#print-preview-content .print-document-footer")).to_contain_text("汉得")
```

- [ ] **Step 2: 运行页面测试确认失败**

Run: `python3 test/order-workbench-ui.test.py`

Expected: FAIL，因为当前行项目是单个表格，打印内容没有品牌和页脚结构。

- [ ] **Step 3: 实现卡片化明细与单据打印 DOM**

```js
const lineCard = element("article", "order-line-card");
lineCard.append(
  labeledGroup("物料", [item.material, item.description]),
  labeledGroup("数量与金额", [`${item.quantity} ${item.unit}`, formatMoney(item.currency, item.netAmount)]),
  labeledGroup("税务", [taxLabel(item)]),
  labeledGroup("履约", [plantStorageLabel(item), item.deliveryStatus?.label])
);

host.append(
  element("div", "print-brand", "HAND / 汉得"),
  documentHeader,
  metadata,
  table,
  totals,
  element("footer", "print-document-footer", "感谢您选择汉得客户服务门户")
);
```

- [ ] **Step 4: 添加响应式与打印样式并验证**

```css
.order-line-card { display:grid; grid-template-columns:2fr repeat(3,1fr); gap:12px; }
.print-brand { font-weight:800; letter-spacing:.12em; color:#0e4b8f; }
@media print { .print-preview-content { box-shadow:none; } }
```

Run: `python3 test/order-workbench-ui.test.py && npm test && npm run build`

Expected: 页面测试、全部单元测试与 TypeScript 构建均 PASS。

- [ ] **Step 5: 提交**

```bash
git add public/app.js public/order-center.css public/order-workbench.css test/order-workbench-ui.test.py
git commit -m '[AI-IMP]订单明细与打印单据'
```

### Task 4: 最终验证与交付

**Files:**
- Modify: 无生产文件；仅验证提交。

- [ ] **Step 1: 运行完整验证**

Run: `npm test && npm run build`

Expected: 62+ tests PASS and `tsc` exits 0.

- [ ] **Step 2: 运行浏览器回归**

Run: `python3 -m http.server 4180 --directory public`（单独终端）然后 `python3 test/order-workbench-ui.test.py`

Expected: PASS；测试结束后停止静态服务器。

- [ ] **Step 3: 检查差异并推送分支**

```bash
git status --short
git push origin session/d1f90d2aa648
```

Expected: 仅预期的受版本控制文件已提交；不提交 `.superpowers/` 临时文件。

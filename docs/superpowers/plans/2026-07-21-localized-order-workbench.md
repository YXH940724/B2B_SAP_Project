# 本地化订单工作台 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 SAP 客户门户增加按登录语言的物料描述、客户主数据默认订单条款、物料工厂/库位选择、结构化订单录入与详情，以及可打印的订单预览。

**Architecture:** 扩展主数据访问层以按语言、销售范围和物料读取真实 SAP 主数据；门户路由将这些数据限制在当前会话客户与选定销售范围内。订单行对象携带可写 SAP 字段，税务字段仅作为展示状态；前端在全宽订单工作台中编辑每个销售范围订单组，并复用同一份结构化数据供详情与打印使用。

**Tech Stack:** Node.js、TypeScript、Express、Zod、Axios SAP OData client、原生 HTML/CSS/JavaScript、node:test、Playwright。

## Global Constraints

- 全部 SAP 查询为 GET；不得在测试中创建或更新 SAP 销售订单。
- 用户会话客户是所有客户、销售范围、默认条款和目录请求的唯一身份来源。
- 物料描述按 `Language` 精确匹配；未维护时明确回退到物料号。
- 税率/税额不接受客户输入，也不写入 SAP；未取得价格元素时显示“SAP 定价后确认”。
- 新增写入字段仅限已验证的 `CustomerPaymentTerms`、`Incoterms*`、`MaterialByCustomer`、`ProductionPlant`、`StorageLocation`。
- 工厂必须在提交前有值；库位只在 SAP 返回库位清单时要求选择。

---

### Task 1: 本地化物料与订单上下文主数据

**Files:**
- Modify: `src/master-data.ts`
- Modify: `src/catalog.ts`
- Create: `src/order-defaults.ts`
- Modify: `src/web-server.ts`
- Test: `test/master-data.test.ts`
- Test: `test/catalog.test.ts`

**Interfaces:**
- Produces `getProductDetails(client, config, product, language)` with `descriptionLanguage` and fallback marker.
- Produces `getOrderDefaults(client, config, customer, salesArea)` and `getProductFulfillmentOptions(client, config, product)`.
- `CatalogService.list(customer, salesArea, query, language)` consumes the selected language.

- [ ] **Step 1: Write failing product-language and fulfillment tests**

```ts
test("prefers the requested SAP product description language", async () => {
  const details = await getProductDetails(client as never, config, "MAT-01", "EN");
  assert.equal(details.description, "English description");
  assert.equal(details.descriptionLanguage, "EN");
});

test("marks a product-number fallback when SAP has no requested description", async () => {
  const details = await getProductDetails(client as never, config, "MAT-02", "ZH");
  assert.equal(details.description, "MAT-02");
  assert.equal(details.descriptionFallback, true);
});

test("uses the first product plant and exposes its storage locations", async () => {
  const options = await getProductFulfillmentOptions(client as never, config, "MAT-01");
  assert.deepEqual(options, { defaultPlant: "1310", plants: ["1310", "1320"], storageLocationsByPlant: { "1310": ["0001", "0002"], "1320": [] } });
});
```

- [ ] **Step 2: Run the new test file and verify RED**

Run: `npm test -- test/master-data.test.ts`

Expected: FAIL because `getProductDetails` has no language argument and `getProductFulfillmentOptions` does not exist.

- [ ] **Step 3: Implement SAP master-data readers**

```ts
export type ProductDetails = {
  product: string; description: string; descriptionLanguage: string; descriptionFallback: boolean;
  productGroup: string; baseUnit: string;
};

export async function getProductDetails(client: SapODataClient, config: SapConfig, product: string, language = "ZH"): Promise<ProductDetails> {
  const [header, descriptions] = await Promise.all([
    client.getAt<ProductHeader>(config.services.product, `/A_Product('${odataKey(product)}')`, { "$select": "Product,ProductGroup,BaseUnit" }),
    client.getAt<ODataResults<ProductDescription>>(config.services.product, "/A_ProductDescription", { "$filter": `Product eq '${odataKey(product)}' and Language eq '${odataKey(language)}'`, "$select": "Product,Language,ProductDescription", "$top": 1 }),
  ]);
  const description = descriptions.data.results?.[0]?.ProductDescription?.trim();
  return { product: header.data.Product ?? product, description: description || header.data.Product || product, descriptionLanguage: language, descriptionFallback: !description, productGroup: header.data.ProductGroup?.trim() || "UNCLASSIFIED", baseUnit: header.data.BaseUnit?.trim() || "" };
}
```

Implement `order-defaults.ts` with a sales-area-filtered `A_CustomerSalesArea` request selecting `CustomerPaymentTerms` and `Incoterms*`, plus product-plant and product-storage-location requests that sort and group returned values.

- [ ] **Step 4: Thread language through catalog service**

```ts
async list(customer: string, salesArea: SalesArea, query: CatalogQuery, language = "ZH"): Promise<CatalogPage> {
  // Existing price selection remains unchanged.
  const detailEntries = await mapWithConcurrency([...prices.values()], 8, async (price) => ({ price, detail: await getProductDetails(this.client, this.config, price.material, language) }));
  // Include descriptionLanguage and descriptionFallback in CatalogItem.
}
```

- [ ] **Step 5: Run focused tests and verify GREEN**

Run: `npm test -- test/master-data.test.ts test/catalog.test.ts`

Expected: PASS; catalog tests assert `Language eq 'ZH'` or supplied language in the product-description request.

- [ ] **Step 6: Commit**

```bash
git add src/master-data.ts src/catalog.ts src/order-defaults.ts src/web-server.ts test/master-data.test.ts test/catalog.test.ts
git commit -m "[AI-ADD]订单主数据上下文"
```

### Task 2: 扩展门户 API、预览和 SAP 销售订单载荷

**Files:**
- Modify: `src/portal-app.ts`
- Modify: `src/sales-orders.ts`
- Modify: `src/order-history.ts`
- Test: `test/portal-app.test.ts`
- Test: `test/sales-orders.test.ts`
- Test: `test/order-history.test.ts`

**Interfaces:**
- `GET /api/catalog` accepts `language`.
- `GET /api/order-defaults` and `GET /api/products/:product/fulfillment` return session-scoped SAP defaults/options.
- `PortalCartLine` adds `customerMaterial`, `productionPlant`, and `storageLocation`.
- `PortalCheckoutSchema` adds editable payment and Incoterms fields.

- [ ] **Step 1: Write failing route and payload tests**

```ts
test("uses the session customer and requested language when loading catalog", async () => {
  await agent.get("/api/catalog?salesOrganization=1310&distributionChannel=10&division=00&language=EN").expect(200);
  assert.equal(receivedLanguage, "EN");
});

test("returns payment and Incoterms defaults only for the selected customer sales area", async () => {
  const response = await agent.get("/api/order-defaults?salesOrganization=1310&distributionChannel=10&division=00").expect(200);
  assert.equal(response.body.paymentTerms, "0001");
});

test("maps editable order terms and fulfillment fields to SAP properties", () => {
  const payload = createPayload(input);
  assert.equal(payload.CustomerPaymentTerms, "0001");
  assert.equal(payload.IncotermsClassification, "FOB");
  assert.deepEqual(payload.to_Item, { results: [{ MaterialByCustomer: "CUST-01", ProductionPlant: "1310", StorageLocation: "0001" }] });
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `npm test -- test/portal-app.test.ts test/sales-orders.test.ts test/order-history.test.ts`

Expected: FAIL because the routes, validation fields and SAP payload properties are absent.

- [ ] **Step 3: Extend safe request parsing and session-scoped routes**

```ts
function catalogLanguage(req: express.Request): string {
  const language = String(req.query.language ?? "ZH").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(language)) throw new Error("物料描述语言无效。");
  return language;
}

app.get("/api/order-defaults", async (req, res) => {
  const active = session(req);
  const salesArea = await selectedSalesArea(active.customer, req.query as SalesAreaSource);
  res.json(await orderDefaultsDependencies().get(active.customer, salesArea));
});
```

Pass `catalogLanguage(req)` to `catalog.list`. Validate every fulfillment request against the product in the cart and never accept customer identity from request body.

- [ ] **Step 4: Extend Zod schemas and SAP payload mapping**

```ts
const ItemSchema = z.object({
  material: z.string().min(1).max(40), requested_quantity: z.number().positive(), requested_quantity_unit: z.string().min(1).max(3),
  customer_material: z.string().trim().min(1).max(35).optional(), production_plant: z.string().min(1).max(4), storage_location: z.string().min(1).max(4).optional(),
}).strict();

// In createPayload
...(input.customer_payment_terms ? { CustomerPaymentTerms: input.customer_payment_terms } : {}),
...(input.incoterms_classification ? { IncotermsClassification: input.incoterms_classification } : {}),
// Item: MaterialByCustomer, ProductionPlant, StorageLocation
```

Map header fields and line fields in both preview and submit. Do not add tax values to the POST payload.

- [ ] **Step 5: Extend order detail data for tax/pricing display**

```ts
export type OrderDetail = {
  header: OrderSummary & { requestedDeliveryDate: string | null; customerPurchaseOrderDate: string | null; createdByUser: string | null; paymentTerms: string | null; incotermsClassification: string | null; incotermsLocation: string | null };
  items: Array<{ item: string; material: string | null; description: string | null; quantity: number; unit: string | null; netPrice: number | null; netAmount: number; currency: string | null; deliveryStatus: OrderStatus; customerMaterial: string | null; productionPlant: string | null; storageLocation: string | null; taxCode: string | null; taxRate: number | null; taxAmount: number | null }>;
};
```

Read `to_ItemPricingElement` only for an already existing order and derive tax rows from `TaxCode`, `ConditionRateValue`, and `ConditionAmount`. Missing pricing elements remain `null` rather than fabricated values.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run: `npm test -- test/portal-app.test.ts test/sales-orders.test.ts test/order-history.test.ts`

Expected: PASS; existing write-guard tests remain unchanged and no test sends a POST to SAP.

- [ ] **Step 7: Commit**

```bash
git add src/portal-app.ts src/sales-orders.ts src/order-history.ts test/portal-app.test.ts test/sales-orders.test.ts test/order-history.test.ts
git commit -m "[AI-ADD]订单条款与履约字段"
```

### Task 3: 订单工作台、详情与打印预览 UI

**Files:**
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `public/styles.css`
- Modify: `public/order-center.css`
- Test: `test/portal-app.test.ts`
- Test: `test/order-workbench-ui.test.py`

**Interfaces:**
- Cart lines persist `customerMaterial`, `productionPlant`, `storageLocation`, and master-data options.
- `renderOrderEntry`, `renderOrderDetail`, and `renderPrintPreview` consume the extended API responses.
- `#print-order-detail` opens an A4 preview and invokes `window.print()`.

- [ ] **Step 1: Write failing static/UI assertions**

```ts
test("serves a localized product description control and printable order detail shell", () => {
  const html = readFileSync("public/index.html", "utf8");
  assert.match(html, /id="catalog-language"/);
  assert.match(html, /id="print-order-detail"/);
  assert.match(html, /id="print-preview"/);
});
```

Add Playwright assertions that open checkout, see payment/Incoterms fields, see customer material/plant/storage columns, open an order detail, and invoke the print-preview button without a JavaScript error.

- [ ] **Step 2: Run browser and static tests and verify RED**

Run: `npm test -- test/portal-app.test.ts && python3 test/order-workbench-ui.test.py`

Expected: FAIL because the new controls and rendering functions are absent.

- [ ] **Step 3: Build full-width order-entry markup and client state**

```html
<section id="view-order-entry" class="order-workbench" hidden>
  <header class="order-workbench-hero"><p class="eyebrow">销售订单</p><h2>订单录入工作台</h2><p>按销售范围分别维护 SAP 销售订单表头与行项目。</p></header>
  <form id="order-header-form" class="order-workbench-grid">
    <section class="order-header-card"><label>付款条款<select id="customer-payment-terms"></select></label><label>贸易术语<input id="incoterms-classification" maxlength="3"></label><label>贸易地点<input id="incoterms-location" maxlength="70"></label><label>期望交货日期<input id="requested-delivery-date" type="date"></label><label>客户采购订单号<input id="purchase-order-by-customer" maxlength="35"></label></section>
    <section id="order-entry-groups" class="order-groups-editor"></section>
    <aside class="order-workbench-summary"><p class="eyebrow">金额汇总</p><div id="order-workbench-totals"></div><button type="submit">查看订单摘要</button></aside>
  </form>
</section>
```

On sales-area group render, fetch `/api/order-defaults` once per group. On each material row, fetch fulfillment options once, default the plant, render a storage select only when available, and preserve cart data when returning to the catalog.

- [ ] **Step 4: Render localized descriptions and truthful tax preview**

```js
function catalogLanguage() { return $("catalog-language").value || navigator.language.slice(0, 2).toUpperCase(); }
function taxPreview(item) { return item.taxAmount == null ? "SAP 定价后确认" : formatMoney(item.currency, item.taxAmount); }
```

Send `language` from `loadCatalog`. Mark `descriptionFallback` cards with “SAP 未维护当前语言描述”. Include edited header and item fields in `checkoutPayload()`.

- [ ] **Step 5: Rebuild order detail and print preview**

```js
function renderOrderDetail(data) {
  renderOrderDetailSummary(data.header);
  renderOrderDetailHeaderFields(data.header);
  renderOrderDetailItemTable(data.items);
}

$("print-order-detail").addEventListener("click", () => {
  $("print-preview").open = true;
  window.print();
});
```

Use a dedicated preview container, a print title, terms, every line field, tax status and totals. Do not inject unsanitized HTML from SAP values; continue using `textContent` via `element()`.

- [ ] **Step 6: Add responsive and print CSS**

```css
.order-workbench-grid { display:grid; grid-template-columns:minmax(0,1fr) 300px; gap:24px; }
.order-line-editor { display:grid; grid-template-columns:1.1fr 1.5fr repeat(5,minmax(90px,1fr)); gap:10px; }
@media print { .store-header,.dialog-actions,.text-button,button { display:none !important; } #print-preview { display:block; } }
@media (max-width:900px) { .order-workbench-grid { grid-template-columns:1fr; } }
```

- [ ] **Step 7: Run browser/static tests and verify GREEN**

Run: `npm test -- test/portal-app.test.ts && python3 test/order-workbench-ui.test.py`

Expected: PASS; tests verify the no-empty-left-column workbench and structural detail/print controls.

- [ ] **Step 8: Commit**

```bash
git add public/index.html public/app.js public/styles.css public/order-center.css test/portal-app.test.ts test/order-workbench-ui.test.py
git commit -m "[AI-IMP]本地化订单工作台界面"
```

### Task 4: End-to-end verification and operator documentation

**Files:**
- Modify: `README.md`
- Test: `test/catalog.test.ts`
- Test: `test/portal-app.test.ts`
- Test: `test/order-workbench-ui.test.py`

**Interfaces:**
- Documents environment language behavior, customer master prerequisites, print behavior and SAP write guard.

- [ ] **Step 1: Add README validation checklist**

Document that product descriptions require `A_ProductDescription` language records, defaults require `A_CustomerSalesArea` terms/Incoterms, fulfillment requires `A_ProductPlant`/`A_ProductStorageLocation`, and tax preview becomes authoritative only after SAP order pricing exists.

- [ ] **Step 2: Run complete regression suite**

Run: `npm test && npm run build && python3 test/order-workbench-ui.test.py`

Expected: all Node tests, TypeScript build and browser test pass.

- [ ] **Step 3: Perform authenticated read-only SAP smoke test**

Load approved environment values only in process memory. Read one customer sales area, one `A_ProductDescription` row, one `A_ProductPlant`/`A_ProductStorageLocation` row, one A305 price condition, and one sales-order detail. Report statuses/counts only; do not log credentials or business values and do not execute a write request.

- [ ] **Step 4: Commit**

```bash
git add README.md test/catalog.test.ts test/portal-app.test.ts test/order-workbench-ui.test.py
git commit -m "[AI-IMP]订单工作台联调说明"
git push origin session/d1f90d2aa648
```

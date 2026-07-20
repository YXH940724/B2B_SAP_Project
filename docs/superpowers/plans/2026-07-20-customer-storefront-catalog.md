# SAP 客户订货商城目录与购物车 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将已登录客户的简易物料查询页升级为一个基于 A305/ZR01 有效价格的、可搜索且分页的 SAP 客户订货商城，并在结算时收集交货日期、客户采购订单号和备注。

**Architecture:** 新建服务端 `CatalogService`，将定价有效期记录与产品主数据聚合为每个登录客户可见的商品 DTO；Express 提供一个会话保护的目录端点。浏览器使用新的商城布局，只请求该端点并在本地维护购物车；下单前由服务端重新定价，且只在写入开关和二次确认同时满足时调用 SAP OData POST。

**Tech Stack:** TypeScript、Express 5、Axios、Node test runner、Supertest、原生浏览器 JavaScript/CSS、SAP S/4HANA OData V2。

## Global Constraints

- 所有源代码改动只能位于 worktree `/tmp/wt-d1f90d2aa648` 的 `session/d1f90d2aa648` 分支；每一阶段提交并推送。
- 目录只展示条件类型 `ZR01`、条件表 `305`（A305）且当前日期有效、未删除并具有正价格的物料。
- 浏览器不得直接调用 SAP；不得对每张商品卡调用单独的门户 API。
- 客户号必须以现有 `normalizeCustomer` 规范化为 10 位；客户与 Business Partner 不能假设编号相同。
- 登录、注册、会话 Cookie、验证码投递和现有订单安全控制不得回归。
- 销售订单真实写入仍要求 `SAP_WRITE_ENABLED=true` 与 `confirm: true`；前端确认弹窗不能绕过服务端控制。
- 密码、验证码、SAP 凭据、证书、数据库文件和订单敏感日志不得提交 Git 或回显到页面。
- 默认分页大小为 20，允许范围 1–50；搜索、筛选和排序改变时页码重置为 1。

---

### Task 1: 建立可售商品目录领域服务

**Files:**
- Create: `src/catalog.ts`
- Create: `test/catalog.test.ts`
- Modify: `src/master-data.ts`
- Modify: `src/portal.ts`

**Interfaces:**
- Produces `CatalogItem`、`CatalogPage`、`CatalogQuery`、`CatalogService`。
- `CatalogService.list(query: CatalogQuery): Promise<CatalogPage>` 接收 `{ query?: string; group?: string; page: number; pageSize: number; sort: "material" | "price" }` 并返回目录、物料组和分页元数据。
- `CatalogService.getOffer(product: string)` 保持为订单预览与提交提供单一物料的服务端重新定价。
- `getProductDetails(client, config, product)` 返回 `{ product, description, productGroup, baseUnit }`，并对 OData key 使用 `odataKey`。

- [ ] **Step 1: 写出目录筛选、价格有效期、描述回退和分页的失败测试**

Create `test/catalog.test.ts` with a fake `getAt` client that returns three validity rows and product data. The test fixture must cover one valid A305/ZR01 row, one expired row, one wrong condition-table row, and one product without a description.

```ts
test("lists only current A305 ZR01 products with product details and pagination", async () => {
  const catalog = new CatalogService(fakeClient as never, config, new Date("2026-07-20T00:00:00Z"));
  const page = await catalog.list({ page: 1, pageSize: 1, sort: "material" });

  assert.equal(page.total, 2);
  assert.deepEqual(page.groups, [
    { code: "FG", label: "FG", count: 1 },
    { code: "UNCLASSIFIED", label: "未分类", count: 1 },
  ]);
  assert.deepEqual(page.items[0], {
    product: "000000000000001386",
    description: "演示物料",
    productGroup: "FG",
    baseUnit: "PC",
    conditionRecord: "0000000123",
    unitPrice: "30.00",
    currency: "CNY",
    priceUnit: "PC",
  });
  assert.equal(page.pageCount, 2);
});

test("filters a catalog by material group and a material-number-or-description query", async () => {
  const catalog = new CatalogService(fakeClient as never, config, new Date("2026-07-20T00:00:00Z"));
  assert.equal((await catalog.list({ query: "1386", page: 1, pageSize: 20, sort: "material" })).items.length, 1);
  assert.equal((await catalog.list({ query: "无描述物料", group: "UNCLASSIFIED", page: 1, pageSize: 20, sort: "material" })).items.length, 1);
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `npm test -- --test-name-pattern='lists only current|filters a catalog'`

Expected: FAIL because `src/catalog.ts` and `CatalogService` do not exist.

- [ ] **Step 3: 定义目录 DTO、有效期判断和产品详情读取**

Create `src/catalog.ts` with these exact public shapes:

```ts
export interface CatalogItem {
  product: string;
  description: string;
  productGroup: string;
  baseUnit: string;
  conditionRecord: string;
  unitPrice: string;
  currency: string;
  priceUnit: string;
}

export interface CatalogPage {
  items: CatalogItem[];
  groups: Array<{ code: string; label: string; count: number }>;
  page: number;
  pageSize: number;
  total: number;
  pageCount: number;
}

export interface CatalogQuery {
  query?: string;
  group?: string;
  page: number;
  pageSize: number;
  sort: "material" | "price";
}
```

Add to `src/master-data.ts`:

```ts
export interface ProductDetails {
  product: string;
  description: string;
  productGroup: string;
  baseUnit: string;
}

export async function getProductDetails(client: SapODataClient, config: SapConfig, product: string): Promise<ProductDetails> {
  const header = await client.getAt<{ Product?: string; ProductGroup?: string; BaseUnit?: string }>(
    config.services.product,
    `/A_Product('${odataKey(product)}')`,
    { "$select": "Product,ProductGroup,BaseUnit", "$expand": "to_Description" },
  );
  const descriptions = (header.data as { to_Description?: { results?: Array<{ ProductDescription?: string }> } }).to_Description?.results ?? [];
  return {
    product: header.data.Product ?? product,
    description: descriptions.map(({ ProductDescription }) => ProductDescription?.trim()).find((value): value is string => Boolean(value)) ?? product,
    productGroup: header.data.ProductGroup?.trim() || "UNCLASSIFIED",
    baseUnit: header.data.BaseUnit?.trim() || "",
  };
}
```

- [ ] **Step 4: 实现定价读取、去重、过滤、排序和分页**

In `CatalogService`, request `/A_SlsPrcgCndnRecdValidity` from `config.services.pricing` with:

```ts
{
  "$filter": "ConditionType eq 'ZR01'",
  "$select": "Material,ConditionRecord,ConditionType,ConditionValidityStartDate,ConditionValidityEndDate",
  "$expand": "to_SlsPrcgConditionRecord",
  "$top": 200,
  "$skip": offset,
}
```

Loop while a page contains 200 rows. Keep a row only when its expanded record has `ConditionTable === "305"`, a finite positive `ConditionRateValue`, no deletion flag, and a validity interval containing the injected `now`. For duplicate materials, choose the row with the latest validity start date, then lexical `ConditionRecord` as deterministic tie-breaker. Resolve `getProductDetails` with a concurrency limit of eight, discard a material only if its product lookup fails, and sort by padded material number or numeric unit price. Match a normalized lower-case query against both `product` and `description`; map group `UNCLASSIFIED` to label `未分类`; clamp page to `[1, pageCount || 1]`.

Refactor `getSellableOffer` in `src/portal.ts` to delegate the same price-validity predicate used by `CatalogService`, so the catalog and order paths cannot disagree about A305/ZR01 validity.

- [ ] **Step 5: 运行目录测试、完整测试与构建**

Run: `npm test && npm run build`

Expected: all existing tests plus the new catalog tests pass, and TypeScript emits `dist/catalog.js`.

- [ ] **Step 6: 提交目录服务**

```bash
git add src/catalog.ts src/master-data.ts src/portal.ts test/catalog.test.ts
git commit -m '[AI-ADD]可售物料目录服务'
git push origin session/d1f90d2aa648
```

### Task 2: 暴露受会话保护的目录、客户摘要和结算字段

**Files:**
- Modify: `src/portal-app.ts`
- Modify: `src/sales-orders.ts`
- Modify: `test/portal-app.test.ts`
- Modify: `test/sales-orders.test.ts`

**Interfaces:**
- Consumes `CatalogService.list` and `getCustomer`.
- Replaces `GET /api/catalog/:product` with `GET /api/catalog?query=&group=&page=&pageSize=&sort=`.
- Produces `GET /api/me` returning `{ customer, name, accountGroup, businessPartner }` without email.
- Extends `POST /api/orders/preview` and `POST /api/orders/submit` with optional `{ requestedDeliveryDate?: string; purchaseOrderByCustomer?: string; note?: string }`.

- [ ] **Step 1: 写出 HTTP 合同和订单负载失败测试**

Add to `test/portal-app.test.ts` a fake catalog dependency and authenticated agent test:

```ts
test("returns a session-protected, paginated catalog and customer summary", async () => {
  const agent = await registeredAgent(makeStorefrontApp());
  const response = await agent.get("/api/catalog?query=1386&group=FG&page=1&pageSize=20&sort=material").expect(200);
  assert.equal(response.body.items[0].product, "000000000000001386");
  assert.equal(response.body.groups[0].code, "FG");
  assert.equal(response.body.page, 1);
  assert.deepEqual((await agent.get("/api/me").expect(200)).body, {
    customer: "0000100001", name: "演示客户", accountGroup: "Z001", businessPartner: "0000000046",
  });
});

test("rejects catalog requests without a session and rejects invalid page size", async () => {
  await request(makeStorefrontApp().app).get("/api/catalog?pageSize=51").expect(401);
  const agent = await registeredAgent(makeStorefrontApp());
  await agent.get("/api/catalog?pageSize=51").expect(400);
});
```

Add to `test/sales-orders.test.ts`:

```ts
test("maps purchase reference and requested delivery date into the SAP payload", () => {
  const payload = createPayload({
    sales_order_type: "OR", sales_organization: "1000", distribution_channel: "10", organization_division: "00",
    sold_to_party: "0000100001", purchase_order_by_customer: "PO-2026-01", requested_delivery_date: "2026-08-01",
    items: [{ material: "000000000000001386", requested_quantity: 2, requested_quantity_unit: "PC" }], dry_run: false, response_format: "json",
  });
  assert.equal(payload.PurchaseOrderByCustomer, "PO-2026-01");
  assert.equal(payload.RequestedDeliveryDate, "2026-08-01T00:00:00");
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `npm test -- --test-name-pattern='session-protected, paginated|invalid page size|maps purchase reference'`

Expected: FAIL because the new route, dependencies and `requested_delivery_date` schema field are absent.

- [ ] **Step 3: 添加依赖、输入解析和目录路由**

Extend `PortalDependencies` with:

```ts
catalog?: { list(query: CatalogQuery): Promise<CatalogPage> };
customer?: { get(customer: string): Promise<{ customer: string; name: string; accountGroup: string; businessPartner: string }> };
```

Implement an `integerQuery(value, fallback, min, max)` helper that rejects non-integers outside bounds. After `session(req)`, parse only `query`, `group`, `page`, `pageSize`, and `sort`; accept sort values `material` and `price` only. Return `401` for no/expired session, `400` for invalid query values, and never include SAP service URLs or credentials in the error JSON. Add `/api/me` and use `deps.customer.get` to resolve the session customer.

- [ ] **Step 4: 增加订单元数据校验与 SAP 映射**

Export a reusable `PortalCheckoutSchema` in `src/sales-orders.ts`, then merge it into `CreateSalesOrderSchema`:

```ts
export const PortalCheckoutSchema = z.object({
  requested_delivery_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  purchase_order_by_customer: z.string().trim().min(1).max(35).optional(),
  portal_note: z.string().trim().max(500).optional(),
}).strict();

export const CreateSalesOrderSchema = z.object({
  sales_order_type: z.string().min(1).max(4),
  sales_organization: z.string().min(1).max(4),
  distribution_channel: z.string().min(1).max(2),
  organization_division: z.string().min(1).max(2),
  sold_to_party: z.string().min(1).max(10),
  items: z.array(ItemSchema).min(1).max(100),
  dry_run: z.boolean().default(true),
  confirm: z.literal("CREATE_SALES_ORDER").optional(),
  response_format: ResponseFormat,
}).merge(PortalCheckoutSchema);
```

Extend `createPayload`:

```ts
...(input.requested_delivery_date ? { RequestedDeliveryDate: `${input.requested_delivery_date}T00:00:00` } : {}),
```

Continue to map `purchase_order_by_customer` to `PurchaseOrderByCustomer`. Keep `portal_note` out of the raw SAP payload until the customer supplies a verified SAP sales-order text extension/field; return it in the portal preview and log only its character count. This prevents sending an unsupported OData field while retaining the customer-entered value through confirmation.

In both preview and submit routes, map incoming camel-case keys to the snake-case schema keys, then validate date, purchase reference and note with `PortalCheckoutSchema.safeParse` before pricing. On submit, build `CreateSalesOrderSchema` only after server configuration supplies the required sales-area fields, derive item prices afresh, require `confirm === true`, and preserve the existing `assertWriteAllowed` gate before `client.write("post", "/A_SalesOrder", payload)`.

- [ ] **Step 5: 运行 API、订单、完整测试与构建**

Run: `npm test && npm run build`

Expected: unauthenticated directory access is rejected; valid catalog and customer payloads are returned; sales-order payload carries only supported standard header fields.

- [ ] **Step 6: 提交 HTTP 合同与订单字段**

```bash
git add src/portal-app.ts src/sales-orders.ts test/portal-app.test.ts test/sales-orders.test.ts
git commit -m '[AI-ADD]商城目录接口与结算字段'
git push origin session/d1f90d2aa648
```

### Task 3: 重建商城前端、搜索分页和购物车结算体验

**Files:**
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `public/styles.css`
- Modify: `test/portal-app.test.ts`

**Interfaces:**
- Consumes `/api/login`, `/api/logout`, `/api/me`, `/api/catalog`, `/api/orders/preview`, and `/api/orders/submit`.
- `loadCatalog({ page, query, group, sort })` is the only browser function that requests catalog data.
- `cart` stores `{ product, description, baseUnit, unitPrice, currency, priceUnit, quantity }[]`; it never provides a price to order preview/submit.

- [ ] **Step 1: 写出页面骨架、目录入口和结算字段失败测试**

Add a static-content test in `test/portal-app.test.ts`:

```ts
test("serves the storefront navigation, catalog controls, cart and checkout fields", () => {
  const html = fs.readFileSync(path.resolve(import.meta.dirname, "../public/index.html"), "utf8");
  assert.match(html, /id="catalog-search"/);
  assert.match(html, /id="material-groups"/);
  assert.match(html, /id="catalog-grid"/);
  assert.match(html, /id="catalog-pagination"/);
  assert.match(html, /id="cart-items"/);
  assert.match(html, /id="requested-delivery-date"/);
  assert.match(html, /id="purchase-order-by-customer"/);
  assert.match(html, /id="portal-note"/);
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `npm test -- --test-name-pattern='serves the storefront navigation'`

Expected: FAIL because the current page only has `product-form`, a table cart and one submit button.

- [ ] **Step 3: 替换门户 HTML 为商城语义结构**

Keep the existing authentication sections and replace only the hidden `#portal` contents with:

```html
<header class="store-header">
  <a class="brand" href="#catalog">SAP 客户订货商城</a>
  <nav aria-label="主导航"><a href="#catalog">商品目录</a><a href="#checkout">我的订单</a><a href="#customer-summary">客户中心</a></nav>
  <button id="logout" type="button" class="text-button">退出登录</button>
</header>
<div class="store-layout">
  <aside id="customer-summary"></aside>
  <section id="catalog"><form id="catalog-search-form"><input id="catalog-search"><button>搜索</button></form><div id="material-groups"></div><div id="catalog-grid"></div><div id="catalog-pagination"></div></section>
  <aside id="cart-panel"><div id="cart-items"></div><p id="cart-total"></p><button id="checkout-button" disabled>去结算</button></aside>
</div>
<section id="checkout" hidden><form id="checkout-form"><input id="requested-delivery-date" type="date"><input id="purchase-order-by-customer" maxlength="35"><textarea id="portal-note" maxlength="500"></textarea><button>确认订单</button></form></section>
<dialog id="order-confirmation-dialog"><div id="order-confirmation-summary"></div><button id="confirm-order-button">确认并同步至 SAP</button><button id="cancel-order-button">返回修改</button></dialog>
```

Use `textContent`, `createElement`, and DOM event listeners for all SAP-derived display values; do not inject descriptions with `innerHTML`.

- [ ] **Step 4: 实现单目录请求、可访问购物车和确认对话框**

In `public/app.js`, replace `product-form` behavior with these exact state fields and functions:

```js
const catalogState = { page: 1, pageSize: 20, query: "", group: "", sort: "material" };
const cart = [];

async function loadCatalog(next = {}) {
  Object.assign(catalogState, next);
  const params = new URLSearchParams({ page: String(catalogState.page), pageSize: String(catalogState.pageSize), sort: catalogState.sort });
  if (catalogState.query) params.set("query", catalogState.query);
  if (catalogState.group) params.set("group", catalogState.group);
  const data = await api(`/api/catalog?${params}`);
  renderGroups(data.groups); renderCatalog(data.items); renderPagination(data); renderCart();
}
```

`addToCart(item)` must merge matching `product` lines and increase quantity by one. `renderCart` must provide labelled decrement, increment and remove buttons, disable decrement at quantity one, and calculate totals from the displayed server price. Login success must call `/api/me`, render the sanitized customer summary, then `loadCatalog()`. Search and group selection must call `loadCatalog({ page: 1, ... })`; pagination controls must call `loadCatalog({ page: targetPage })`.

The checkout form calls `/api/orders/preview` with products and quantities only, renders the returned final totals in `#order-confirmation-summary`, then calls `dialog.showModal()`. The confirmation button sends `{ confirm: true, items, requestedDeliveryDate, purchaseOrderByCustomer, note }`; it is disabled while pending and clears cart only after a successful SAP response. `dialog.close()` must be used for cancel and failure recovery.

- [ ] **Step 5: 实现响应式商城样式**

In `public/styles.css`, add CSS custom properties for group color classes, a three-column desktop grid (`220px minmax(0, 1fr) 300px`), card grid (`repeat(auto-fill, minmax(220px, 1fr))`), sticky cart panel, clearly visible focus outlines, and breakpoints at `960px` and `640px`. At `960px`, make the cart a full-width row below catalog; at `640px`, stack customer, catalog and cart and keep add-to-cart controls reachable. Preserve contrast for all group-color banners and use no external images.

- [ ] **Step 6: 运行前端合同测试、全量测试和构建**

Run: `npm test && npm run build`

Expected: the page contains all static controls, existing registration tests still pass, and TypeScript build completes.

- [ ] **Step 7: 提交商城界面**

```bash
git add public/index.html public/app.js public/styles.css test/portal-app.test.ts
git commit -m '[AI-IMP]客户商城购物车界面'
git push origin session/d1f90d2aa648
```

### Task 4: 补充运行说明并做端到端安全验证

**Files:**
- Modify: `README.md`
- Modify: `.env.example`
- Modify: `test/portal-app.test.ts`

**Interfaces:**
- Documents the fixed initial UI default of 20 items per page; no SAP secret may be documented as a literal.
- Documents that `portal_note` stays in the portal confirmation flow until a verified SAP text extension is configured.

- [ ] **Step 1: 写出安全文档与写入开关回归测试**

```ts
test("does not submit an order when the write gate is disabled", async () => {
  const { app, calls } = makeStorefrontApp({ writeEnabled: false });
  const agent = await registeredAgent({ app });
  const response = await agent.post("/api/orders/submit").send({
    confirm: true, items: [{ product: "1386", quantity: 1 }], requestedDeliveryDate: "2026-08-01",
  }).expect(400);
  assert.match(response.body.error, /writes are disabled/);
  assert.equal(calls.write, 0);
});
```

- [ ] **Step 2: 运行测试并确认失败或暴露缺口**

Run: `npm test -- --test-name-pattern='does not submit an order when the write gate is disabled'`

Expected: PASS after Task 2; if it fails, stop and restore the `assertWriteAllowed` check before documentation work.

- [ ] **Step 3: 更新本地启动和功能说明**

Add a “客户商城” README section that documents `npm install`, `npm run build`, protected environment loading, `NODE_ENV=development VERIFICATION_DELIVERY=log npm run start:web`, and `http://localhost:3000`. Explain the effective-price rule, default page size, group navigation, server-side re-pricing, customer PO mapping, requested delivery-date mapping, and the limitation on free-text SAP persistence. Do not include credentials, certificates, OTP values, or a command that disables TLS in production.

Keep the existing `.env.example` entry for `SAP_WRITE_ENABLED=false`, and add a comment that 20 is the browser’s initial catalog page size while the server accepts only 1–50.

- [ ] **Step 4: 运行完整自动化验证、配置校验和开发手工冒烟测试**

Run: `npm test && npm run build && npm run check-config`

Expected: all tests and build pass; `check-config` succeeds only when required values are loaded from the protected environment file.

Then run:

```bash
NODE_ENV=development VERIFICATION_DELIVERY=log npm run start:web
```

Verify manually in a browser: login, customer summary, first catalog page, material-group filter, search, quantity controls, checkout summary, cancellation, and the disabled-write error. Do not submit a live SAP order during this smoke test.

- [ ] **Step 5: 提交文档与验证测试**

```bash
git add README.md .env.example test/portal-app.test.ts
git commit -m '[AI-IMP]客户商城运行说明'
git push origin session/d1f90d2aa648
```

## Self-Review

- Spec coverage: Task 1 implements A305/ZR01 effective-price aggregation, product descriptions, material groups, search, sorting and server-side pagination. Task 2 supplies session-protected catalog/customer routes and checkout field validation. Task 3 implements the approved three-column storefront, material-number visual treatment, cart and confirmation flow. Task 4 covers local operations, safety gates and smoke validation.
- Placeholder scan: no `TODO`, `TBD`, “similar to”, or unspecified test tasks remain; every task has explicit commands, expected outcome, files and public interfaces.
- Type consistency: `CatalogQuery`/`CatalogPage` originate in Task 1 and are consumed unchanged in Task 2. Browser query keys map to Task 2’s route keys. Browser checkout keys map to the Task 2 schema fields after route normalization: `requestedDeliveryDate` → `requested_delivery_date`, `purchaseOrderByCustomer` → `purchase_order_by_customer`, `note` → `portal_note`.

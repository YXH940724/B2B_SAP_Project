# 商城订单唯一标识 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为商城提交生成可重试的商城订单号，将销售范围子单号写入 SAP `PurchaseOrderByShipToParty`，并在创建结果与订单中心展示和检索它。

**Architecture:** 复用现有 SQLite 门户数据库，在 `AuthStore` 上新增商城母单/子单持久化接口；提交接口先持久化子单状态，再将子单号写入 SAP。若创建请求响应丢失或用户重试，服务先按子单号查询 SAP，再决定是否需要创建，避免重复订单。订单历史读取 SAP 抬头中的商城子单号，并在本地状态存在时用本地记录补充该标识。

**Tech Stack:** TypeScript、Express 5、Zod、better-sqlite3、Axios SAP OData、Node test、Supertest、原生 HTML/CSS/JavaScript。

## Global Constraints

- 商城母单号固定为 `MALL-YYYYMMDD-XXXXXXXX`，八位后缀为大写十六进制随机值。
- 每个销售范围子单必须使用母单号加两位序号，例如 `MALL-20260721-1A2B3C4D-01`；序号按销售范围键排序后确定。
- SAP 抬头仅使用 `PurchaseOrderByShipToParty` 保存商城子单号；不得覆盖用户输入的 `PurchaseOrderByCustomer`。
- 同一客户、同一商城子单号重试必须先回查 SAP，不得重复创建 SAP 销售订单。
- 写 SAP 仍须遵守 `SAP_WRITE_ENABLED` 和确认动作；不得记录、返回或打印 SAP 凭据、Cookie、CSRF Token。
- 未成功的销售范围不得阻塞其他销售范围；母单结果须逐子单报告成功、失败与 SAP 销售订单号。
- 所有持久化时间使用 Unix 毫秒；所有 SAP 订单号在本地保留 SAP 原始十位格式。

---

## File Structure

- `src/auth-store.ts`：同一 SQLite 文件中的商城母单/子单表、事务写入及状态查询，避免新增第二个数据库连接。
- `src/mall-orders.ts`：商城订单号格式、稳定子单拆分、提交状态机与 SAP 回查/创建编排。
- `src/sales-orders.ts`：将内部商城子单字段映射到 SAP 深插入 payload，并提供按该字段的安全 OData 回查。
- `src/portal-app.ts`：将预览编号回传给浏览器；提交时调用商城订单编排器；对外返回结构化子单结果。
- `src/web-server.ts`：创建一个共享 SQLite store，并注入认证服务、商城订单编排器和订单历史服务。
- `src/order-history.ts`：读取 `PurchaseOrderByShipToParty`，让关键词检索与订单详情携带商城子单号。
- `public/index.html`、`public/app.js`、`public/styles.css`：确认页、提交结果、订单中心、明细与打印预览中展示商城订单号。
- `test/auth-store.test.ts`、`test/mall-orders.test.ts`、`test/sales-orders.test.ts`、`test/order-history.test.ts`、`test/portal-app.test.ts`：覆盖持久化、幂等、SAP payload、查询映射及 HTTP/UI 契约。

### Task 1: SQLite 商城订单持久化

**Files:**
- Modify: `src/auth-store.ts:4-90`
- Create: `test/auth-store.test.ts`

**Interfaces:**
- Produces `MallOrderStatus`, `MallOrderRecord`, `MallOrderChildRecord` 与 `MallOrderStore`。
- Produces `AuthStore.reserveMallOrder(customer, id, now): MallOrderRecord`、`createMallOrder(order, children): MallOrderRecord`、`getMallOrder(customer, id)`、`getMallOrderChild(id)`、`markMallOrderChildSubmitting(id, now)`、`markMallOrderChildSubmitted(id, sapOrder, now)`、`markMallOrderChildFailed(id, reason, now)`。
- Later tasks consume子单状态、销售范围和请求摘要，不直接操作 SQL。

- [ ] **Step 1: Write the failing store tests**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { createAuthStore } from "../src/auth-store.js";

test("persists one mall parent order and two sales-area children atomically", () => {
  const store = createAuthStore(":memory:");
  store.createMallOrder({ id: "MALL-20260721-ABCDEF12", customer: "0000100001", now: 1 }, [
    { id: "MALL-20260721-ABCDEF12-01", salesArea: "1310/10/00", requestJson: "{}" },
    { id: "MALL-20260721-ABCDEF12-02", salesArea: "2000/10/00", requestJson: "{}" },
  ]);
  const order = store.getMallOrder("0000100001", "MALL-20260721-ABCDEF12");
  assert.deepEqual(order?.children.map((child) => [child.id, child.status, child.salesArea]), [
    ["MALL-20260721-ABCDEF12-01", "PENDING", "1310/10/00"],
    ["MALL-20260721-ABCDEF12-02", "PENDING", "2000/10/00"],
  ]);
});

test("keeps completed SAP order number when a child is loaded again", () => {
  const store = createAuthStore(":memory:");
  store.createMallOrder({ id: "MALL-20260721-ABCDEF12", customer: "0000100001", now: 1 }, [{ id: "MALL-20260721-ABCDEF12-01", salesArea: "1310/10/00", requestJson: "{}" }]);
  store.markMallOrderChildSubmitted("MALL-20260721-ABCDEF12-01", "0000001394", 2);
  assert.equal(store.getMallOrderChild("MALL-20260721-ABCDEF12-01")?.sapSalesOrder, "0000001394");
});

test("reserves a marketplace parent ID only once", () => {
  const store = createAuthStore(":memory:");
  store.reserveMallOrder("0000100001", "MALL-20260721-ABCDEF12", 1);
  assert.throws(() => store.reserveMallOrder("0000100001", "MALL-20260721-ABCDEF12", 2), /已存在/);
});
```

- [ ] **Step 2: Run the store tests to verify they fail**

Run: `npm test -- test/auth-store.test.ts`

Expected: FAIL because `createMallOrder` and related methods do not exist.

- [ ] **Step 3: Add tables, types, and transactional store methods**

Add the following public types near `VerificationRecord`, then extend `AuthStore` with their methods:

```ts
export type MallOrderStatus = "PENDING" | "SUBMITTING" | "SUBMITTED" | "FAILED";

export type MallOrderChildRecord = {
  id: string; mallOrderId: string; salesArea: string; status: MallOrderStatus;
  sapSalesOrder: string | null; requestJson: string; failureReason: string | null;
  createdAt: number; updatedAt: number;
};
export type MallOrderRecord = {
  id: string; customer: string; createdAt: number; updatedAt: number; children: MallOrderChildRecord[];
};
export type NewMallOrderChild = Pick<MallOrderChildRecord, "id" | "salesArea" | "requestJson">;
```

Create these schema objects in the existing `database.exec` statement and use a `database.transaction` for the parent plus all child rows:

```sql
CREATE TABLE IF NOT EXISTS mall_orders (
  id TEXT PRIMARY KEY, customer TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mall_order_children (
  id TEXT PRIMARY KEY, mall_order_id TEXT NOT NULL REFERENCES mall_orders(id),
  sales_area TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('PENDING','SUBMITTING','SUBMITTED','FAILED')),
  sap_sales_order TEXT, request_json TEXT NOT NULL, failure_reason TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE(mall_order_id, sales_area)
);
CREATE INDEX IF NOT EXISTS idx_mall_orders_customer ON mall_orders(customer, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mall_order_children_sap ON mall_order_children(sap_sales_order);
```

`reserveMallOrder` must insert only the parent and fail on an existing parent ID, allowing the generator to retry with a new random suffix. `createMallOrder` must first load the reserved parent by `(id, customer)` and return it unchanged when exactly the same child rows already exist; otherwise it inserts all children inside one transaction. State transitions must only update the named child and its `updated_at`; `markMallOrderChildSubmitted` must clear `failure_reason`.

- [ ] **Step 4: Run the store tests to verify they pass**

Run: `npm test -- test/auth-store.test.ts`

Expected: PASS with two passing tests.

- [ ] **Step 5: Commit the persistence layer**

```bash
git add src/auth-store.ts test/auth-store.test.ts
git commit -m '[AI-ADD]商城订单持久化'
```

### Task 2: 编号、SAP payload 与幂等创建编排

**Files:**
- Create: `src/mall-orders.ts`
- Modify: `src/sales-orders.ts:16-108`
- Modify: `test/sales-orders.test.ts:24-76`
- Create: `test/mall-orders.test.ts`

**Interfaces:**
- Consumes `MallOrderStore` from Task 1 and `SapODataClient`.
- Produces `generateMallOrderId(now, randomBytes)`, `buildMallOrderChildren(parentId, groups)`, `MallOrderSubmissionService.prepare(customer, groups)`, and `MallOrderSubmissionService.submit(input)`.
- Produces `findSalesOrderByShipToParty(client, customer, childId): Promise<string | undefined>`.
- `MallOrderSubmissionService.submit` returns `{ mallOrderId: string; groups: MallOrderSubmissionGroup[] }`, where each group has `childOrderId`, `salesArea`, `status`, `salesOrder?`, `error?`.

- [ ] **Step 1: Write failing payload and service tests**

```ts
test("writes the marketplace child ID to the SAP ship-to purchase reference", () => {
  const payload = createPayload({
    sales_order_type: "OR", sales_organization: "1310", distribution_channel: "10", organization_division: "00", sold_to_party: "0000100001",
    purchase_order_by_ship_to_party: "MALL-20260721-ABCDEF12-01",
    items: [{ material: "361", requested_quantity: 1, requested_quantity_unit: "PC" }], dry_run: false, response_format: "json",
  });
  assert.equal(payload.PurchaseOrderByShipToParty, "MALL-20260721-ABCDEF12-01");
});

test("does not call SAP POST again when the local child was already submitted", async () => {
  const writes: unknown[] = [];
  const service = makeMallOrderService({
    get: async () => { throw new Error("should not look up completed child"); },
    write: async (_method, _path, payload) => { writes.push(payload); return { data: { SalesOrder: "0000001394" } }; },
  });
  service.store.createMallOrder({ id: "MALL-20260721-ABCDEF12", customer: "0000100001", now: 1 }, [{ id: "MALL-20260721-ABCDEF12-01", salesArea: "1310/10/00", requestJson: JSON.stringify(makeGroup()) }]);
  service.store.markMallOrderChildSubmitted("MALL-20260721-ABCDEF12-01", "0000001394", 2);
  const result = await service.submit(makeSubmission("MALL-20260721-ABCDEF12"));
  assert.equal(result.groups[0].salesOrder, "0000001394");
  assert.equal(writes.length, 0);
});

test("recovers a lost create response by finding the child ID in SAP before retrying POST", async () => {
  const writes: unknown[] = [];
  const service = makeMallOrderService({
    get: async () => ({ data: { d: { results: [{ SalesOrder: "0000001394" }] } } }),
    write: async (_method, _path, payload) => { writes.push(payload); throw new Error("POST must not run"); },
  });
  const result = await service.submit(makeSubmission("MALL-20260721-ABCDEF12"));
  assert.equal(result.groups[0].salesOrder, "0000001394");
  assert.equal(writes.length, 0);
});
```

- [ ] **Step 2: Run the focused tests to verify they fail**

Run: `npm test -- test/sales-orders.test.ts test/mall-orders.test.ts`

Expected: FAIL because the internal `purchase_order_by_ship_to_party` field and `MallOrderSubmissionService` do not exist.

- [ ] **Step 3: Implement a single explicit SAP child-ID mapping and lookup**

In `CreateSalesOrderSchema`, add a private/internal optional field and map only that field:

```ts
purchase_order_by_ship_to_party: z.string().trim().regex(/^MALL-\d{8}-[A-F0-9]{8}-\d{2}$/).optional(),
```

```ts
...(input.purchase_order_by_ship_to_party
  ? { PurchaseOrderByShipToParty: input.purchase_order_by_ship_to_party }
  : {}),
```

Add a local literal escaper and SAP lookup that chooses the first exact row and returns no order when there is no row:

```ts
const odataLiteral = (value: string): string => value.replace(/'/g, "''");

export async function findSalesOrderByShipToParty(client: SapODataClient, customer: string, childOrderId: string): Promise<string | undefined> {
  const response = await client.get<unknown>("/A_SalesOrder", {
    "$select": "SalesOrder,PurchaseOrderByShipToParty,SoldToParty",
    "$filter": `SoldToParty eq '${odataLiteral(customer)}' and PurchaseOrderByShipToParty eq '${odataLiteral(childOrderId)}'`,
    "$top": 1,
  });
  const payload = response.data as { d?: { results?: Array<{ SalesOrder?: unknown }> }; value?: Array<{ SalesOrder?: unknown }> };
  const row = payload.d?.results?.[0] ?? payload.value?.[0];
  return typeof row?.SalesOrder === "string" && row.SalesOrder ? row.SalesOrder : undefined;
}
```

- [ ] **Step 4: Implement the deterministic child plan and state machine in `src/mall-orders.ts`**

Use `crypto.randomBytes(4).toString("hex").toUpperCase()` in production and inject `randomBytes`/`now` for tests:

```ts
export function generateMallOrderId(now = new Date(), randomBytes = crypto.randomBytes(4)): string {
  const date = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, "0")}${String(now.getUTCDate()).padStart(2, "0")}`;
  return `MALL-${date}-${randomBytes.toString("hex").toUpperCase()}`;
}

export function buildMallOrderChildren(parentId: string, groups: MallOrderGroup[]): MallOrderChildPlan[] {
  return [...groups].sort((a, b) => a.salesArea.key.localeCompare(b.salesArea.key)).map((group, index) => ({
    id: `${parentId}-${String(index + 1).padStart(2, "0")}`, group,
  }));
}
```

`prepare(customer, groups)` must try at most ten generated IDs. For each candidate it calls `store.reserveMallOrder(customer, candidate, now())`; on a primary-key collision it generates another ID, and on success it returns `{ mallOrderId: candidate, groups: buildMallOrderChildren(candidate, groups).map(({ id, group }) => ({ childOrderId: id, salesArea: group.salesArea })) }`. This database reservation, rather than random chance alone, makes each returned parent ID unique.

For each child in `submit`: return a stored `SUBMITTED` order immediately; otherwise mark it `SUBMITTING`, call `findSalesOrderByShipToParty`, create via `/A_SalesOrder` only when lookup returns no sales order, normalize the returned `SalesOrder`, and mark the child `SUBMITTED`. Catch a create error, perform exactly one lookup; if that lookup finds an order mark it submitted, otherwise mark it failed and return only a sanitized error message. Use `Promise.all` so one range failure does not stop the rest.

- [ ] **Step 5: Run the payload and service tests to verify they pass**

Run: `npm test -- test/sales-orders.test.ts test/mall-orders.test.ts`

Expected: PASS, including no duplicate POST and response-loss recovery cases.

- [ ] **Step 6: Commit the SAP idempotency layer**

```bash
git add src/sales-orders.ts src/mall-orders.ts test/sales-orders.test.ts test/mall-orders.test.ts
git commit -m '[AI-ADD]商城订单幂等创建'
```

### Task 3: 门户 HTTP 编排与配置注入

**Files:**
- Modify: `src/portal-app.ts:15-34,143-171,381-428`
- Modify: `src/web-server.ts:16-38`
- Modify: `test/portal-app.test.ts:18-96,211-250`

**Interfaces:**
- Consumes `MallOrderSubmissionService` from Task 2 as `PortalDependencies.mallOrders`.
- Produces `POST /api/orders/preview` with `{ mallOrderId, groups: [{ salesArea, childOrderId, items, totalsByCurrency }], checkout }` and `POST /api/orders/submit` with `{ mallOrderId, ...checkout, items, confirm: true }`.
- Produces results with `childOrderId`, `status`, optional `salesOrder`, and no SAP session data.

- [ ] **Step 1: Write failing portal contract tests**

```ts
test("returns one generated marketplace order ID in preview and sends it unchanged during submit", async () => {
  const calls: unknown[] = [];
  const storefront = makeStorefrontApp({ mallOrders: {
    prepare: () => ({ mallOrderId: "MALL-20260721-ABCDEF12", groups: [{ childOrderId: "MALL-20260721-ABCDEF12-01", salesArea: makeArea() }] }),
    submit: async (input) => { calls.push(input); return { mallOrderId: input.mallOrderId, groups: [{ childOrderId: "MALL-20260721-ABCDEF12-01", salesArea: makeArea(), status: "SUBMITTED", salesOrder: "0000001394" }] }; },
  } });
  const agent = await registeredAgent(() => storefront);
  const preview = await agent.post("/api/orders/preview").send(validCheckout()).expect(200);
  assert.equal(preview.body.mallOrderId, "MALL-20260721-ABCDEF12");
  const submitted = await agent.post("/api/orders/submit").send({ ...validCheckout(), mallOrderId: preview.body.mallOrderId, confirm: true }).expect(200);
  assert.equal(submitted.body.groups[0].childOrderId, "MALL-20260721-ABCDEF12-01");
  assert.equal((calls[0] as { customer: string }).customer, "0000100001");
});

test("rejects a submit without the preview marketplace order ID", async () => {
  const agent = await registeredAgent(makeStorefrontApp);
  const response = await agent.post("/api/orders/submit").send({ ...validCheckout(), confirm: true }).expect(400);
  assert.match(response.body.error, /商城订单号/);
});
```

- [ ] **Step 2: Run the portal contract tests to verify they fail**

Run: `npm test -- test/portal-app.test.ts`

Expected: FAIL because preview does not contain `mallOrderId` and no `mallOrders` dependency exists.

- [ ] **Step 3: Inject the service once and keep all ownership checks at the route boundary**

Add this dependency without exposing the SQLite store directly to HTTP handlers:

```ts
mallOrders?: {
  prepare(customer: string, groups: PortalCartGroup[]): { mallOrderId: string; groups: Array<{ childOrderId: string; salesArea: SalesArea }> };
  submit(input: MallOrderSubmissionInput): Promise<MallOrderSubmissionResult>;
};
```

Add `mallOrderDependencies()` mirroring the existing dependency guards. In `/api/orders/preview`, select cart groups once, price them, call `mallOrderDependencies().prepare(customer, groups)`, and merge each prepared `childOrderId` into its matching priced group by `salesArea.key`. Return this enriched group array and `mallOrderId`. In `/api/orders/submit`, validate `mallOrderId` against `/^MALL-\d{8}-[A-F0-9]{8}$/`, derive `customer` solely from `session(req)`, price/select groups as before, then pass the normalized `customer`, generated group payloads, checkout fields, and `mallOrderId` to `mallOrders.submit`. Do not call `client.write` directly in this route after this change.

In `createConfiguredPortalApp`, construct one store only:

```ts
const store = createAuthStore(process.env.PORTAL_DB_PATH ?? "data/portal.db");
const auth = options.auth ?? new AuthService(store);
const mallOrders = new MallOrderSubmissionService(store, client, config);
```

Pass `auth` and `mallOrders` to `createPortalApp`. Preserve the supplied `options.auth` behavior in tests: when it is supplied, construct a separate store only for `mallOrders` using the configured database path, so production still shares one store and tests remain isolated.

- [ ] **Step 4: Run portal tests to verify they pass**

Run: `npm test -- test/portal-app.test.ts`

Expected: PASS, including session ownership, preview ID, required ID, and returned child result assertions.

- [ ] **Step 5: Commit HTTP orchestration**

```bash
git add src/portal-app.ts src/web-server.ts test/portal-app.test.ts
git commit -m '[AI-ADD]商城订单提交编排'
```

### Task 4: 订单历史中的商城号读取与检索

**Files:**
- Modify: `src/order-history.ts:26-92,232-267,399-448`
- Modify: `test/order-history.test.ts`
- Modify: `test/portal-app.test.ts:45-94,250-290`

**Interfaces:**
- Produces `OrderSummary.mallOrderChildId: string | null` and `OrderDetail.header.mallOrderChildId`.
- Consumes SAP field `PurchaseOrderByShipToParty`; does not trust a browser-supplied customer.
- `GET /api/orders/history?query=MALL-...` matches SAP sales order, customer PO, or marketplace child ID.

- [ ] **Step 1: Write failing order-history mapping tests**

```ts
test("maps marketplace child ID from SAP and accepts it as an order search keyword", async () => {
  const service = new OrderHistoryService(fakeClient([{ SalesOrder: "0000001394", SoldToParty: "0000100001", PurchaseOrderByShipToParty: "MALL-20260721-ABCDEF12-01", CreationDate: "2026-07-21", TotalNetAmount: "1", TransactionCurrency: "CNY" }]));
  const data = await service.list("100001", { query: "MALL-20260721-ABCDEF12-01" });
  assert.equal(data.total, 1);
  assert.equal(data.items[0].mallOrderChildId, "MALL-20260721-ABCDEF12-01");
});
```

- [ ] **Step 2: Run the order-history tests to verify they fail**

Run: `npm test -- test/order-history.test.ts`

Expected: FAIL because the SAP select list and summary model omit `PurchaseOrderByShipToParty`.

- [ ] **Step 3: Add the field to all header read paths and query matching**

Add `PurchaseOrderByShipToParty` to the `/A_SalesOrder` list `$select` and to `src/sales-orders.ts` `getSalesOrder` select. Extend the types and mappers:

```ts
mallOrderChildId: optionalText(row.PurchaseOrderByShipToParty),
```

Use the full three-value search haystack:

```ts
const haystack = `${order.salesOrder} ${order.purchaseOrderByCustomer ?? ""} ${order.mallOrderChildId ?? ""}`.toLowerCase();
```

For order details, map the same SAP header field in `toDetailHeader`, so the browser sees it even for orders created outside this portal. Keep the existing customer ownership check before returning detail.

- [ ] **Step 4: Run the order-history and route tests to verify they pass**

Run: `npm test -- test/order-history.test.ts test/portal-app.test.ts`

Expected: PASS, including marketplace child-ID keyword search and API response field assertions.

- [ ] **Step 5: Commit order history support**

```bash
git add src/order-history.ts src/sales-orders.ts test/order-history.test.ts test/portal-app.test.ts
git commit -m '[AI-IMP]订单中心商城单号查询'
```

### Task 5: 商城编号的确认、结果、详情和打印界面

**Files:**
- Modify: `public/index.html:122-160`
- Modify: `public/app.js:360-790`
- Modify: `public/styles.css` near dialog/table/print selectors
- Modify: `test/portal-app.test.ts:270-350`

**Interfaces:**
- Consumes preview `{ mallOrderId, groups }`, submit `{ mallOrderId, groups: [{ childOrderId, status, salesOrder?, error? }] }`, and order history `mallOrderChildId`.
- Produces a confirmation view that preserves the preview ID through submit, a per-range result dialog, a `商城订单号` order-list column/search hint, and IDs in detail/print.

- [ ] **Step 1: Write failing static UI contract tests**

```ts
test("serves marketplace order identifiers in confirmation, result, history detail and print UI", () => {
  const html = fs.readFileSync(path.resolve(import.meta.dirname, "../public/index.html"), "utf8");
  const script = fs.readFileSync(path.resolve(import.meta.dirname, "../public/app.js"), "utf8");
  assert.match(html, /id="order-result-dialog"/);
  assert.match(html, /商城订单号/);
  assert.match(script, /mallOrderId/);
  assert.match(script, /childOrderId/);
  assert.match(script, /mallOrderChildId/);
});
```

- [ ] **Step 2: Run the static UI contract tests to verify they fail**

Run: `npm test -- test/portal-app.test.ts`

Expected: FAIL because no result dialog or marketplace-order rendering exists.

- [ ] **Step 3: Implement the UI without clearing the cart**

Add `<dialog id="order-result-dialog">` with a title, `#order-result-summary`, a close button, and a link/button to open the order center. In `renderPreview`, prepend the merchant parent ID and render each predicted child ID using the same stable group order returned by the API. Keep the exact `lastPreview.mallOrderId` in `checkoutPayload()` as `mallOrderId` only for submit; do not let a user edit it.

Replace the current one-line submit notification with `renderOrderResult(data)`: show the mother ID once, then one card per sales range containing the child ID, a success/failed badge, SAP sales order number when present, and safe server error text when failed. Retain `cart` after both full and partial success, as explicitly required.

Add `商城订单号` to the order table before SAP order number; update the search placeholder to `SAP 订单号、商城订单号或客户采购订单号`. Add `["商城订单号", header.mallOrderChildId]` to detail fields and print metadata. Use `unmaintained` for all values and the existing `statusBadge` helper; no `innerHTML` may interpolate an API value.

Add CSS for `.mall-order-id` (monospace, wrapping allowed), `.order-result-list`, `.order-result-card`, and `@media print` so both identifiers remain visible in printed output. Reuse the existing navy/blue palette and dialog spacing; do not add a third-party UI library.

- [ ] **Step 4: Run UI contract tests, build, and full test suite**

Run: `npm test -- test/portal-app.test.ts && npm run build && npm test`

Expected: all commands exit 0.

- [ ] **Step 5: Manually verify the end-to-end browser flow**

Run: `PORTAL_DB_PATH=/tmp/mall-order-portal.db npm run start:web`

Verify in a browser with a non-production SAP test setup:

1. Add items belonging to two sales ranges and open checkout.
2. Confirm the dialog contains `MALL-YYYYMMDD-XXXXXXXX` plus two `-01`/`-02` child IDs.
3. Submit once, then submit the same captured request again; verify each child has only one SAP order and the same SAP order number is returned.
4. Search the order center by a child ID and confirm the ID appears in table, detail dialog, and print preview.
5. Stop the server and remove `/tmp/mall-order-portal.db`.

- [ ] **Step 6: Commit the interface**

```bash
git add public/index.html public/app.js public/styles.css test/portal-app.test.ts
git commit -m '[AI-IMP]商城订单号展示'
```

### Task 6: Integration verification and branch handoff

**Files:**
- Modify: `docs/superpowers/specs/2026-07-21-mall-order-identifier-design.md` only if an implementation decision differs from the approved design.

**Interfaces:**
- Consumes all prior tasks.
- Produces a verified branch that is ready for code review and merge; no untracked scratch files are staged.

- [ ] **Step 1: Verify formatting, typecheck, and all tests**

Run: `git diff --check && npm run build && npm test`

Expected: all commands exit 0.

- [ ] **Step 2: Perform SAP test-environment read verification without exposing credentials**

Run the existing application/client configuration against the configured test environment to verify that the selected `PurchaseOrderByShipToParty` field is readable and that an authenticated CSRF request can be prepared. Do not create an order in this step; order creation requires a separate explicit user confirmation for the specific business data.

Expected: field is present in the response or a precise SAP/OData error is captured without secrets.

- [ ] **Step 3: Review the exact staged diff and commit only tracked product changes**

Run: `git status --short && git diff --check && git log --oneline -6`

Expected: no `.superpowers/` scratch files or local databases are staged; commits use the required `[AI-*]` convention.

- [ ] **Step 4: Push the isolated branch**

```bash
git push origin session/d1f90d2aa648
```

Expected: remote branch advances successfully.

- [ ] **Step 5: Request review before merging to main**

Provide the commit range, test commands/results, SAP read verification result, and any SAP write test still awaiting explicit business confirmation. Do not merge to `main` until the user explicitly asks to merge.

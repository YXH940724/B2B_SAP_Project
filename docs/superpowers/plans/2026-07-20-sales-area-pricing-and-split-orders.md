# 销售范围定价与拆分订单 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 依据 SAP 客户销售范围过滤 A305/ZR01 可售物料，并按销售组织、分销渠道和产品组拆分、提交及重试客户订单。

**Architecture:** 新增独立的销售范围服务和提交组仓储；目录服务的输入从单一物料过滤扩展为客户加销售范围。门户前端维护带销售范围的购物车，服务端预览、重新定价并依次提交每个范围组，持久化结果防止重复创建订单。

**Tech Stack:** TypeScript、Express 5、better-sqlite3、Axios、Zod、Node test runner、Supertest、原生浏览器 JavaScript。

## Global Constraints

- 仅在 `/tmp/wt-d1f90d2aa648` 的 `session/d1f90d2aa648` 分支编辑；每阶段测试、提交、推送。
- 销售范围键固定为 `salesOrganization/distributionChannel/division`；不同键必须拆为不同 SAP 销售订单。
- 目录价格必须匹配当前会话客户、销售范围、`ZR01`、A305、有效期、未删除和正金额。
- 不得向浏览器暴露 SAP 凭据、服务 URL、客户邮箱或让客户端指定其他客户号。
- 实际 SAP POST 仍同时要求二次确认和 `SAP_WRITE_ENABLED=true`。
- 写入失败不自动重试；只有客户显式操作失败销售范围组才允许重试。

---

### Task 1: 建立销售范围读取与精确价格匹配服务

**Files:**
- Create: `src/sales-areas.ts`
- Modify: `src/catalog.ts`
- Modify: `src/customer-contact.ts`
- Test: `test/sales-areas.test.ts`, `test/catalog.test.ts`

**Interfaces:**
- Produces `SalesArea { salesOrganization, distributionChannel, division, key }` and `listCustomerSalesAreas(client, config, customer)`.
- Changes `CatalogService.list(customer: string, salesArea: SalesArea, query: CatalogQuery)` and `getOffer(customer, salesArea, product)`.

- [ ] **Step 1: 写失败测试**

```ts
test("returns sorted customer sales areas", async () => {
  const areas = await listCustomerSalesAreas(client as never, config, "100001");
  assert.deepEqual(areas, [{ salesOrganization: "1000", distributionChannel: "10", division: "00", key: "1000/10/00" }]);
});

test("keeps only a customer and sales-area matched A305 price", async () => {
  const page = await catalog.list("0000100001", area("1000", "10", "00"), { page: 1, pageSize: 20, sort: "material" });
  assert.deepEqual(page.items.map((item) => item.product), ["000000000000001386"]);
});
```

- [ ] **Step 2: 验证测试失败**

Run: `npm test -- --test-name-pattern='sorted customer sales areas|customer and sales-area matched'`

Expected: FAIL because `sales-areas.ts` and the new catalog signature do not exist.

- [ ] **Step 3: 实现只读销售范围与元数据字段适配**

```ts
export interface SalesArea { salesOrganization: string; distributionChannel: string; division: string; key: string; }
export function salesAreaKey(area: Omit<SalesArea, "key">): string { return `${area.salesOrganization}/${area.distributionChannel}/${area.division}`; }
export async function listCustomerSalesAreas(client: SapODataClient, config: SapConfig, customer: string): Promise<SalesArea[]> {
  const response = await client.getAt<{ results?: Array<{ SalesOrganization?: string; DistributionChannel?: string; Division?: string }> }>(config.services.businessPartner, "/A_CustomerSalesArea", { "$filter": `Customer eq '${odataKey(normalizeCustomer(customer))}'`, "$select": "SalesOrganization,DistributionChannel,Division", "$top": 100 });
  return (response.data.results ?? []).map(toSalesArea).filter(isSalesArea).sort((a, b) => a.key.localeCompare(b.key));
}
```

Before production deployment, issue one read-only `$metadata` request and add the confirmed A305 customer/sales-area property names to `PriceValidity`; filter exact values before choosing the newest valid record. Return an empty page when no price matches; never fall back to an unscoped price.

- [ ] **Step 4: 验证与提交**

Run: `npm test && npm run build`

```bash
git add src/sales-areas.ts src/catalog.ts src/customer-contact.ts test/sales-areas.test.ts test/catalog.test.ts
git commit -m '[AI-ADD]客户销售范围定价'
git push origin session/d1f90d2aa648
```

### Task 2: 增加提交组持久化与多销售范围订单服务

**Files:**
- Create: `src/order-submissions.ts`
- Modify: `src/auth-store.ts`
- Modify: `src/sales-orders.ts`
- Test: `test/order-submissions.test.ts`, `test/sales-orders.test.ts`

**Interfaces:**
- Produces `SubmissionGroup { id, customer, salesArea, fingerprint, status, salesOrder?, error? }` and `OrderSubmissionService.preview/submit/retry`.
- Consumes re-priced catalog offers and returns `OrderGroupResult[]` with `success | failed | processing` status.

- [ ] **Step 1: 写失败测试**

```ts
test("does not post an already successful sales-area group twice", async () => {
  const first = await submissions.submit(customer, [line(area1000)], true);
  const second = await submissions.submit(customer, [line(area1000)], true);
  assert.equal(writeCalls, 1);
  assert.equal(second[0].salesOrder, first[0].salesOrder);
});

test("continues with the next sales area when the first group fails", async () => {
  const result = await submissions.submit(customer, [line(area1000), line(area2000)], true);
  assert.equal(result[0].status, "failed");
  assert.equal(result[1].status, "success");
});
```

- [ ] **Step 2: 验证测试失败**

Run: `npm test -- --test-name-pattern='already successful|next sales area'`

Expected: FAIL because submission storage and service do not exist.

- [ ] **Step 3: 实现 SQLite 状态与每组 SAP 负载**

Create `portal_order_submissions` with `id`, `customer`, `sales_area_key`, `fingerprint`, `status`, `sales_order`, `error_summary`, `created_at`, `updated_at`; enforce unique `(customer, sales_area_key, fingerprint)`. SHA-256 the canonical sorted item list plus checkout fields for `fingerprint`. For each group, call `assertWriteAllowed`, construct `createPayload` with that group’s `salesOrganization`, `distributionChannel`, `division`, and POST only when no successful record exists. Persist success before returning; on caught error persist sanitized failure and continue to the next group.

- [ ] **Step 4: 验证与提交**

Run: `npm test && npm run build`

```bash
git add src/order-submissions.ts src/auth-store.ts src/sales-orders.ts test/order-submissions.test.ts test/sales-orders.test.ts
git commit -m '[AI-ADD]销售范围拆单服务'
git push origin session/d1f90d2aa648
```

### Task 3: 暴露销售范围、目录和拆单 HTTP 合同

**Files:**
- Modify: `src/portal-app.ts`
- Modify: `src/web-server.ts`
- Test: `test/portal-app.test.ts`, `test/web-server.test.ts`

**Interfaces:**
- Produces `GET /api/sales-areas`, sales-area-required `GET /api/catalog`, grouped `POST /api/orders/preview`, `POST /api/orders/submit`, and `POST /api/orders/retry/:submissionGroupId`.

- [ ] **Step 1: 写失败 HTTP 测试**

```ts
test("returns only the logged-in customer's sales areas and requires a valid area for catalog", async () => {
  await agent.get("/api/sales-areas").expect(200).expect(({ body }) => assert.equal(body[0].key, "1000/10/00"));
  await agent.get("/api/catalog?salesOrganization=9999&distributionChannel=10&division=00").expect(400);
});

test("returns independent submit results for two sales areas", async () => {
  const response = await agent.post("/api/orders/submit").send({ confirm: true, items: [item("1000/10/00"), item("2000/10/00")] }).expect(200);
  assert.deepEqual(response.body.results.map((row) => row.status), ["failed", "success"]);
});
```

- [ ] **Step 2: 验证失败并实现最小路由**

Run: `npm test -- --test-name-pattern='logged-in.*sales areas|independent submit'`

Implement a `salesAreaFromQuery` parser that accepts exactly three nonempty string fields and verifies the requested key belongs to the session customer before catalog or preview. Wire configured `SalesAreaService` and `OrderSubmissionService` in `createConfiguredPortalApp`. Convert all item sales-area fields to server-side `SalesArea` objects; reject any foreign or malformed group before SAP calls.

- [ ] **Step 3: 验证与提交**

Run: `npm test && npm run build`

```bash
git add src/portal-app.ts src/web-server.ts test/portal-app.test.ts test/web-server.test.ts
git commit -m '[AI-ADD]销售范围商城接口'
git push origin session/d1f90d2aa648
```

### Task 4: 更新商城界面与运行说明

**Files:**
- Modify: `public/index.html`, `public/app.js`, `public/styles.css`, `README.md`
- Test: `test/portal-app.test.ts`

- [ ] **Step 1: 写失败静态合同测试**

```ts
test("serves a sales-area switcher and grouped cart result controls", () => {
  const html = fs.readFileSync(path.resolve(import.meta.dirname, "../public/index.html"), "utf8");
  assert.match(html, /id="sales-area-select"/);
  assert.match(html, /id="sales-area-cart-groups"/);
  assert.match(html, /id="submission-results"/);
});
```

- [ ] **Step 2: 验证失败并实现界面**

Run: `npm test -- --test-name-pattern='sales-area switcher'`

Add a top `#sales-area-select`; load `/api/sales-areas` after login, set the first area, then call `loadCatalog` with the three area fields. Stamp the selected area onto every added cart item, render cart sections by `area.key`, send all stamped lines to preview/submit, and render each result with SAP order number or a retry button that calls the retry endpoint. Preserve the existing second confirmation dialog and clear only successful groups.

- [ ] **Step 3: 全量验证、浏览器冒烟与提交**

Run: `npm test && npm run build`

Use the local fake-SAP Playwright smoke flow to switch areas, add one item in each area, verify two preview groups, and confirm only the failed group offers retry. Update README with sales-area source, A305 matching, split-order results, and no-live-write smoke-test warning.

```bash
git add public/index.html public/app.js public/styles.css README.md test/portal-app.test.ts
git commit -m '[AI-IMP]销售范围商城界面'
git push origin session/d1f90d2aa648
```

## Self-Review

- Task 1 covers exact customer/sales-area price selection and empty sales areas; Task 2 covers split submission, partial results and idempotency; Task 3 keeps all contracts session-bound; Task 4 covers the approved top switcher and grouped cart.
- All later names use `SalesArea`, `SalesArea.key`, `OrderSubmissionService` and `OrderGroupResult` introduced in earlier tasks.
- The plan contains no unbounded SAP write operation: all production writes remain behind `assertWriteAllowed` and explicit confirmation.

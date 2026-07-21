# Task 1 report: SAP order read model and analytics

## Changed files

- `src/order-history.ts`
  - Replaced the legacy SAP history shape with typed paginated order summaries, dashboard analytics, insights, and on-demand order details.
  - Reads only SAP OData endpoints and applies both the SAP `SoldToParty` filter and a defensive post-read ownership filter.
  - Normalizes pagination and sort input, applies twelve-month/date/status/sales-organization/text filters, maps SAP statuses and line items, and rejects foreign order details before reading items.
  - Keeps a deprecated `CustomerOrderHistory` type alias so the following route task can migrate its dependency type without breaking the source build in this isolated commit.
- `test/order-history.test.ts`
  - Added TDD coverage for session-customer filtering, pagination, sorting, SAP row mapping/analytics, and foreign-detail rejection.

## TDD evidence

1. Added the two specified order-workbench tests before changing production code.
2. Ran `npm test -- --test-name-pattern='filters only|rejects an order detail'`.
   - Result: failed as expected: the legacy response had no `page`, and `detail` did not exist.
3. Implemented the SAP-only read model.
4. Re-ran the same focused command.
   - Result: 41 passing, 0 failing.

## Verification commands and results

- `npm test -- --test-name-pattern='filters only|rejects an order detail'` — 41 passing, 0 failing.
- `npm test -- --test-name-pattern='orders|order detail'` — 41 passing, 0 failing.
- `npm test` — 41 passing, 0 failing.
- `npm run build` — TypeScript compilation succeeded.
- `git diff --check` — no whitespace errors.

## Commit

- `f2951436c2b525c5d84d255ebda06d6affbc0bb9` — `[AI-ADD]订单工作台查询模型`

## Concerns / handoff

- The pre-existing portal route and its test fixture still use the old history payload at runtime. Task 2 is explicitly responsible for migrating the route to `list(customer, query)` and adding `detail`; this task keeps only a deprecated type alias to preserve the source build until then.
- The repository emits an existing npm warning for the unsupported global `--init.module` config. It does not affect the passing tests or build.

## Review follow-up: error contract and SAP-error sanitization

### Changed files

- `src/order-history.ts`
  - Added the exported `OrderHistoryError` contract with safe `code` values (`ORDER_NOT_FOUND` and `SAP_READ_FAILED`) and an explicit `httpStatus` of 404 or 502.
  - Converts foreign detail ownership and SAP 404s while loading a detail header into the same 404-safe order-not-found error.
  - Wraps list, detail-header, and detail-line SAP reads so SAP-originated messages cannot reach callers; non-404 read failures become the generic `SAP_READ_FAILED` response.
- `test/order-history.test.ts`
  - Verifies the 404 error contract for foreign and missing details.
  - Verifies raw SAP error text is absent from both list and detail read failures.

### Tests and results

- TDD red: `npm test -- --test-name-pattern='safe 404|sanitizes'` — 3 expected failures before implementation (missing error code/status and raw error propagation).
- `npm test -- --test-name-pattern='safe 404|sanitizes'` — 43 passing, 0 failing after implementation.
- `npm test -- test/order-history.test.ts` — 43 passing, 0 failing.
- `npm test` — 43 passing, 0 failing.
- `npm run build` — TypeScript compilation succeeded.
- `git diff --check` — no whitespace errors.

### Commit

- `309181e` — `[AI-FIX]订单历史读取错误契约`

### Concerns

- The forthcoming portal route must map `OrderHistoryError.httpStatus` (or `code`) rather than error message text; the service now exposes both values for that purpose.
- The existing global npm `--init.module` warning remains unrelated to this change.

## Review follow-up: nullable optional SAP fields

### Changed files

- `src/order-history.ts`
  - Maps absent or whitespace-only optional SAP header and line fields to `null`, including customer purchase order, requested/customer PO dates, creator, material, description, quantity unit, net price, and line currency.
  - Keeps required identifiers, quantities, net amounts, statuses, and aggregate values unchanged; keyword filtering treats a missing customer PO as empty search text without exposing `"null"`.
- `test/order-history.test.ts`
  - Adds a focused order-detail regression that verifies both absent and whitespace-only SAP optional values are serialized as `null`.
- `docs/superpowers/plans/2026-07-21-rich-sap-order-workbench.md`
  - Updates the documented interfaces and mapper examples to use the same `null` semantics.

### TDD evidence

1. Added `maps unmaintained optional SAP header and line fields to null` before the mapper change.
2. Ran `npm test -- --test-name-pattern='maps unmaintained optional SAP header and line fields to null'`.
   - Result: expected failure: `'' !== null` for `purchaseOrderByCustomer`.
3. Added nullable text, date, and amount normalizers and updated optional field types.
4. Re-ran the focused command after changing the fixture to explicit whitespace-only SAP values.
   - Result: 44 passing, 0 failing.

### Verification commands and results

- `npm test -- --test-name-pattern='maps unmaintained optional SAP header and line fields to null'` — 44 passing, 0 failing.
- `npm test` — 44 passing, 0 failing.
- `npm run build` — TypeScript compilation succeeded.
- `git diff --check` — no whitespace errors.

### Commit

- `9be5eef` — `[AI-FIX]订单可选字段空值语义` (pushed to `origin/session/d1f90d2aa648`).

### Concerns

- The next portal task must render `null` optional values as “SAP 未维护” rather than converting them to empty strings.
- The existing global npm `--init.module` warning remains unrelated to this change.

## Review follow-up: multi-currency analytics

### Changed files

- `src/order-history.ts`
  - Adds `CurrencyTotal` and exposes `totalsByCurrency` on dashboard totals, monthly totals, and sales-organization insights.
  - Aggregates only within the same `TransactionCurrency`; no exchange rate or cross-currency sum is created.
  - Emits the legacy `totalAmount`, `averageAmount`, and `currency` convenience fields only when exactly one currency is present.
  - Ranks sales organizations by order count rather than a cross-currency monetary total.
- `test/order-history.test.ts`
  - Adds CNY + USD coverage proving dashboard, monthly, and sales-organization totals remain separate and omit unified amount/currency fields.
- `docs/superpowers/plans/2026-07-21-rich-sap-order-workbench.md`
  - Updates the read-model contract and Task 4 rendering requirement to consume `totalsByCurrency` and prohibit cross-currency UI totals.

### TDD evidence

1. Added the mixed CNY/USD regression before production changes.
2. Ran `npm test -- --test-name-pattern='keeps CNY and USD dashboard and sales-organization totals separate'`.
   - Result: expected failure because `dashboard.totalsByCurrency` was absent.
3. Added currency-keyed aggregation and conditional single-currency convenience fields.
4. Re-ran the focused command.
   - Result: 45 passing, 0 failing.

### Verification commands and results

- `npm test -- --test-name-pattern='keeps CNY and USD dashboard and sales-organization totals separate'` — 45 passing, 0 failing.
- `npm test -- test/order-history.test.ts` — 45 passing, 0 failing.
- `npm test` — 45 passing, 0 failing.
- `npm run build` — TypeScript compilation succeeded.
- `git diff --check` — no whitespace errors.

### Commit

- `4375642` — `[AI-FIX]订单多币种聚合` (pushed to `origin/session/d1f90d2aa648`).

### Concerns

- The currently pending frontend task must render `totalsByCurrency`; its documented requirement has been updated, but no Task 2 route or frontend implementation was changed here.
- The existing global npm `--init.module` warning remains unrelated to this change.

## Review follow-up: Axios-style 404 read errors

### Changed files

- `src/order-history.ts`
  - Safely reads both direct `status` and Axios-style `response.status` values without retaining or propagating the raw SAP error.
- `test/order-history.test.ts`
  - Adds a detail-read regression for `{ response: { status: 404 }, message: 'sensitive SAP text' }`, asserting typed `ORDER_NOT_FOUND` / 404 and no sensitive message text.

### TDD evidence

1. Added `maps an Axios-style missing order detail to a safe 404 error contract` before changing the status extractor.
2. Ran `npm test -- --test-name-pattern='Axios-style missing order detail'`.
   - Result: expected failure: actual code `SAP_READ_FAILED`, expected `ORDER_NOT_FOUND`.
3. Added nested `response.status` extraction after the existing direct-status check.
4. Re-ran the focused command.
   - Result: 46 passing, 0 failing.

### Verification commands and results

- `npm test -- --test-name-pattern='Axios-style missing order detail'` — 46 passing, 0 failing.
- `npm test` — 46 passing, 0 failing.
- `npm run build` — TypeScript compilation succeeded.
- `git diff --check` — no whitespace errors.

### Concerns

- The existing global npm `--init.module` warning remains unrelated to this change.

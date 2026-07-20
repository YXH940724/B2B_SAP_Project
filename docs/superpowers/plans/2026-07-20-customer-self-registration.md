# 客户自助注册与登录 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 SAP 客户下单门户提供基于 SAP 客户号、邮箱验证码和独立密码的自助注册与登录能力。

**Architecture:** SAP OData 仅验证客户并读取关联业务伙伴的邮箱；新的认证服务负责验证码、密码哈希和会话。SQLite 保存账号与验证码状态，Express 路由对外提供注册和登录接口，浏览器只显示当前表单状态的反馈。

**Tech Stack:** TypeScript、Express 5、Node.js `crypto.scrypt`、better-sqlite3、Supertest、Node test runner。

## Global Constraints

- SAP 客户资料和关联邮箱只读；不得执行 SAP 写操作。
- 数据库、密码、验证码、SAP 凭证和证书不得提交 Git。
- 密码至少 12 位；密码与验证码均使用随机盐加 `crypto.scrypt` 哈希。
- 验证码六位、十分钟有效、最多五次验证、同一客户号十分钟最多三次请求。
- `VERIFICATION_DELIVERY=log` 只允许 `NODE_ENV=development`；生产环境必须拒绝日志投递。
- 会话 Cookie 必须 `HttpOnly`、`SameSite=Lax`，生产环境必须 `Secure`。
- `SAP_WRITE_ENABLED` 的默认值仍为 `false`。

---

### Task 1: 增加认证依赖和安全基础模块

**Files:**
- Modify: `package.json`
- Modify: `.gitignore`
- Create: `src/auth-crypto.ts`
- Create: `test/auth-crypto.test.ts`

**Interfaces:**
- Produces `hashSecret(secret: string): Promise<string>`、`verifySecret(secret: string, encoded: string): Promise<boolean>`、`generateVerificationCode(): string`。
- `hashSecret` 返回 `scrypt$<base64-salt>$<base64-derived-key>`，所有消费者只保存该值。

- [ ] **Step 1: 写出密码和验证码哈希失败测试**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { generateVerificationCode, hashSecret, verifySecret } from "../src/auth-crypto.js";

test("hashes and verifies a secret without accepting a different secret", async () => {
  const encoded = await hashSecret("a-long-enough-password");
  assert.match(encoded, /^scrypt\$/);
  assert.equal(await verifySecret("a-long-enough-password", encoded), true);
  assert.equal(await verifySecret("different-password", encoded), false);
});

test("generates a six digit verification code", () => {
  assert.match(generateVerificationCode(), /^\d{6}$/);
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `npm test -- --test-name-pattern='hashes and verifies|generates a six'`

Expected: FAIL，因为 `src/auth-crypto.ts` 不存在。

- [ ] **Step 3: 安装 SQLite 与 HTTP 测试依赖并更新忽略规则**

```bash
npm install better-sqlite3@11.10.0 supertest@7.1.4
npm install --save-dev @types/better-sqlite3@7.6.12 @types/supertest@6.0.3
```

Add to `.gitignore`:

```gitignore
data/
*.sqlite
*.sqlite-shm
*.sqlite-wal
```

- [ ] **Step 4: 实现安全基础模块**

```ts
import { randomBytes, randomInt, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
const KEY_LENGTH = 64;

export async function hashSecret(secret: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(secret, salt, KEY_LENGTH) as Buffer;
  return `scrypt$${salt.toString("base64")}$${derived.toString("base64")}`;
}

export async function verifySecret(secret: string, encoded: string): Promise<boolean> {
  const [algorithm, saltText, hashText] = encoded.split("$");
  if (algorithm !== "scrypt" || !saltText || !hashText) return false;
  const expected = Buffer.from(hashText, "base64");
  const actual = await scrypt(secret, Buffer.from(saltText, "base64"), expected.length) as Buffer;
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function generateVerificationCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}
```

- [ ] **Step 5: 运行测试与构建**

Run: `npm test && npm run build`

Expected: 全部通过。

- [ ] **Step 6: 提交**

```bash
git add package.json package-lock.json .gitignore src/auth-crypto.ts test/auth-crypto.test.ts
git commit -m '[AI-ADD]认证安全基础'
```

### Task 2: 实现 SQLite 认证存储和验证码规则

**Files:**
- Create: `src/auth-store.ts`
- Create: `src/auth-service.ts`
- Create: `test/auth-service.test.ts`

**Interfaces:**
- Consumes `hashSecret`、`verifySecret`、`generateVerificationCode`。
- Produces `AuthStore`、`AuthService`、`RegistrationError` 和 `LoginError`。
- `AuthService.requestCode(customer, email)` 返回明文验证码仅供投递器使用；`completeRegistration(customer, code, password)` 与 `login(customer, password)` 不返回密码或哈希。

- [ ] **Step 1: 写出验证码过期、错误次数、限频与登录失败测试**

```ts
test("creates one usable code, expires it and rejects the sixth bad attempt", async () => {
  const { service, clock } = makeService();
  const issued = await service.requestCode("0000100001", "buyer@example.test");
  await assert.rejects(() => service.completeRegistration("0000100001", "000000", "123456789012"));
  for (let index = 0; index < 4; index += 1) await assert.rejects(() => service.completeRegistration("0000100001", "000000", "123456789012"));
  await assert.rejects(() => service.completeRegistration("0000100001", issued.code, "123456789012"), /验证码/);
  clock.advance(10 * 60 * 1000);
  await assert.rejects(() => service.requestCode("0000100001", "buyer@example.test"));
});

test("registers once and verifies a password on later login", async () => {
  const { service } = makeService();
  const { code } = await service.requestCode("0000100001", "buyer@example.test");
  await service.completeRegistration("0000100001", code, "123456789012");
  assert.equal(await service.login("0000100001", "123456789012"), true);
  assert.equal(await service.login("0000100001", "wrong-password"), false);
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `npm test -- --test-name-pattern='creates one usable|registers once'`

Expected: FAIL，因为 `AuthService` 未实现。

- [ ] **Step 3: 创建 SQLite 表与仓储接口**

```ts
export interface VerificationRecord {
  customer: string;
  codeHash: string;
  expiresAt: number;
  attempts: number;
  requestCount: number;
  requestWindowStartedAt: number;
}

export interface AuthStore {
  getUser(customer: string): { customer: string; passwordHash: string } | undefined;
  createUser(customer: string, passwordHash: string, now: number): void;
  getVerification(customer: string): VerificationRecord | undefined;
  saveVerification(record: VerificationRecord): void;
  deleteVerification(customer: string): void;
  updateAttempts(customer: string, attempts: number): void;
  markLogin(customer: string, now: number): void;
}
```

Initialize both spec tables with `CREATE TABLE IF NOT EXISTS`, use `PORTAL_DB_PATH ?? "data/portal.db"`, create its parent directory with mode `0700`, and use parameterized statements for every value.

- [ ] **Step 4: 实现业务规则**

```ts
const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const MAX_REQUESTS = 3;

export class AuthService {
  async requestCode(customer: string, email: string): Promise<{ code: string }> { /* create/reuse window and save hash */ }
  async completeRegistration(customer: string, code: string, password: string): Promise<void> { /* verify code, password length and create account */ }
  async login(customer: string, password: string): Promise<boolean> { /* verify stored hash and mark login */ }
}
```

Reject passwords shorter than 12 characters, reject existing users during registration, delete the verification record after successful registration, and never include `email` in the return value or a log.

- [ ] **Step 5: 运行认证测试、全部测试与构建**

Run: `npm test && npm run build`

Expected: 全部通过。

- [ ] **Step 6: 提交**

```bash
git add src/auth-store.ts src/auth-service.ts test/auth-service.test.ts
git commit -m '[AI-ADD]客户认证存储'
```

### Task 3: 实现 SAP 客户邮箱解析和开发日志投递器

**Files:**
- Modify: `src/master-data.ts`
- Create: `src/customer-contact.ts`
- Create: `src/verification-delivery.ts`
- Create: `test/customer-contact.test.ts`

**Interfaces:**
- Produces `getCustomerRegistrationContact(client, config, customer): Promise<{ customer: string; email: string }>`。
- Produces `VerificationDelivery.send(customer: string, code: string): Promise<void>` 和 `createVerificationDelivery(env): VerificationDelivery`。
- Consumes `SapODataClient.getAt`; all SAP calls are GET-only.

- [ ] **Step 1: 写出 SAP 联系人解析与日志投递失败测试**

```ts
test("resolves the first business partner email for a customer", async () => {
  const client = fakeODataClient({ customerBusinessPartner: "0000100001", email: "buyer@example.test" });
  await assert.doesNotReject(() => getCustomerRegistrationContact(client, config, "100001"));
  assert.deepEqual(client.paths, [
    "/A_Customer('0000100001')",
    "/A_BusinessPartnerAddress",
  ]);
});

test("refuses log delivery outside development", () => {
  assert.throws(() => createVerificationDelivery({ NODE_ENV: "production", VERIFICATION_DELIVERY: "log" }), /production/);
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `npm test -- --test-name-pattern='resolves the first|refuses log delivery'`

Expected: FAIL，因为联系信息与投递模块不存在。

- [ ] **Step 3: 实现只读 SAP 邮箱查询**

```ts
const customer = await client.getAt<{ BusinessPartner?: string }>(config.services.businessPartner, `/A_Customer('${odataKey(normalizeCustomer(input))}')`, {
  "$select": "Customer,BusinessPartner",
});
const address = await client.getAt<{ results?: Array<{ to_EmailAddress?: { results?: Array<{ EmailAddress?: string }> } }> }>(config.services.businessPartner, "/A_BusinessPartnerAddress", {
  "$filter": `BusinessPartner eq '${odataKey(customer.data.BusinessPartner ?? "")}'`,
  "$expand": "to_EmailAddress",
  "$top": 1,
});
```

Return a generic registration eligibility error if the business partner or email is absent. Do not expose the email to browser clients.

- [ ] **Step 4: 实现开发日志投递器**

```ts
export function createVerificationDelivery(env: NodeJS.ProcessEnv): VerificationDelivery {
  if (env.VERIFICATION_DELIVERY !== "log") throw new Error("No verification delivery is configured.");
  if (env.NODE_ENV !== "development") throw new Error("Log verification delivery is allowed only in development.");
  return { send: async (customer, code) => console.info(`[development] verification code for ${customer}: ${code}`) };
}
```

- [ ] **Step 5: 运行全部测试与构建**

Run: `npm test && npm run build`

Expected: 全部通过，且没有 SAP 写请求。

- [ ] **Step 6: 提交**

```bash
git add src/master-data.ts src/customer-contact.ts src/verification-delivery.ts test/customer-contact.test.ts
git commit -m '[AI-ADD]客户邮箱验证码'
```

### Task 4: 增加 HTTP 注册、登录和安全会话路由

**Files:**
- Modify: `src/web-server.ts`
- Create: `test/web-server.test.ts`

**Interfaces:**
- Refactor server export to `createPortalApp(deps): express.Express`; executable file calls `app.listen` only when run as the portal entrypoint.
- `POST /api/register/request-code` accepts `{ customer }`.
- `POST /api/register/verify` accepts `{ customer, code, password }`.
- `POST /api/login` accepts `{ customer, password }`.
- `POST /api/logout` clears session Cookie.

- [ ] **Step 1: 写出路由失败与成功测试**

```ts
test("shows an authentication failure as JSON and does not create a cookie", async () => {
  const response = await request(app).post("/api/login").send({ customer: "100001", password: "wrong-password" });
  assert.equal(response.status, 401);
  assert.match(response.body.error, /客户号或密码/);
  assert.equal(response.headers["set-cookie"], undefined);
});

test("creates a session after a successful registration and login", async () => {
  await request(app).post("/api/register/request-code").send({ customer: "100001" }).expect(202);
  await request(app).post("/api/register/verify").send({ customer: "100001", code: emittedCode, password: "123456789012" }).expect(201);
  const response = await request(app).post("/api/login").send({ customer: "100001", password: "123456789012" }).expect(200);
  assert.match(response.headers["set-cookie"][0], /HttpOnly/);
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `npm test -- --test-name-pattern='shows an authentication|creates a session'`

Expected: FAIL，因为路由仍使用 `PORTAL_PASSWORD`。

- [ ] **Step 3: 注入依赖并替换全局密码**

Create an injectable dependency type:

```ts
export interface PortalDependencies {
  auth: AuthService;
  contact: { get(customer: string): Promise<{ customer: string; email: string }> };
  delivery: VerificationDelivery;
  now: () => number;
}
```

The request-code route calls `contact.get`, `auth.requestCode`, then `delivery.send`. The verify route calls `auth.completeRegistration`. The login route calls `auth.login` before it creates a session. Normalize customer IDs at every incoming route boundary. Return `401` only for login failure and clear the session on logout.

- [ ] **Step 4: 修正可展示的错误和 Cookie 属性**

```ts
res.setHeader("Set-Cookie", `portal_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800${process.env.NODE_ENV === "production" ? "; Secure" : ""}`);
```

Use a generic message for contact lookup and registration code requests. Do not create the session until `auth.login` returns true.

- [ ] **Step 5: 运行路由测试、全部测试与构建**

Run: `npm test && npm run build`

Expected: 全部通过；登录错误无 Cookie，成功登录具有 HttpOnly Cookie。

- [ ] **Step 6: 提交**

```bash
git add src/web-server.ts test/web-server.test.ts
git commit -m '[AI-ADD]客户注册接口'
```

### Task 5: 更新门户界面、配置文档并进行端到端验证

**Files:**
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `public/styles.css`
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `test/web-server.test.ts`

**Interfaces:**
- Consumes Task 4 的四个认证 HTTP 接口。
- Produces visible login/register status states and button busy state.

- [ ] **Step 1: 写出页面状态与 API 失败提示测试**

```ts
test("serves an authentication message area outside the hidden order portal", async () => {
  const html = await request(app).get("/").expect(200);
  assert.match(html.text, /id="auth-message"/);
  assert.doesNotMatch(html.text, /<section id="portal" hidden>[\s\S]*id="auth-message"/);
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `npm test -- --test-name-pattern='serves an authentication message'`

Expected: FAIL，因为当前页面只有隐藏下单区中的 `message` 元素。

- [ ] **Step 3: 实现三段认证界面与忙碌状态**

Use three visible-state sections: `login-panel`, `register-request-panel`, and `register-verify-panel`. Keep `auth-message` outside `portal`; add `setBusy(button, busy, busyText)` and always restore it in `finally`. On successful `/api/login`, hide the authentication section and unhide `portal`; on API failure, call `note(error.message)` while the authentication section remains visible.

- [ ] **Step 4: 更新安全配置和本地启动文档**

Replace `PORTAL_PASSWORD` in `.env.example` with:

```dotenv
PORTAL_DB_PATH=data/portal.db
VERIFICATION_DELIVERY=log
# `log` is accepted only with NODE_ENV=development. Production requires a mail delivery implementation.
```

Document `npm install`, `npm run build`, `set -a; source ~/.config/sap-odata-mcp/.env; set +a`, and `npm run start:web`; state that the code is printed only to the local development server log and must not be shared.

- [ ] **Step 5: 运行自动化验证和手工开发流程**

Run: `npm test && npm run build`

Then run with development-only OData environment values:

```bash
NODE_ENV=development VERIFICATION_DELIVERY=log npm run start:web
```

Expected: 页面可显示注册入口；失败提示保持可见；成功注册和登录进入下单界面；不调用 SAP 写接口。

- [ ] **Step 6: 提交**

```bash
git add public/index.html public/app.js public/styles.css .env.example README.md test/web-server.test.ts
git commit -m '[AI-IMP]客户门户注册体验'
```

### Task 6: 最终质量门与交付

**Files:**
- Verify: all modified files and `docs/superpowers/specs/2026-07-20-customer-self-registration-design.md`

- [ ] **Step 1: 运行完整质量检查**

Run: `npm test && npm run build && git diff --check`

Expected: 全部测试通过、TypeScript 编译成功、无空白错误。

- [ ] **Step 2: 检查敏感信息与工作区**

Run:

```bash
rg -n 'SAP_PASSWORD=|PORTAL_PASSWORD=|verification code for .*:[[:space:]]*[0-9]{6}' --glob '!node_modules/**' --glob '!dist/**' --glob '!docs/superpowers/plans/**' .
git status --short --branch
```

Expected: 受版本控制的文件中没有真实凭证或验证码；工作区只包含预期文件。

- [ ] **Step 3: 推送已完成提交**

Run: `git push`

Expected: `session/d1f90d2aa648` 已与远程同步。

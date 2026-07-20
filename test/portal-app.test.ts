import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import request from "supertest";
import { AuthService } from "../src/auth-service.js";
import { createAuthStore } from "../src/auth-store.js";
import { createPortalApp } from "../src/portal-app.js";

function makeApp(): { app: ReturnType<typeof createPortalApp>; getCode: () => string } {
  let code = "";
  const auth = new AuthService(createAuthStore(":memory:"), () => 1_700_000_000_000, () => "123456");
  const app = createPortalApp({
    auth,
    contact: { get: async (customer: string) => ({ customer: customer.padStart(10, "0"), email: "buyer@example.test" }) },
    delivery: { send: async (_customer: string, sentCode: string) => { code = sentCode; } },
  });
  return { app, getCode: () => code };
}

test("does not create a cookie when a portal login password is incorrect", async () => {
  const { app } = makeApp();
  const response = await request(app).post("/api/login").send({ customer: "100001", password: "wrong-password" });
  assert.equal(response.status, 401);
  assert.match(response.body.error, /客户号或密码/);
  assert.equal(response.headers["set-cookie"], undefined);
});

test("registers with a code then creates a secure session on login", async () => {
  const { app, getCode } = makeApp();
  await request(app).post("/api/register/request-code").send({ customer: "100001" }).expect(202);
  await request(app).post("/api/register/verify").send({ customer: "100001", code: getCode(), password: "123456789012" }).expect(201);
  const response = await request(app).post("/api/login").send({ customer: "100001", password: "123456789012" }).expect(200);
  assert.match(response.headers["set-cookie"][0], /HttpOnly/);
  assert.match(response.headers["set-cookie"][0], /SameSite=Lax/);
});

test("clears the current session on logout", async () => {
  const { app, getCode } = makeApp();
  await request(app).post("/api/register/request-code").send({ customer: "100001" }).expect(202);
  await request(app).post("/api/register/verify").send({ customer: "100001", code: getCode(), password: "123456789012" }).expect(201);
  const login = await request(app).post("/api/login").send({ customer: "100001", password: "123456789012" }).expect(200);
  const response = await request(app).post("/api/logout").set("Cookie", login.headers["set-cookie"][0]).expect(204);
  assert.match(response.headers["set-cookie"][0], /Max-Age=0/);
});

test("logs a sanitized registration failure in development", async () => {
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (message: string) => { errors.push(message); };
  try {
    const auth = new AuthService(createAuthStore(":memory:"));
    const app = createPortalApp({
      auth,
      contact: { get: async () => { throw new Error("SAP customer email lookup failed"); } },
      delivery: { send: async () => undefined },
      production: false,
    });
    await request(app).post("/api/register/request-code").send({ customer: "100001" }).expect(400);
    assert.deepEqual(errors, ["[portal] registration request failed: SAP customer email lookup failed"]);
  } finally {
    console.error = originalError;
  }
});

test("keeps authentication feedback outside the hidden order portal", () => {
  const html = fs.readFileSync(path.resolve(import.meta.dirname, "../public/index.html"), "utf8");
  assert.match(html, /id="auth-message"/);
  assert.doesNotMatch(html, /<section id="portal" hidden>[\s\S]*id="auth-message"/);
});

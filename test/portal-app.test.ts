import assert from "node:assert/strict";
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

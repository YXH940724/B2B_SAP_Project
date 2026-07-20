import assert from "node:assert/strict";
import test from "node:test";
import { AuthService, RegistrationError } from "../src/auth-service.js";
import { createAuthStore } from "../src/auth-store.js";

function makeService(start = 1_700_000_000_000): { service: AuthService; advance: (milliseconds: number) => void } {
  let now = start;
  return {
    service: new AuthService(createAuthStore(":memory:"), () => now, () => "123456"),
    advance: (milliseconds) => { now += milliseconds; },
  };
}

test("rejects a verification code after five incorrect attempts", async () => {
  const { service } = makeService();
  await service.requestCode("0000100001");
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await assert.rejects(() => service.completeRegistration("0000100001", "000000", "123456789012"), RegistrationError);
  }
  await assert.rejects(() => service.completeRegistration("0000100001", "123456", "123456789012"), /验证码/);
});

test("limits verification code requests to three per ten minutes", async () => {
  const { service, advance } = makeService();
  await service.requestCode("0000100001");
  await service.requestCode("0000100001");
  await service.requestCode("0000100001");
  await assert.rejects(() => service.requestCode("0000100001"), /稍后/);
  advance(10 * 60 * 1000);
  await assert.doesNotReject(() => service.requestCode("0000100001"));
});

test("expires verification codes after ten minutes", async () => {
  const { service, advance } = makeService();
  await service.requestCode("0000100001");
  advance(10 * 60 * 1000 + 1);
  await assert.rejects(() => service.completeRegistration("0000100001", "123456", "123456789012"), /过期/);
});

test("registers an account once and verifies its password on login", async () => {
  const { service } = makeService();
  await service.requestCode("0000100001");
  await service.completeRegistration("0000100001", "123456", "123456789012");
  assert.equal(await service.login("0000100001", "123456789012"), true);
  assert.equal(await service.login("0000100001", "wrong-password"), false);
  await assert.rejects(() => service.requestCode("0000100001"), /已注册/);
});

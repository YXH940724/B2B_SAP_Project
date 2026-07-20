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

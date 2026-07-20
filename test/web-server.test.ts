import assert from "node:assert/strict";
import https from "node:https";
import test from "node:test";
import request from "supertest";
import { AuthService } from "../src/auth-service.js";
import { createAuthStore } from "../src/auth-store.js";
import type { SapConfig } from "../src/config.js";
import { createConfiguredPortalApp } from "../src/web-server.js";

const config: SapConfig = {
  baseUrl: "https://sap.example.test/orders", client: "200", username: "user", password: "secret", timeoutMs: 30000,
  writeEnabled: false, writeAllowedFields: new Set(), httpsAgent: new https.Agent(),
  services: { product: "https://sap.example.test/products", businessPartner: "https://sap.example.test/bp", pricing: "https://sap.example.test/pricing" },
};

test("wires catalog and customer summary services into the configured portal", async () => {
  let code = "";
  const client = {
    getAt: async (_base: string, path: string) => {
      if (path.startsWith("/A_Customer")) return { data: { Customer: "0000100001", CustomerName: "演示客户", CustomerAccountGroup: "Z001" } };
      if (path === "/A_BusinessPartner") return { data: { results: [{ BusinessPartner: "0000000046" }] } };
      if (path === "/A_BusinessPartnerAddress") return { data: { results: [{ to_EmailAddress: { results: [{ EmailAddress: "buyer@example.test" }] } }] } };
      return { data: { results: [] } };
    },
  };
  const app = createConfiguredPortalApp(config, client as never, {
    auth: new AuthService(createAuthStore(":memory:"), () => 1_700_000_000_000, () => "123456"),
    delivery: { send: async (_customer, issued) => { code = issued; } },
  });
  const agent = request.agent(app);
  await agent.post("/api/register/request-code").send({ customer: "100001" }).expect(202);
  await agent.post("/api/register/verify").send({ customer: "100001", code, password: "123456789012" }).expect(201);
  await agent.post("/api/login").send({ customer: "100001", password: "123456789012" }).expect(200);
  const profile = await agent.get("/api/me").expect(200);
  assert.equal(profile.body.businessPartner, "0000000046");
});

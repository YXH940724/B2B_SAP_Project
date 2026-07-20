import assert from "node:assert/strict";
import https from "node:https";
import test from "node:test";
import { getCustomer360 } from "../src/customer-360.js";
import type { SapConfig } from "../src/config.js";

const config: SapConfig = { baseUrl: "https://sap.example.test/orders", client: "200", username: "user", password: "secret", timeoutMs: 30000, writeEnabled: false, writeAllowedFields: new Set(), httpsAgent: new https.Agent(), services: { product: "https://sap.example.test/product", businessPartner: "https://sap.example.test/bp", pricing: "https://sap.example.test/pricing" } };

test("aggregates only the requested customer's 360 profile", async () => {
  const calls: string[] = [];
  const client = { getAt: async (_base: string, path: string, params?: Record<string, string | number | undefined>) => {
    calls.push(`${path}?${params?.["$filter"] ?? ""}`);
    if (path.startsWith("/A_Customer(")) return { data: { Customer: "0000100001", CustomerName: "演示客户", CustomerAccountGroup: "Z001" } };
    if (path === "/A_BusinessPartner") return { data: { results: [{ BusinessPartner: "0000000046" }] } };
    if (path === "/A_BusinessPartnerAddress") return { data: { results: [{ StreetName: "演示路", CityName: "上海", PostalCode: "200000", Country: "CN", to_EmailAddress: { results: [{ EmailAddress: "buyer@example.test" }] }, to_PhoneNumber: { results: [{ PhoneNumber: "13800000000" }] } }] } };
    if (path === "/A_BusinessPartnerBank") return { data: { results: [{ BankName: "演示银行", BankCountryKey: "CN", BankAccount: "6222", IBAN: "CN00" }] } };
    if (path === "/A_CustomerSalesArea") return { data: { results: [{ SalesOrganization: "1310", DistributionChannel: "10", Division: "00" }] } };
    throw new Error(`Unexpected request ${path}`);
  } };
  const profile = await getCustomer360(client as never, config, "100001");
  assert.equal(profile.customer, "0000100001");
  assert.equal(profile.addresses[0]?.city, "上海");
  assert.equal(profile.emails[0], "buyer@example.test");
  assert.equal(profile.banks[0]?.account, "6222");
  assert.match(calls.join("\n"), /BusinessPartner eq '0000000046'/);
  assert.doesNotMatch(calls.join("\n"), /0000100002/);
});

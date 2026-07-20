import fs from "node:fs";
import https from "node:https";

export interface SapConfig {
  baseUrl: string;
  client: string;
  username: string;
  password: string;
  timeoutMs: number;
  writeEnabled: boolean;
  writeAllowedFields: ReadonlySet<string>;
  httpsAgent: https.Agent;
}

const DEFAULT_WRITE_FIELDS = [
  "PurchaseOrderByCustomer",
  "CustomerPurchaseOrderType",
  "CustomerPurchaseOrderDate",
  "DeliveryBlockReason",
  "CustomerPaymentTerms",
  "CustomerGroup",
];

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} must be configured before starting the SAP OData MCP server.`);
  return value;
}

function boolEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be either true or false.`);
}

export function loadConfig(): SapConfig {
  const baseUrl = required("SAP_ODATA_BASE_URL").replace(/\/+$/, "");
  const url = new URL(baseUrl);
  if (url.protocol !== "https:") throw new Error("SAP_ODATA_BASE_URL must use HTTPS.");

  const client = required("SAP_CLIENT");
  if (!/^\d{3}$/.test(client)) throw new Error("SAP_CLIENT must be a three-digit SAP client number.");

  const timeoutMs = Number(process.env.SAP_REQUEST_TIMEOUT_MS ?? "30000");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) {
    throw new Error("SAP_REQUEST_TIMEOUT_MS must be an integer between 1000 and 120000.");
  }

  const caPath = process.env.SAP_CA_CERT_PATH?.trim();
  const rejectUnauthorized = boolEnv("SAP_TLS_REJECT_UNAUTHORIZED", true);
  if (!rejectUnauthorized && process.env.NODE_ENV === "production") {
    throw new Error("Refusing SAP_TLS_REJECT_UNAUTHORIZED=false in production. Configure SAP_CA_CERT_PATH instead.");
  }

  const configuredFields = (process.env.SAP_WRITE_ALLOWED_FIELDS ?? DEFAULT_WRITE_FIELDS.join(","))
    .split(",")
    .map((field) => field.trim())
    .filter(Boolean);

  return {
    baseUrl,
    client,
    username: required("SAP_USER"),
    password: required("SAP_PASSWORD"),
    timeoutMs,
    writeEnabled: boolEnv("SAP_WRITE_ENABLED", false),
    writeAllowedFields: new Set(configuredFields),
    httpsAgent: new https.Agent({
      ca: caPath ? fs.readFileSync(caPath) : undefined,
      rejectUnauthorized,
    }),
  };
}

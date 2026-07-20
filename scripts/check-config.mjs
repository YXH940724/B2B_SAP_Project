const required = ["SAP_ODATA_BASE_URL", "SAP_CLIENT", "SAP_USER", "SAP_PASSWORD"];
const missing = required.filter((name) => !process.env[name]?.trim());
if (missing.length) {
  console.error(`Missing required variables: ${missing.join(", ")}`);
  process.exit(1);
}
try {
  const url = new URL(process.env.SAP_ODATA_BASE_URL);
  if (url.protocol !== "https:") throw new Error("URL must use HTTPS");
} catch (error) {
  console.error(`SAP_ODATA_BASE_URL is invalid: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exit(1);
}
if (!/^\d{3}$/.test(process.env.SAP_CLIENT)) {
  console.error("SAP_CLIENT must be a three-digit SAP client number.");
  process.exit(1);
}
console.log(`Configuration is valid. SAP write capability: ${process.env.SAP_WRITE_ENABLED === "true" ? "enabled (confirmation still required)" : "disabled"}.`);

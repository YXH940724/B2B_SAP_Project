const required = ["HANA_HOST", "HANA_PORT", "HANA_USER", "HANA_PASSWORD"];
const missing = required.filter((name) => !process.env[name]?.trim());

if (missing.length > 0) {
  console.error(`Missing required variables: ${missing.join(", ")}`);
  process.exit(1);
}

const port = Number(process.env.HANA_PORT);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error("HANA_PORT must be an integer from 1 to 65535.");
  process.exit(1);
}

const writeFlags = ["HANA_ALLOW_INSERT", "HANA_ALLOW_UPDATE", "HANA_ALLOW_DELETE"];
const enabledWrites = writeFlags.filter((name) => process.env[name]?.toLowerCase() === "true");

if (enabledWrites.length > 0) {
  console.error(`Write operations are disabled by this deployment: ${enabledWrites.join(", ")}`);
  process.exit(1);
}

console.log("Configuration is valid and retains read-only database defaults.");

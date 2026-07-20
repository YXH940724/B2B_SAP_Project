import path from "node:path";
import { fileURLToPath } from "node:url";
import { AuthService } from "./auth-service.js";
import { createAuthStore } from "./auth-store.js";
import { CatalogService } from "./catalog.js";
import { loadConfig } from "./config.js";
import { getCustomerPortalProfile, getCustomerRegistrationContact } from "./customer-contact.js";
import { SapODataClient } from "./odata-client.js";
import { createPortalApp } from "./portal-app.js";
import { createVerificationDelivery, type VerificationDelivery } from "./verification-delivery.js";

export function createConfiguredPortalApp(config: ReturnType<typeof loadConfig>, client: SapODataClient, options: { auth?: AuthService; delivery?: VerificationDelivery; staticRoot?: string } = {}) {
  return createPortalApp({
    auth: options.auth ?? new AuthService(createAuthStore(process.env.PORTAL_DB_PATH ?? "data/portal.db")),
    contact: { get: (customer) => getCustomerRegistrationContact(client, config, customer) },
    delivery: options.delivery ?? createVerificationDelivery(process.env),
    order: { config, client },
    catalog: new CatalogService(client, config),
    customer: { get: (customer) => getCustomerPortalProfile(client, config, customer) },
    staticRoot: options.staticRoot,
  });
}

export function startPortal(): void {
  const config = loadConfig();
  const client = new SapODataClient(config);
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public");
  const app = createConfiguredPortalApp(config, client, { staticRoot: root });
  app.listen(Number(process.env.PORTAL_PORT ?? "3000"), () => console.log("Order portal is running on http://localhost:3000"));
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) startPortal();

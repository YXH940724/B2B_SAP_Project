import path from "node:path";
import { fileURLToPath } from "node:url";
import { AuthService } from "./auth-service.js";
import { createAuthStore } from "./auth-store.js";
import { MallOrderSubmissionService } from "./mall-orders.js";
import { CatalogService } from "./catalog.js";
import { loadConfig } from "./config.js";
import { getCustomerPortalProfile, getCustomerRegistrationContact } from "./customer-contact.js";
import { SapODataClient } from "./odata-client.js";
import { createPortalApp } from "./portal-app.js";
import { listCustomerSalesAreas } from "./sales-areas.js";
import { getCustomer360 } from "./customer-360.js";
import { getProductFulfillmentOptions } from "./master-data.js";
import { getOrderDefaults } from "./order-defaults.js";
import { OrderHistoryService } from "./order-history.js";
import { createVerificationDelivery, type VerificationDelivery } from "./verification-delivery.js";

export function createConfiguredPortalApp(config: ReturnType<typeof loadConfig>, client: SapODataClient, options: { auth?: AuthService; delivery?: VerificationDelivery; staticRoot?: string } = {}) {
  const store = createAuthStore(process.env.PORTAL_DB_PATH ?? "data/portal.db");
  const orderHistory = new OrderHistoryService(client);
  return createPortalApp({
    auth: options.auth ?? new AuthService(store),
    contact: { get: (customer) => getCustomerRegistrationContact(client, config, customer) },
    delivery: options.delivery ?? createVerificationDelivery(process.env),
    order: { config, client },
    mallOrders: new MallOrderSubmissionService(store, client),
    catalog: new CatalogService(client, config),
    orderDefaults: { get: (customer, salesArea) => getOrderDefaults(client, config, customer, salesArea) },
    fulfillment: { get: (product) => getProductFulfillmentOptions(client, config, product) },
    salesAreas: { list: (customer) => listCustomerSalesAreas(client, config, customer) },
    customer: { get: (customer) => getCustomerPortalProfile(client, config, customer) },
    customer360: { get: (customer) => getCustomer360(client, config, customer) },
    orderHistory,
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

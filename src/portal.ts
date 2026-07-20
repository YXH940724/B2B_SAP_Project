import type { SapConfig } from "./config.js";
import { CatalogService } from "./catalog.js";
import { SapODataClient } from "./odata-client.js";
import type { SalesArea } from "./sales-areas.js";

export async function getSellableOffer(client: SapODataClient, config: SapConfig, customer: string, salesArea: SalesArea, product: string): Promise<{ product: unknown; conditionRecord: string; unitPrice: string; currency: string; priceUnit: string }> {
  const offer = await new CatalogService(client, config).getOffer(customer, salesArea, product);
  return {
    product: offer,
    conditionRecord: offer.conditionRecord,
    unitPrice: offer.unitPrice,
    currency: offer.currency,
    priceUnit: offer.priceUnit,
  };
}

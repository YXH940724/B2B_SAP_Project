import type { SapConfig } from "./config.js";
import { CatalogService } from "./catalog.js";
import { SapODataClient } from "./odata-client.js";

export async function getSellableOffer(client: SapODataClient, config: SapConfig, product: string): Promise<{ product: unknown; conditionRecord: string; unitPrice: string; currency: string; priceUnit: string }> {
  const offer = await new CatalogService(client, config).getOffer(product);
  return {
    product: offer,
    conditionRecord: offer.conditionRecord,
    unitPrice: offer.unitPrice,
    currency: offer.currency,
    priceUnit: offer.priceUnit,
  };
}

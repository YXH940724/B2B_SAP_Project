import type { SapConfig } from "./config.js";
import { SapODataClient } from "./odata-client.js";
import { getProduct } from "./master-data.js";

type ODataResults<T> = { results?: T[] };
type Validity = { Material?: string; ConditionRecord?: string; ConditionType?: string; ConditionValidityStartDate?: string; ConditionValidityEndDate?: string; to_SlsPrcgConditionRecord?: { ConditionTable?: string; ConditionRateValue?: string; ConditionRateValueUnit?: string; ConditionQuantity?: string; ConditionQuantityUnit?: string } };

function sapDate(value: string | undefined): Date | undefined {
  const milliseconds = value?.match(/\/Date\((\d+)\)\//)?.[1];
  return milliseconds ? new Date(Number(milliseconds)) : undefined;
}

export async function getSellableOffer(client: SapODataClient, config: SapConfig, product: string): Promise<{ product: unknown; conditionRecord: string; unitPrice: string; currency: string; priceUnit: string }> {
  const material = product.padStart(18, "0");
  const response = await client.getAt<ODataResults<Validity>>(config.services.pricing, "/A_SlsPrcgCndnRecdValidity", {
    "$filter": `Material eq '${material}' and ConditionType eq 'ZR01'`, "$expand": "to_SlsPrcgConditionRecord", "$top": 20,
  });
  const now = new Date();
  const match = (response.data.results ?? []).find((row) => {
    const header = row.to_SlsPrcgConditionRecord;
    const from = sapDate(row.ConditionValidityStartDate);
    const to = sapDate(row.ConditionValidityEndDate);
    return header?.ConditionTable === "305" && header.ConditionRateValue && (!from || from <= now) && (!to || to >= now);
  });
  if (!match?.to_SlsPrcgConditionRecord?.ConditionRateValue || !match.ConditionRecord) {
    throw new Error("This product has no current ZR01 price in condition table A305 and cannot be ordered.");
  }
  return {
    product: await getProduct(client, config, product), conditionRecord: match.ConditionRecord,
    unitPrice: match.to_SlsPrcgConditionRecord.ConditionRateValue,
    currency: match.to_SlsPrcgConditionRecord.ConditionRateValueUnit ?? "",
    priceUnit: match.to_SlsPrcgConditionRecord.ConditionQuantityUnit ?? "",
  };
}

import type { SapConfig } from "./config.js";
import { SapODataClient } from "./odata-client.js";

export function odataKey(value: string): string {
  return value.replace(/'/g, "''");
}

/** SAP S/4HANA customer IDs are normally stored as a 10-character number. */
export function normalizeCustomer(customer: string): string {
  const value = customer.trim();
  return /^\d{1,10}$/.test(value) ? value.padStart(10, "0") : value;
}

export async function getProduct(client: SapODataClient, config: SapConfig, product: string): Promise<unknown> {
  return (await client.getAt<unknown>(config.services.product, `/A_Product('${odataKey(product)}')`, {
    "$select": "Product,ProductType,ProductGroup,BaseUnit,Division,CreationDate,LastChangeDate,IsMarkedForDeletion",
  })).data;
}

export async function getCustomer(client: SapODataClient, config: SapConfig, customer: string): Promise<unknown> {
  const normalizedCustomer = normalizeCustomer(customer);
  return (await client.getAt<unknown>(config.services.businessPartner, `/A_Customer('${odataKey(normalizedCustomer)}')`, {
    "$select": "Customer,CustomerName,CustomerAccountGroup,DeletionIndicator,CreatedByUser,CreationDate",
  })).data;
}

export async function listSalesPriceConditions(client: SapODataClient, config: SapConfig, limit: number, offset: number, conditionType?: string): Promise<unknown> {
  return (await client.getAt<unknown>(config.services.pricing, "/A_SlsPrcgConditionRecord", {
    "$top": limit,
    "$skip": offset,
    "$select": "ConditionRecord,ConditionSequentialNumber,ConditionType,ConditionValidityStartDate,ConditionValidityEndDate,ConditionRateValue,ConditionRateValueUnit,ConditionQuantityUnit,ConditionIsDeleted",
    ...(conditionType ? { "$filter": `ConditionType eq '${odataKey(conditionType)}'` } : {}),
  })).data;
}

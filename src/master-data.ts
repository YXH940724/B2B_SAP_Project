import type { SapConfig } from "./config.js";
import { SapODataClient } from "./odata-client.js";

function odataKey(value: string): string {
  return value.replace(/'/g, "''");
}

export async function getProduct(client: SapODataClient, config: SapConfig, product: string): Promise<unknown> {
  return (await client.getAt<unknown>(config.services.product, `/A_Product('${odataKey(product)}')`, {
    "$select": "Product,ProductType,ProductGroup,BaseUnit,Division,CreationDate,LastChangeDate,IsMarkedForDeletion",
  })).data;
}

export async function getCustomer(client: SapODataClient, config: SapConfig, customer: string): Promise<unknown> {
  return (await client.getAt<unknown>(config.services.businessPartner, `/A_Customer('${odataKey(customer)}')`, {
    "$select": "Customer,CustomerName,CustomerAccountGroup,DeletionIndicator,CreatedByUser,CreationDate,LastChangeDate",
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

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

export interface ProductDetails {
  product: string;
  description: string;
  productGroup: string;
  baseUnit: string;
}

export async function getProductDetails(client: SapODataClient, config: SapConfig, product: string): Promise<ProductDetails> {
  const header = await client.getAt<{ Product?: string; ProductGroup?: string; BaseUnit?: string; to_Description?: { results?: Array<{ ProductDescription?: string }> } }>(
    config.services.product,
    `/A_Product('${odataKey(product)}')`,
    { "$select": "Product,ProductGroup,BaseUnit", "$expand": "to_Description" },
  );
  const description = header.data.to_Description?.results?.map(({ ProductDescription }) => ProductDescription?.trim())
    .find((value): value is string => Boolean(value)) ?? header.data.Product ?? product;
  return {
    product: header.data.Product ?? product,
    description,
    productGroup: header.data.ProductGroup?.trim() || "UNCLASSIFIED",
    baseUnit: header.data.BaseUnit?.trim() || "",
  };
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

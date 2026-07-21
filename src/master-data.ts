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
  descriptionLanguage: string;
  descriptionFallback: boolean;
  productGroup: string;
  baseUnit: string;
}

type ODataResults<T> = { results?: T[] };

type ProductHeader = { Product?: string; ProductGroup?: string; BaseUnit?: string };
type ProductDescription = { ProductDescription?: string };
type ProductPlant = { Plant?: string };
type ProductStorageLocation = { Plant?: string; StorageLocation?: string };

export type ProductFulfillmentOptions = {
  defaultPlant?: string;
  plants: string[];
  storageLocationsByPlant: Record<string, string[]>;
};

function sortedUnique(values: Array<string | undefined>): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))].sort((left, right) => left.localeCompare(right));
}

export async function getProductDetails(client: SapODataClient, config: SapConfig, product: string, language = "ZH"): Promise<ProductDetails> {
  const normalizedLanguage = language.trim().toUpperCase();
  const [header, descriptions] = await Promise.all([
    client.getAt<ProductHeader>(config.services.product, `/A_Product('${odataKey(product)}')`, { "$select": "Product,ProductGroup,BaseUnit" }),
    client.getAt<ODataResults<ProductDescription>>(config.services.product, "/A_ProductDescription", {
      "$filter": `Product eq '${odataKey(product)}' and Language eq '${odataKey(normalizedLanguage)}'`,
      "$select": "Product,Language,ProductDescription",
      "$top": 1,
    }),
  ]);
  const description = descriptions.data.results?.map((row) => row.ProductDescription?.trim()).find((value): value is string => Boolean(value));
  return {
    product: header.data.Product ?? product,
    description: description ?? header.data.Product ?? product,
    descriptionLanguage: normalizedLanguage,
    descriptionFallback: !description,
    productGroup: header.data.ProductGroup?.trim() || "UNCLASSIFIED",
    baseUnit: header.data.BaseUnit?.trim() || "",
  };
}

export async function getProductFulfillmentOptions(client: SapODataClient, config: SapConfig, product: string): Promise<ProductFulfillmentOptions> {
  const filter = `Product eq '${odataKey(product)}'`;
  const [plantsResponse, locationsResponse] = await Promise.all([
    client.getAt<ODataResults<ProductPlant>>(config.services.product, "/A_ProductPlant", { "$filter": filter, "$select": "Product,Plant", "$top": 100 }),
    client.getAt<ODataResults<ProductStorageLocation>>(config.services.product, "/A_ProductStorageLocation", { "$filter": filter, "$select": "Product,Plant,StorageLocation", "$top": 500 }),
  ]);
  const plants = sortedUnique([...(plantsResponse.data.results ?? []).map((row) => row.Plant), ...(locationsResponse.data.results ?? []).map((row) => row.Plant)]);
  const storageLocationsByPlant = Object.fromEntries(plants.map((plant) => [plant, sortedUnique((locationsResponse.data.results ?? []).filter((row) => row.Plant?.trim() === plant).map((row) => row.StorageLocation))]));
  return { defaultPlant: plants[0], plants, storageLocationsByPlant };
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

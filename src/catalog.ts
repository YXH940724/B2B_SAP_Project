import type { SapConfig } from "./config.js";
import { getProductDetails, normalizeCustomer, odataKey, type ProductDetails } from "./master-data.js";
import { SapODataClient } from "./odata-client.js";
import type { SalesArea } from "./sales-areas.js";

type ODataResults<T> = { results?: T[] };

export interface PriceValidity {
  Customer?: string;
  SalesOrganization?: string;
  DistributionChannel?: string;
  Material?: string;
  ConditionRecord?: string;
  ConditionValidityStartDate?: string;
  ConditionValidityEndDate?: string;
  to_SlsPrcgConditionRecord?: {
    ConditionTable?: string;
    ConditionRateValue?: string;
    ConditionRateValueUnit?: string;
    ConditionQuantityUnit?: string;
    ConditionIsDeleted?: boolean | string;
  };
}

export interface CatalogItem {
  product: string;
  description: string;
  productGroup: string;
  baseUnit: string;
  conditionRecord: string;
  unitPrice: string;
  currency: string;
  priceUnit: string;
}

export interface CatalogPage {
  items: CatalogItem[];
  groups: Array<{ code: string; label: string; count: number }>;
  page: number;
  pageSize: number;
  total: number;
  pageCount: number;
}

export interface CatalogQuery {
  query?: string;
  group?: string;
  page: number;
  pageSize: number;
  sort: "material" | "price";
}

export interface CurrentPrice {
  material: string;
  conditionRecord: string;
  unitPrice: string;
  currency: string;
  priceUnit: string;
  validityStart?: Date;
}

function sapDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const milliseconds = value.match(/\/Date\((-?\d+)\)\//)?.[1];
  if (milliseconds) return new Date(Number(milliseconds));
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function isDeleted(value: boolean | string | undefined): boolean {
  return value === true || value === "true" || value === "X";
}

export function currentA305Price(row: PriceValidity, now: Date): CurrentPrice | undefined {
  const header = row.to_SlsPrcgConditionRecord;
  const unitPrice = Number(header?.ConditionRateValue);
  const from = sapDate(row.ConditionValidityStartDate);
  const to = sapDate(row.ConditionValidityEndDate);
  if (!row.Material || !row.ConditionRecord || header?.ConditionTable !== "305" || !Number.isFinite(unitPrice) || unitPrice <= 0 || isDeleted(header.ConditionIsDeleted)) return undefined;
  if ((from && from > now) || (to && to < now)) return undefined;
  return {
    material: row.Material,
    conditionRecord: row.ConditionRecord,
    unitPrice: header.ConditionRateValue ?? "",
    currency: header.ConditionRateValueUnit ?? "",
    priceUnit: header.ConditionQuantityUnit ?? "",
    validityStart: from,
  };
}

function preferPrice(existing: CurrentPrice | undefined, candidate: CurrentPrice): CurrentPrice {
  if (!existing) return candidate;
  const existingTime = existing.validityStart?.getTime() ?? Number.NEGATIVE_INFINITY;
  const candidateTime = candidate.validityStart?.getTime() ?? Number.NEGATIVE_INFINITY;
  if (candidateTime > existingTime) return candidate;
  return candidateTime === existingTime && candidate.conditionRecord > existing.conditionRecord ? candidate : existing;
}

async function mapWithConcurrency<T, R>(values: T[], limit: number, mapper: (value: T) => Promise<R>): Promise<R[]> {
  const output: R[] = [];
  let next = 0;
  async function worker(): Promise<void> {
    while (next < values.length) {
      const index = next;
      next += 1;
      output[index] = await mapper(values[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, () => worker()));
  return output;
}

export class CatalogService {
  constructor(private readonly client: SapODataClient, private readonly config: SapConfig, private readonly clock: () => Date = () => new Date()) {}

  async list(customerInput: string, salesArea: SalesArea, query: CatalogQuery): Promise<CatalogPage> {
    const prices = await this.listCurrentPrices(normalizeCustomer(customerInput), salesArea);
    const detailEntries = await mapWithConcurrency([...prices.values()], 8, async (price) => {
      try {
        return { price, detail: await getProductDetails(this.client, this.config, price.material) };
      } catch {
        return undefined;
      }
    });
    const items = detailEntries.filter((entry): entry is { price: CurrentPrice; detail: ProductDetails } => Boolean(entry))
      .map(({ price, detail }) => toCatalogItem(price, detail));
    const groups = groupCounts(items);
    const searched = filterItems(items, query);
    const sorted = sortItems(searched, query.sort);
    const total = sorted.length;
    const pageCount = Math.ceil(total / query.pageSize);
    const page = Math.min(Math.max(query.page, 1), pageCount || 1);
    return { items: sorted.slice((page - 1) * query.pageSize, page * query.pageSize), groups, page, pageSize: query.pageSize, total, pageCount };
  }

  async getOffer(customerInput: string, salesArea: SalesArea, product: string): Promise<CatalogItem> {
    const customer = normalizeCustomer(customerInput);
    const response = await this.client.getAt<ODataResults<PriceValidity>>(this.config.services.pricing, "/A_SlsPrcgCndnRecdValidity", {
      "$filter": priceFilter(customer, salesArea, product.padStart(18, "0")),
      "$expand": "to_SlsPrcgConditionRecord",
      "$top": 20,
    });
    const price = (response.data.results ?? []).filter((row) => matchesScope(row, customer, salesArea)).map((row) => currentA305Price(row, this.clock())).filter((value): value is CurrentPrice => Boolean(value))
      .reduce<CurrentPrice | undefined>((selected, candidate) => preferPrice(selected, candidate), undefined);
    if (!price) throw new Error("This product has no current ZR01 price in condition table A305 and cannot be ordered.");
    return toCatalogItem(price, await getProductDetails(this.client, this.config, price.material));
  }

  private async listCurrentPrices(customer: string, salesArea: SalesArea): Promise<Map<string, CurrentPrice>> {
    const prices = new Map<string, CurrentPrice>();
    const now = this.clock();
    for (let offset = 0; ; offset += 200) {
      const response = await this.client.getAt<ODataResults<PriceValidity>>(this.config.services.pricing, "/A_SlsPrcgCndnRecdValidity", {
        "$filter": priceFilter(customer, salesArea),
        "$select": "Customer,SalesOrganization,DistributionChannel,Material,ConditionRecord,ConditionType,ConditionValidityStartDate,ConditionValidityEndDate",
        "$expand": "to_SlsPrcgConditionRecord",
        "$top": 200,
        "$skip": offset,
      });
      const rows = response.data.results ?? [];
      for (const row of rows) {
        const candidate = matchesScope(row, customer, salesArea) ? currentA305Price(row, now) : undefined;
        if (candidate) prices.set(candidate.material, preferPrice(prices.get(candidate.material), candidate));
      }
      if (rows.length < 200) return prices;
    }
  }
}

function priceFilter(customer: string, salesArea: SalesArea, material?: string): string {
  const predicates = [
    "ConditionType eq 'ZR01'",
    `Customer eq '${odataKey(customer)}'`,
    `SalesOrganization eq '${odataKey(salesArea.salesOrganization)}'`,
    `DistributionChannel eq '${odataKey(salesArea.distributionChannel)}'`,
  ];
  if (material) predicates.push(`Material eq '${odataKey(material)}'`);
  return predicates.join(" and ");
}

function matchesScope(row: PriceValidity, customer: string, salesArea: SalesArea): boolean {
  return row.Customer === customer
    && row.SalesOrganization === salesArea.salesOrganization
    && row.DistributionChannel === salesArea.distributionChannel;
}

function toCatalogItem(price: CurrentPrice, detail: ProductDetails): CatalogItem {
  return { product: detail.product, description: detail.description, productGroup: detail.productGroup, baseUnit: detail.baseUnit, conditionRecord: price.conditionRecord, unitPrice: price.unitPrice, currency: price.currency, priceUnit: price.priceUnit };
}

function groupCounts(items: CatalogItem[]): CatalogPage["groups"] {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.productGroup, (counts.get(item.productGroup) ?? 0) + 1);
  return [...counts.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([code, count]) => ({ code, label: code === "UNCLASSIFIED" ? "未分类" : code, count }));
}

function filterItems(items: CatalogItem[], query: CatalogQuery): CatalogItem[] {
  const search = query.query?.trim().toLowerCase();
  return items.filter((item) => (!query.group || item.productGroup === query.group) && (!search || item.product.toLowerCase().includes(search) || item.description.toLowerCase().includes(search)));
}

function sortItems(items: CatalogItem[], sort: CatalogQuery["sort"]): CatalogItem[] {
  return [...items].sort((left, right) => sort === "price" ? Number(left.unitPrice) - Number(right.unitPrice) || left.product.localeCompare(right.product) : left.product.localeCompare(right.product));
}

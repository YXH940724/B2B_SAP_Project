import type { SapConfig } from "./config.js";
import { normalizeCustomer, odataKey } from "./master-data.js";
import { SapODataClient } from "./odata-client.js";

type ODataResults<T> = { results?: T[] };

interface CustomerSalesArea {
  SalesOrganization?: string;
  DistributionChannel?: string;
  Division?: string;
}

export interface SalesArea {
  salesOrganization: string;
  distributionChannel: string;
  division: string;
  key: string;
}

export function salesAreaKey(area: Omit<SalesArea, "key">): string {
  return `${area.salesOrganization}/${area.distributionChannel}/${area.division}`;
}

function toSalesArea(row: CustomerSalesArea): SalesArea | undefined {
  const salesOrganization = row.SalesOrganization?.trim();
  const distributionChannel = row.DistributionChannel?.trim();
  const division = row.Division?.trim() || "00";
  if (!salesOrganization || !distributionChannel) return undefined;
  return { salesOrganization, distributionChannel, division, key: salesAreaKey({ salesOrganization, distributionChannel, division }) };
}

export async function listCustomerSalesAreas(client: SapODataClient, config: SapConfig, customerInput: string): Promise<SalesArea[]> {
  const customer = normalizeCustomer(customerInput);
  const response = await client.getAt<ODataResults<CustomerSalesArea>>(config.services.businessPartner, "/A_CustomerSalesArea", {
    "$filter": `Customer eq '${odataKey(customer)}'`,
    "$select": "SalesOrganization,DistributionChannel,Division",
    "$top": 100,
  });
  const areas = new Map<string, SalesArea>();
  for (const row of response.data.results ?? []) {
    const area = toSalesArea(row);
    if (area) areas.set(area.key, area);
  }
  return [...areas.values()].sort((left, right) => left.key.localeCompare(right.key));
}

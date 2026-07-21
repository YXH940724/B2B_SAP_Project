import type { SapConfig } from "./config.js";
import { normalizeCustomer, odataKey } from "./master-data.js";
import type { SapODataClient } from "./odata-client.js";
import type { SalesArea } from "./sales-areas.js";

type Results<T> = { results?: T[] };

export type OrderDefaults = {
  paymentTerms?: string;
  incotermsClassification?: string;
  incotermsVersion?: string;
  incotermsLocation?: string;
  incotermsLocation1?: string;
  incotermsLocation2?: string;
};

type CustomerSalesAreaDefaults = {
  CustomerPaymentTerms?: string;
  IncotermsClassification?: string;
  IncotermsVersion?: string;
  IncotermsTransferLocation?: string;
  IncotermsLocation1?: string;
  IncotermsLocation2?: string;
};

function optional(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

export async function getOrderDefaults(client: SapODataClient, config: SapConfig, customerInput: string, salesArea: SalesArea): Promise<OrderDefaults> {
  const customer = normalizeCustomer(customerInput);
  const response = await client.getAt<Results<CustomerSalesAreaDefaults>>(config.services.businessPartner, "/A_CustomerSalesArea", {
    "$filter": `Customer eq '${odataKey(customer)}' and SalesOrganization eq '${odataKey(salesArea.salesOrganization)}' and DistributionChannel eq '${odataKey(salesArea.distributionChannel)}' and Division eq '${odataKey(salesArea.division)}'`,
    "$select": "CustomerPaymentTerms,IncotermsClassification,IncotermsVersion,IncotermsTransferLocation,IncotermsLocation1,IncotermsLocation2",
    "$top": 1,
  });
  const row = response.data.results?.[0] ?? {};
  return {
    paymentTerms: optional(row.CustomerPaymentTerms),
    incotermsClassification: optional(row.IncotermsClassification),
    incotermsVersion: optional(row.IncotermsVersion),
    incotermsLocation: optional(row.IncotermsTransferLocation),
    incotermsLocation1: optional(row.IncotermsLocation1),
    incotermsLocation2: optional(row.IncotermsLocation2),
  };
}

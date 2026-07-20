import type { SapConfig } from "./config.js";
import { normalizeCustomer, odataKey } from "./master-data.js";
import { SapODataClient } from "./odata-client.js";

interface CustomerIdentity {
  Customer?: string;
}

interface CustomerBusinessPartners {
  results?: Array<{ BusinessPartner?: string }>;
}

interface BusinessPartnerAddresses {
  results?: Array<{ to_EmailAddress?: { results?: Array<{ EmailAddress?: string }> } }>;
}

export async function getCustomerRegistrationContact(client: SapODataClient, config: SapConfig, customerInput: string): Promise<{ customer: string; email: string }> {
  const customer = normalizeCustomer(customerInput);
  const identity = await client.getAt<CustomerIdentity>(config.services.businessPartner, `/A_Customer('${odataKey(customer)}')`, {
    "$select": "Customer",
  });
  const mappings = await client.getAt<CustomerBusinessPartners>(config.services.businessPartner, "/A_BusinessPartner", {
    "$filter": `Customer eq '${odataKey(identity.data.Customer ?? customer)}'`,
    "$select": "BusinessPartner,Customer",
    "$top": 1,
  });
  const businessPartner = mappings.data.results?.[0]?.BusinessPartner?.trim();
  if (!businessPartner) throw new Error("该客户未关联业务伙伴，暂不支持自助注册。");
  const addresses = await client.getAt<BusinessPartnerAddresses>(config.services.businessPartner, "/A_BusinessPartnerAddress", {
    "$filter": `BusinessPartner eq '${odataKey(businessPartner)}'`,
    "$expand": "to_EmailAddress",
    "$top": 1,
  });
  const email = addresses.data.results?.flatMap((address) => address.to_EmailAddress?.results ?? [])
    .map((address) => address.EmailAddress?.trim()).find((value): value is string => Boolean(value));
  if (!email) throw new Error("该客户未维护可用邮箱，暂不支持自助注册。");
  return { customer: normalizeCustomer(identity.data.Customer ?? customer), email };
}

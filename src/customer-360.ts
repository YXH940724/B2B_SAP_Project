import type { SapConfig } from "./config.js";
import { getCustomerPortalProfile } from "./customer-contact.js";
import { normalizeCustomer, odataKey } from "./master-data.js";
import { SapODataClient } from "./odata-client.js";
import { listCustomerSalesAreas, type SalesArea } from "./sales-areas.js";

type Results<T> = { results?: T[] };

export interface Customer360Profile {
  customer: string; name: string; businessPartner: string; accountGroup: string;
  addresses: Array<{ street: string; city: string; postalCode: string; country: string }>;
  phones: string[]; emails: string[];
  banks: Array<{ bankName: string; bankCountry: string; account: string; iban: string }>;
  salesAreas: SalesArea[];
}

export async function getCustomer360(client: SapODataClient, config: SapConfig, customerInput: string): Promise<Customer360Profile> {
  const profile = await getCustomerPortalProfile(client, config, customerInput);
  const partner = odataKey(profile.businessPartner);
  const [addresses, banks, salesAreas] = await Promise.all([
    client.getAt<Results<{ StreetName?: string; CityName?: string; PostalCode?: string; Country?: string; to_EmailAddress?: Results<{ EmailAddress?: string }>; to_PhoneNumber?: Results<{ PhoneNumber?: string }> }>>(config.services.businessPartner, "/A_BusinessPartnerAddress", { "$filter": `BusinessPartner eq '${partner}'`, "$expand": "to_EmailAddress,to_PhoneNumber", "$top": 20 }),
    client.getAt<Results<{ BankName?: string; BankCountryKey?: string; BankAccount?: string; IBAN?: string }>>(config.services.businessPartner, "/A_BusinessPartnerBank", { "$filter": `BusinessPartner eq '${partner}'`, "$top": 20 }),
    listCustomerSalesAreas(client, config, normalizeCustomer(customerInput)),
  ]);
  const rows = addresses.data.results ?? [];
  return {
    ...profile,
    addresses: rows.map((row) => ({ street: row.StreetName?.trim() || "", city: row.CityName?.trim() || "", postalCode: row.PostalCode?.trim() || "", country: row.Country?.trim() || "" })),
    phones: rows.flatMap((row) => row.to_PhoneNumber?.results ?? []).map((row) => row.PhoneNumber?.trim()).filter((value): value is string => Boolean(value)),
    emails: rows.flatMap((row) => row.to_EmailAddress?.results ?? []).map((row) => row.EmailAddress?.trim()).filter((value): value is string => Boolean(value)),
    banks: (banks.data.results ?? []).map((row) => ({ bankName: row.BankName?.trim() || "", bankCountry: row.BankCountryKey?.trim() || "", account: row.BankAccount?.trim() || "", iban: row.IBAN?.trim() || "" })),
    salesAreas,
  };
}

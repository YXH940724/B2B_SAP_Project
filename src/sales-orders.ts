import { z } from "zod";
import type { SapConfig } from "./config.js";
import { SapODataClient } from "./odata-client.js";

export const SalesOrderId = z.string().regex(/^\d{1,10}$/, "sales_order must contain 1 to 10 digits.");
export const ResponseFormat = z.enum(["markdown", "json"]).default("markdown");

const ItemSchema = z.object({
  material: z.string().min(1).max(40),
  requested_quantity: z.number().positive(),
  requested_quantity_unit: z.string().min(1).max(3),
  plant: z.string().min(1).max(4).optional(),
}).strict();

export const CreateSalesOrderSchema = z.object({
  sales_order_type: z.string().min(1).max(4),
  sales_organization: z.string().min(1).max(4),
  distribution_channel: z.string().min(1).max(2),
  organization_division: z.string().min(1).max(2),
  sold_to_party: z.string().min(1).max(10),
  purchase_order_by_customer: z.string().min(1).max(35).optional(),
  items: z.array(ItemSchema).min(1).max(100),
  dry_run: z.boolean().default(true),
  confirm: z.literal("CREATE_SALES_ORDER").optional(),
  response_format: ResponseFormat,
}).strict();

export const UpdateSalesOrderSchema = z.object({
  sales_order: SalesOrderId,
  changes: z.record(z.union([z.string().max(100), z.number(), z.boolean(), z.null()])),
  etag: z.string().min(1),
  dry_run: z.boolean().default(true),
  confirm: z.literal("UPDATE_SALES_ORDER").optional(),
  response_format: ResponseFormat,
}).strict();

export type CreateSalesOrderInput = z.infer<typeof CreateSalesOrderSchema>;
export type UpdateSalesOrderInput = z.infer<typeof UpdateSalesOrderSchema>;

export function normalizeSalesOrder(id: string): string {
  return id.padStart(10, "0");
}

export function salesOrderPath(id: string): string {
  return `/A_SalesOrder('${normalizeSalesOrder(id)}')`;
}

export function createPayload(input: CreateSalesOrderInput): Record<string, unknown> {
  return {
    SalesOrderType: input.sales_order_type,
    SalesOrganization: input.sales_organization,
    DistributionChannel: input.distribution_channel,
    OrganizationDivision: input.organization_division,
    SoldToParty: input.sold_to_party,
    ...(input.purchase_order_by_customer ? { PurchaseOrderByCustomer: input.purchase_order_by_customer } : {}),
    to_Item: { results: input.items.map((item) => ({
      Material: item.material,
      RequestedQuantity: String(item.requested_quantity),
      RequestedQuantityUnit: item.requested_quantity_unit,
      ...(item.plant ? { Plant: item.plant } : {}),
    })) },
  };
}

export function assertWriteAllowed(config: SapConfig, confirm: string | undefined, expectedConfirm: string, changes?: Record<string, unknown>): void {
  if (!config.writeEnabled) throw new Error("SAP writes are disabled. Set SAP_WRITE_ENABLED=true only after change approval.");
  if (confirm !== expectedConfirm) throw new Error(`Set confirm to ${expectedConfirm} only after reviewing the requested SAP change.`);
  if (changes) {
    const disallowed = Object.keys(changes).filter((field) => !config.writeAllowedFields.has(field));
    if (disallowed.length) throw new Error(`These fields are not allowed for SAP updates: ${disallowed.join(", ")}. Update SAP_WRITE_ALLOWED_FIELDS after approval.`);
  }
}

export async function getSalesOrder(client: SapODataClient, id: string): Promise<{ order: unknown; etag?: string }> {
  const response = await client.get<unknown>(salesOrderPath(id), {
    "$select": "SalesOrder,SalesOrderType,SalesOrganization,SoldToParty,PurchaseOrderByCustomer,SalesOrderDate,TotalNetAmount,TransactionCurrency,OverallSDProcessStatus,OverallDeliveryStatus,OverallOrdReltdBillgStatus",
  });
  return { order: response.data, etag: response.etag };
}

export async function getSalesOrderItems(client: SapODataClient, id: string, limit: number): Promise<unknown> {
  const response = await client.get<unknown>(`${salesOrderPath(id)}/to_Item`, {
    "$top": limit,
    "$select": "SalesOrder,SalesOrderItem,Material,RequestedQuantity,RequestedQuantityUnit,NetAmount,TransactionCurrency,OverallDeliveryStatus",
  });
  return response.data;
}

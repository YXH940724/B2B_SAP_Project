import { normalizeCustomer } from "./master-data.js";

interface ODataReader {
  get<T>(path: string, params?: Record<string, string | number | undefined>): Promise<{ data: T }>;
}

export interface OrderHistoryItem {
  salesOrder: string;
  createdAt: string;
  salesOrganization: string;
  total: number;
  currency: string;
  status: string;
  source: "sap";
}

export interface OrderDashboard {
  orderCount: number;
  totalAmount: number;
  currency: string;
  months: Array<{ month: string; orderCount: number; totalAmount: number }>;
}

export interface CustomerOrderHistory {
  sapOrders: OrderHistoryItem[];
  dashboard: OrderDashboard;
}

function rows(value: unknown): Array<Record<string, unknown>> {
  if (typeof value !== "object" || value === null) return [];
  const results = (value as { results?: unknown }).results;
  return Array.isArray(results) ? results.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null) : [];
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : value === undefined || value === null ? "" : String(value);
}

function amount(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function createdAt(value: unknown): string {
  const raw = text(value);
  const milliseconds = raw.match(/^\/Date\((\d+)\)\/$/);
  if (milliseconds) return new Date(Number(milliseconds[1])).toISOString().slice(0, 10);
  const parsed = new Date(raw);
  return Number.isNaN(parsed.valueOf()) ? "" : parsed.toISOString().slice(0, 10);
}

function twelveMonths(now: Date): string[] {
  return Array.from({ length: 12 }, (_, index) => {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11 + index, 1));
    return date.toISOString().slice(0, 7);
  });
}

export class OrderHistoryService {
  constructor(private readonly client: ODataReader, private readonly now: () => Date = () => new Date()) {}

  async list(customerInput: string): Promise<CustomerOrderHistory> {
    const customer = normalizeCustomer(customerInput);
    const start = twelveMonths(this.now())[0];
    const response = await this.client.get<unknown>("/A_SalesOrder", {
      "$filter": `SoldToParty eq '${customer}'`,
      "$orderby": "CreationDate desc",
      "$top": 200,
    });
    const sapOrders = rows(response.data)
      .filter((row) => {
        const soldToParty = text(row.SoldToParty);
        return Boolean(soldToParty) && normalizeCustomer(soldToParty) === customer;
      })
      .map((row): OrderHistoryItem => ({
        salesOrder: text(row.SalesOrder),
        createdAt: createdAt(row.CreationDate),
        salesOrganization: text(row.SalesOrganization),
        total: amount(row.TotalNetAmount),
        currency: text(row.TransactionCurrency),
        status: text(row.OverallSDProcessStatus) || "SAP 已创建",
        source: "sap",
      }))
      .filter((item) => item.salesOrder && item.createdAt >= `${start}-01`);
    return { sapOrders, dashboard: this.dashboard(sapOrders) };
  }

  private dashboard(orders: OrderHistoryItem[]): OrderDashboard {
    const months = twelveMonths(this.now()).map((month) => ({ month, orderCount: 0, totalAmount: 0 }));
    const byMonth = new Map(months.map((month) => [month.month, month]));
    orders.forEach((order) => {
      const month = byMonth.get(order.createdAt.slice(0, 7));
      if (!month) return;
      month.orderCount += 1;
      month.totalAmount += order.total;
    });
    return {
      orderCount: orders.length,
      totalAmount: orders.reduce((sum, order) => sum + order.total, 0),
      currency: orders.find((order) => order.currency)?.currency || "",
      months,
    };
  }
}

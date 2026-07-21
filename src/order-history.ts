import { normalizeCustomer } from "./master-data.js";

interface ODataReader {
  get<T>(path: string, params?: Record<string, string | number | undefined>): Promise<{ data: T }>;
}

export type OrderStatus = { code: string; label: string; tone: "success" | "warning" | "danger" | "neutral" };

export type OrderQuery = {
  page: number;
  pageSize: 10 | 20 | 50;
  from?: string;
  to?: string;
  salesOrganization?: string;
  overallStatus?: string;
  deliveryStatus?: string;
  query?: string;
  sort: "createdAt:desc" | "createdAt:asc" | "total:desc" | "total:asc";
};

export type OrderSummary = {
  salesOrder: string;
  salesOrderType: string;
  createdAt: string;
  salesOrganization: string;
  distributionChannel: string;
  division: string;
  purchaseOrderByCustomer: string;
  total: number;
  currency: string;
  overallStatus: OrderStatus;
  deliveryStatus: OrderStatus;
  billingStatus: OrderStatus;
};

export type OrderDashboard = {
  orderCount: number;
  totalAmount: number;
  averageAmount: number;
  currency: string;
  inFulfillmentCount: number;
  months: Array<{ month: string; orderCount: number; totalAmount: number }>;
  statuses: Array<{ status: OrderStatus; count: number }>;
};

export type OrderInsights = {
  topSalesOrganizations: Array<{ salesOrganization: string; orderCount: number; totalAmount: number; currency: string }>;
  largestOrder: OrderSummary | null;
  latestOrderDate: string;
  attentionCount: number;
};

export type PaginatedOrderHistory = {
  items: OrderSummary[];
  page: number;
  pageSize: number;
  total: number;
  pageCount: number;
  dashboard: OrderDashboard;
  insights: OrderInsights;
};

export type OrderDetail = {
  header: OrderSummary & { requestedDeliveryDate: string; customerPurchaseOrderDate: string; createdByUser: string };
  items: Array<{ item: string; material: string; description: string; quantity: number; unit: string; netPrice: number; netAmount: number; currency: string; deliveryStatus: OrderStatus }>;
};

export type OrderHistoryErrorCode = "ORDER_NOT_FOUND" | "SAP_READ_FAILED";

/** A safe, route-ready error contract for order-history reads. */
export class OrderHistoryError extends Error {
  constructor(readonly code: OrderHistoryErrorCode, readonly httpStatus: 404 | 502, message: string) {
    super(message);
    this.name = "OrderHistoryError";
  }
}

/** @deprecated Use PaginatedOrderHistory. */
export type CustomerOrderHistory = PaginatedOrderHistory;

const STATUS: Record<string, OrderStatus> = {
  A: { code: "A", label: "未处理", tone: "neutral" },
  B: { code: "B", label: "处理中", tone: "warning" },
  C: { code: "C", label: "已完成", tone: "success" },
};

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

function status(value: unknown): OrderStatus {
  const code = text(value);
  return STATUS[code] ?? { code, label: code ? `SAP 状态 ${code}` : "SAP 未维护", tone: "neutral" };
}

function normalizeQuery(input: Partial<OrderQuery>): OrderQuery {
  const page = Number(input.page ?? 1);
  const pageSize = Number(input.pageSize ?? 20);
  if (!Number.isInteger(page) || page < 1) throw new Error("页码必须为正整数。");
  if (![10, 20, 50].includes(pageSize)) throw new Error("每页条数仅支持 10、20 或 50。");
  const sort = input.sort ?? "createdAt:desc";
  if (!(["createdAt:desc", "createdAt:asc", "total:desc", "total:asc"] as const).includes(sort)) throw new Error("排序方式无效。");
  return {
    page,
    pageSize: pageSize as 10 | 20 | 50,
    from: input.from,
    to: input.to,
    salesOrganization: input.salesOrganization,
    overallStatus: input.overallStatus,
    deliveryStatus: input.deliveryStatus,
    query: input.query?.trim(),
    sort,
  };
}

function normalizeSalesOrder(input: string): string {
  const salesOrder = input.trim();
  if (!/^\d{1,10}$/.test(salesOrder)) throw new Error("订单号无效。");
  return salesOrder.padStart(10, "0");
}

function errorStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

function orderNotFound(): OrderHistoryError {
  return new OrderHistoryError("ORDER_NOT_FOUND", 404, "订单不存在。");
}

function sapReadFailed(): OrderHistoryError {
  return new OrderHistoryError("SAP_READ_FAILED", 502, "暂时无法读取订单数据，请稍后重试。");
}

async function readOrderData<T>(operation: () => Promise<T>, missingOn404 = false): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (missingOn404 && errorStatus(error) === 404) throw orderNotFound();
    throw sapReadFailed();
  }
}

function toOrderSummary(row: Record<string, unknown>): OrderSummary {
  return {
    salesOrder: text(row.SalesOrder),
    salesOrderType: text(row.SalesOrderType),
    createdAt: createdAt(row.CreationDate),
    salesOrganization: text(row.SalesOrganization),
    distributionChannel: text(row.DistributionChannel),
    division: text(row.OrganizationDivision),
    purchaseOrderByCustomer: text(row.PurchaseOrderByCustomer),
    total: amount(row.TotalNetAmount),
    currency: text(row.TransactionCurrency),
    overallStatus: status(row.OverallSDProcessStatus),
    deliveryStatus: status(row.OverallDeliveryStatus),
    billingStatus: status(row.OverallOrdReltdBillgStatus),
  };
}

function matchesTwelveMonthsAndQuery(order: OrderSummary, query: OrderQuery, now: Date): boolean {
  const start = twelveMonths(now)[0];
  const minimumDate = query.from || `${start}-01`;
  const haystack = `${order.salesOrder} ${order.purchaseOrderByCustomer}`.toLowerCase();
  return order.createdAt >= minimumDate && (!query.to || order.createdAt <= query.to)
    && (!query.salesOrganization || order.salesOrganization === query.salesOrganization)
    && (!query.overallStatus || order.overallStatus.code === query.overallStatus)
    && (!query.deliveryStatus || order.deliveryStatus.code === query.deliveryStatus)
    && (!query.query || haystack.includes(query.query.toLowerCase()));
}

function sortOrders(orders: OrderSummary[], sort: OrderQuery["sort"]): OrderSummary[] {
  const multiplier = sort.endsWith(":asc") ? 1 : -1;
  const value = (order: OrderSummary): number | string => sort.startsWith("total") ? order.total : order.createdAt;
  return [...orders].sort((left, right) => value(left) < value(right) ? -multiplier : value(left) > value(right) ? multiplier : 0);
}

function dashboard(orders: OrderSummary[], now: Date): OrderDashboard {
  const months = twelveMonths(now).map((month) => ({ month, orderCount: 0, totalAmount: 0 }));
  const byMonth = new Map(months.map((month) => [month.month, month]));
  const statuses = new Map<string, { status: OrderStatus; count: number }>();
  let totalAmount = 0;
  let inFulfillmentCount = 0;
  orders.forEach((order) => {
    totalAmount += order.total;
    const month = byMonth.get(order.createdAt.slice(0, 7));
    if (month) {
      month.orderCount += 1;
      month.totalAmount += order.total;
    }
    const current = statuses.get(order.overallStatus.code);
    if (current) current.count += 1;
    else statuses.set(order.overallStatus.code, { status: order.overallStatus, count: 1 });
    if (order.deliveryStatus.code === "B") inFulfillmentCount += 1;
  });
  return {
    orderCount: orders.length,
    totalAmount,
    averageAmount: orders.length ? totalAmount / orders.length : 0,
    currency: orders.find((order) => order.currency)?.currency || "",
    inFulfillmentCount,
    months,
    statuses: [...statuses.values()].sort((left, right) => right.count - left.count || left.status.code.localeCompare(right.status.code)),
  };
}

function insights(orders: OrderSummary[]): OrderInsights {
  const salesOrganizations = new Map<string, { salesOrganization: string; orderCount: number; totalAmount: number; currency: string }>();
  orders.forEach((order) => {
    const current = salesOrganizations.get(order.salesOrganization);
    if (current) {
      current.orderCount += 1;
      current.totalAmount += order.total;
    } else {
      salesOrganizations.set(order.salesOrganization, {
        salesOrganization: order.salesOrganization,
        orderCount: 1,
        totalAmount: order.total,
        currency: order.currency,
      });
    }
  });
  return {
    topSalesOrganizations: [...salesOrganizations.values()].sort((left, right) => right.totalAmount - left.totalAmount || left.salesOrganization.localeCompare(right.salesOrganization)).slice(0, 5),
    largestOrder: orders.reduce<OrderSummary | null>((largest, order) => !largest || order.total > largest.total ? order : largest, null),
    latestOrderDate: orders.reduce((latest, order) => order.createdAt > latest ? order.createdAt : latest, ""),
    attentionCount: orders.filter((order) => order.overallStatus.code !== "C").length,
  };
}

function toDetailHeader(row: Record<string, unknown>): OrderDetail["header"] {
  return {
    ...toOrderSummary(row),
    requestedDeliveryDate: createdAt(row.RequestedDeliveryDate),
    customerPurchaseOrderDate: createdAt(row.CustomerPurchaseOrderDate),
    createdByUser: text(row.CreatedByUser),
  };
}

function toOrderLine(row: Record<string, unknown>): OrderDetail["items"][number] {
  return {
    item: text(row.SalesOrderItem),
    material: text(row.Material),
    description: text(row.SalesOrderItemText),
    quantity: amount(row.RequestedQuantity),
    unit: text(row.RequestedQuantityUnit) || text(row.OrderQuantityUnit),
    netPrice: amount(row.NetPriceAmount),
    netAmount: amount(row.NetAmount),
    currency: text(row.TransactionCurrency),
    deliveryStatus: status(row.OverallDeliveryStatus),
  };
}

export class OrderHistoryService {
  constructor(private readonly client: ODataReader, private readonly now: () => Date = () => new Date()) {}

  async list(customerInput: string, input: Partial<OrderQuery> = {}): Promise<PaginatedOrderHistory> {
    const customer = normalizeCustomer(customerInput);
    const query = normalizeQuery(input);
    const response = await readOrderData(() => this.client.get<unknown>("/A_SalesOrder", {
      "$filter": `SoldToParty eq '${customer}'`,
      "$orderby": "CreationDate desc",
      "$top": 200,
    }));
    const now = this.now();
    const all = rows(response.data)
      .filter((row) => normalizeCustomer(text(row.SoldToParty)) === customer)
      .map(toOrderSummary)
      .filter((order) => matchesTwelveMonthsAndQuery(order, query, now));
    const sorted = sortOrders(all, query.sort);
    const start = (query.page - 1) * query.pageSize;
    return {
      items: sorted.slice(start, start + query.pageSize),
      page: query.page,
      pageSize: query.pageSize,
      total: sorted.length,
      pageCount: Math.ceil(sorted.length / query.pageSize),
      dashboard: dashboard(sorted, now),
      insights: insights(sorted),
    };
  }

  async detail(customerInput: string, salesOrderInput: string): Promise<OrderDetail> {
    const customer = normalizeCustomer(customerInput);
    const salesOrder = normalizeSalesOrder(salesOrderInput);
    const header = await readOrderData(() => this.client.get<Record<string, unknown>>(`/A_SalesOrder('${salesOrder}')`), true);
    if (normalizeCustomer(text(header.data.SoldToParty)) !== customer) throw orderNotFound();
    const lines = await readOrderData(() => this.client.get<unknown>(`/A_SalesOrder('${salesOrder}')/to_Item`));
    return { header: toDetailHeader(header.data), items: rows(lines.data).map(toOrderLine) };
  }
}

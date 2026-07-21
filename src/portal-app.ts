import crypto from "node:crypto";
import express from "express";
import type { AuthService } from "./auth-service.js";
import type { CatalogPage, CatalogQuery } from "./catalog.js";
import type { SapConfig } from "./config.js";
import { normalizeCustomer, type ProductFulfillmentOptions } from "./master-data.js";
import { SapODataClient } from "./odata-client.js";
import { getSellableOffer } from "./portal.js";
import { assertWriteAllowed, PortalCheckoutSchema } from "./sales-orders.js";
import type { MallOrderSubmissionInput, MallOrderSubmissionResult, MallOrderPreview } from "./mall-orders.js";
import type { SalesArea } from "./sales-areas.js";
import type { Customer360Profile } from "./customer-360.js";
import { OrderHistoryError, type CustomerOrderHistory, type OrderDetail, type OrderQuery } from "./order-history.js";
import type { OrderDefaults } from "./order-defaults.js";
import type { VerificationDelivery } from "./verification-delivery.js";

export interface PortalDependencies {
  auth: AuthService;
  contact: { get(customer: string): Promise<{ customer: string; email: string }> };
  delivery: VerificationDelivery;
  order?: { config: SapConfig; client: SapODataClient };
  mallOrders?: {
    prepare(customer: string, groups: PortalCartGroup[]): MallOrderPreview;
    submit(input: MallOrderSubmissionInput): Promise<MallOrderSubmissionResult>;
  };
  catalog?: { list(customer: string, salesArea: SalesArea, query: CatalogQuery, language?: string): Promise<CatalogPage> };
  orderDefaults?: { get(customer: string, salesArea: SalesArea): Promise<OrderDefaults> };
  fulfillment?: { get(product: string): Promise<ProductFulfillmentOptions> };
  salesAreas?: { list(customer: string): Promise<SalesArea[]> };
  customer?: { get(customer: string): Promise<{ customer: string; name: string; accountGroup: string; businessPartner: string }> };
  customer360?: { get(customer: string): Promise<Customer360Profile> };
  orderHistory?: {
    list(customer: string, query: Partial<OrderQuery>): Promise<CustomerOrderHistory>;
    detail(customer: string, salesOrder: string): Promise<OrderDetail>;
  };
  staticRoot?: string;
  production?: boolean;
}

interface Session {
  customer: string;
  expiresAt: number;
}

function customerInput(input: unknown): string {
  const customer = String(input ?? "").trim();
  if (!/^\d{1,10}$/.test(customer)) throw new Error("请输入有效的 SAP 客户号。");
  return normalizeCustomer(customer);
}

function setSessionCookie(res: express.Response, token: string, production: boolean): void {
  res.setHeader("Set-Cookie", `portal_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800${production ? "; Secure" : ""}`);
}

function integerQuery(input: unknown, fallback: number, min: number, max: number): number {
  if (input === undefined || input === "") return fallback;
  const value = Number(input);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error("目录分页参数无效。");
  return value;
}

function catalogQuery(req: express.Request): CatalogQuery {
  const sort = req.query.sort === undefined || req.query.sort === "" ? "material" : String(req.query.sort);
  if (sort !== "material" && sort !== "price") throw new Error("目录排序参数无效。");
  return {
    query: typeof req.query.query === "string" ? req.query.query : undefined,
    group: typeof req.query.group === "string" ? req.query.group : undefined,
    page: integerQuery(req.query.page, 1, 1, 100000),
    pageSize: integerQuery(req.query.pageSize, 20, 1, 50),
    sort,
  };
}

function catalogLanguage(req: express.Request): string {
  const language = String(req.query.language ?? "ZH").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(language)) throw new Error("物料描述语言无效。");
  return language;
}

type SalesAreaSource = { salesOrganization?: unknown; distributionChannel?: unknown; division?: unknown };

function salesAreaInput(source: SalesAreaSource): Omit<SalesArea, "key"> {
  const salesOrganization = typeof source.salesOrganization === "string" ? source.salesOrganization.trim() : "";
  const distributionChannel = typeof source.distributionChannel === "string" ? source.distributionChannel.trim() : "";
  const division = typeof source.division === "string" ? source.division.trim() : "";
  if (!salesOrganization || !distributionChannel || !division) throw new Error("请选择有效的销售范围。");
  return { salesOrganization, distributionChannel, division };
}

export type PortalCartLine = {
  product: string;
  quantity: number;
  customerMaterial?: string;
  productionPlant?: string;
  storageLocation?: string;
  salesOrganization: string;
  distributionChannel: string;
  division: string;
};

export type PortalCartGroup = { salesArea: SalesArea; items: PortalCartLine[] };

export function groupPortalCartLines(lines: PortalCartLine[]): PortalCartGroup[] {
  const groups = new Map<string, PortalCartGroup>();
  lines.forEach((line) => {
    const area = salesAreaInput(line);
    const salesArea: SalesArea = { ...area, key: `${area.salesOrganization}/${area.distributionChannel}/${area.division}` };
    const group = groups.get(salesArea.key) ?? { salesArea, items: [] };
    group.items.push(line);
    groups.set(salesArea.key, group);
  });
  return [...groups.values()];
}

function cartLines(body: unknown): PortalCartLine[] {
  const source = typeof body === "object" && body !== null ? body as Record<string, unknown> : {};
  const items = source.items;
  if (!Array.isArray(items) || !items.length || items.length > 100) throw new Error("请提供 1 至 100 行订单项目。");
  return items.map((item) => {
    const line = typeof item === "object" && item !== null ? item as Record<string, unknown> : {};
    const product = typeof line.product === "string" ? line.product.trim() : "";
    const quantity = Number(line.quantity);
    if (!product) throw new Error("物料不能为空。");
    if (!Number.isFinite(quantity) || quantity <= 0) throw new Error("物料数量必须大于零。");
    return {
      product,
      quantity,
      customerMaterial: optionalText(line.customerMaterial),
      productionPlant: optionalText(line.productionPlant ?? line.plant),
      storageLocation: optionalText(line.storageLocation),
      salesOrganization: String(line.salesOrganization ?? source.salesOrganization ?? "").trim(),
      distributionChannel: String(line.distributionChannel ?? source.distributionChannel ?? "").trim(),
      division: String(line.division ?? source.division ?? "").trim(),
    };
  });
}

function optionalText(input: unknown): string | undefined {
  const value = typeof input === "string" ? input.trim() : "";
  return value || undefined;
}

function stringQuery(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberQuery(value: unknown): number | undefined {
  const parsed = Number(stringQuery(value));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function orderHistoryQuery(req: express.Request): Partial<OrderQuery> {
  return {
    page: numberQuery(req.query.page),
    pageSize: numberQuery(req.query.pageSize) as OrderQuery["pageSize"] | undefined,
    from: stringQuery(req.query.from),
    to: stringQuery(req.query.to),
    salesOrganization: stringQuery(req.query.salesOrganization),
    distributionChannel: stringQuery(req.query.distributionChannel),
    division: stringQuery(req.query.division),
    overallStatus: stringQuery(req.query.overallStatus),
    deliveryStatus: stringQuery(req.query.deliveryStatus),
    query: stringQuery(req.query.query),
    sort: stringQuery(req.query.sort) as OrderQuery["sort"] | undefined,
  };
}

function checkoutFields(body: unknown): { requested_delivery_date?: string; purchase_order_by_customer?: string; portal_note?: string; customer_payment_terms?: string; incoterms_classification?: string; incoterms_location?: string } {
  const source = body as { requestedDeliveryDate?: unknown; purchaseOrderByCustomer?: unknown; note?: unknown; customerPaymentTerms?: unknown; incotermsClassification?: unknown; incotermsLocation?: unknown } | undefined;
  const parsed = PortalCheckoutSchema.safeParse({
    requested_delivery_date: optionalText(source?.requestedDeliveryDate),
    purchase_order_by_customer: optionalText(source?.purchaseOrderByCustomer),
    portal_note: optionalText(source?.note),
    customer_payment_terms: optionalText(source?.customerPaymentTerms),
    incoterms_classification: optionalText(source?.incotermsClassification),
    incoterms_location: optionalText(source?.incotermsLocation),
  });
  if (parsed.success) return parsed.data;
  if (parsed.error.issues.some((issue) => issue.path[0] === "requested_delivery_date")) throw new Error("期望交货日期格式无效。");
  if (parsed.error.issues.some((issue) => issue.path[0] === "purchase_order_by_customer")) throw new Error("客户采购订单号无效。");
  if (parsed.error.issues.some((issue) => issue.path[0] === "customer_payment_terms")) throw new Error("付款条款无效。");
  if (parsed.error.issues.some((issue) => String(issue.path[0]).startsWith("incoterms_"))) throw new Error("国际贸易条款无效。");
  throw new Error("订单备注无效。");
}

export function createPortalApp(deps: PortalDependencies): express.Express {
  const app = express();
  const sessions = new Map<string, Session>();
  const production = deps.production ?? process.env.NODE_ENV === "production";
  app.use(express.json({ limit: "100kb" }));
  if (deps.staticRoot) app.use(express.static(deps.staticRoot));

  function session(req: express.Request): { customer: string } {
    const token = req.headers.cookie?.match(/(?:^|; )portal_session=([^;]+)/)?.[1];
    const value = token ? sessions.get(token) : undefined;
    if (!value || value.expiresAt < Date.now()) throw new Error("请重新登录。");
    return { customer: value.customer };
  }

  function orderDependencies(): { config: SapConfig; client: SapODataClient } {
    if (!deps.order) throw new Error("下单服务尚未配置。");
    return deps.order;
  }

  function mallOrderDependencies(): NonNullable<PortalDependencies["mallOrders"]> {
    if (!deps.mallOrders) throw new Error("商城订单服务尚未配置。");
    return deps.mallOrders;
  }

  function catalogDependencies(): NonNullable<PortalDependencies["catalog"]> {
    if (!deps.catalog) throw new Error("商品目录服务尚未配置。");
    return deps.catalog;
  }

  function orderDefaultsDependencies(): NonNullable<PortalDependencies["orderDefaults"]> {
    if (!deps.orderDefaults) throw new Error("订单默认值服务尚未配置。");
    return deps.orderDefaults;
  }

  function fulfillmentDependencies(): NonNullable<PortalDependencies["fulfillment"]> {
    if (!deps.fulfillment) throw new Error("物料履约主数据服务尚未配置。");
    return deps.fulfillment;
  }

  function customerDependencies(): NonNullable<PortalDependencies["customer"]> {
    if (!deps.customer) throw new Error("客户摘要服务尚未配置。");
    return deps.customer;
  }

  function customer360Dependencies(): NonNullable<PortalDependencies["customer360"]> {
    if (!deps.customer360) throw new Error("客户 360 服务尚未配置。");
    return deps.customer360;
  }

  function salesAreaDependencies(): NonNullable<PortalDependencies["salesAreas"]> {
    if (!deps.salesAreas) throw new Error("客户销售范围服务尚未配置。");
    return deps.salesAreas;
  }

  function orderHistoryDependencies(): NonNullable<PortalDependencies["orderHistory"]> {
    if (!deps.orderHistory) throw new Error("订单中心服务尚未配置。");
    return deps.orderHistory;
  }

  async function selectedSalesArea(customer: string, source: SalesAreaSource): Promise<SalesArea> {
    const requested = salesAreaInput(source);
    const areas = await salesAreaDependencies().list(customer);
    const area = areas.find((candidate) => candidate.salesOrganization === requested.salesOrganization
      && candidate.distributionChannel === requested.distributionChannel && candidate.division === requested.division);
    if (!area) throw new Error("所选销售范围不属于当前客户。");
    return area;
  }

  async function selectedCartGroups(customer: string, body: unknown): Promise<PortalCartGroup[]> {
    return Promise.all(groupPortalCartLines(cartLines(body)).map(async (group) => ({
      ...group,
      salesArea: await selectedSalesArea(customer, group.salesArea),
    })));
  }

  async function priceOrderGroup(customer: string, group: PortalCartGroup): Promise<{
    salesArea: SalesArea;
    items: Array<{ productId: string; quantity: number; unitPrice: string; currency: string; priceUnit: string; lineTotal: number; customerMaterial?: string; productionPlant?: string; storageLocation?: string; taxRate: null; taxAmount: null; taxStatus: string }>;
    totalsByCurrency: Array<{ currency: string; total: number }>;
  }> {
    const { client, config } = orderDependencies();
    const items = await Promise.all(group.items.map(async (item) => {
      const offer = await getSellableOffer(client, config, customer, group.salesArea, item.product);
      return { productId: item.product, quantity: item.quantity, unitPrice: offer.unitPrice, currency: offer.currency, priceUnit: offer.priceUnit, lineTotal: Number(offer.unitPrice) * item.quantity, customerMaterial: item.customerMaterial, productionPlant: item.productionPlant, storageLocation: item.storageLocation, taxRate: null, taxAmount: null, taxStatus: "SAP 定价后确认" };
    }));
    const totals = new Map<string, number>();
    items.forEach((item) => totals.set(item.currency, (totals.get(item.currency) ?? 0) + item.lineTotal));
    return { salesArea: group.salesArea, items, totalsByCurrency: [...totals.entries()].map(([currency, total]) => ({ currency, total })) };
  }

  function respondRouteError(res: express.Response, error: unknown): void {
    const message = error instanceof Error ? error.message : "请求失败。";
    const status = error instanceof OrderHistoryError ? error.httpStatus : message === "请重新登录。" ? 401 : 400;
    res.status(status).json({ error: message });
  }

  app.post("/api/register/request-code", async (req, res) => {
    try {
      const contact = await deps.contact.get(customerInput(req.body?.customer));
      const issued = await deps.auth.requestCode(contact.customer);
      await deps.delivery.send(contact.customer, issued.code);
      res.status(202).json({ message: "如客户资料已维护邮箱，验证码已发送。" });
    } catch (error) {
      if (!production) console.error(`[portal] registration request failed: ${error instanceof Error ? error.message : "unknown error"}`);
      res.status(400).json({ error: "无法提交注册请求，请确认客户号并稍后重试。" });
    }
  });

  app.post("/api/register/verify", async (req, res) => {
    try {
      await deps.auth.completeRegistration(customerInput(req.body?.customer), String(req.body?.code ?? ""), String(req.body?.password ?? ""));
      res.status(201).json({ message: "注册成功，请使用新密码登录。" });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "注册失败。" });
    }
  });

  app.post("/api/login", async (req, res) => {
    try {
      const customer = customerInput(req.body?.customer);
      const loggedIn = await deps.auth.login(customer, String(req.body?.password ?? ""));
      if (!loggedIn) throw new Error("客户号或密码不正确。");
      const token = crypto.randomUUID();
      sessions.set(token, { customer, expiresAt: Date.now() + 8 * 60 * 60 * 1000 });
      setSessionCookie(res, token, production);
      res.json({ customer });
    } catch {
      res.status(401).json({ error: "客户号或密码不正确。" });
    }
  });

  app.post("/api/logout", (req, res) => {
    const token = req.headers.cookie?.match(/(?:^|; )portal_session=([^;]+)/)?.[1];
    if (token) sessions.delete(token);
    res.setHeader("Set-Cookie", `portal_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${production ? "; Secure" : ""}`);
    res.status(204).end();
  });

  app.get("/api/catalog", async (req, res) => {
    try {
      const active = session(req);
      const salesArea = await selectedSalesArea(active.customer, req.query as Record<string, unknown>);
      res.json(await catalogDependencies().list(active.customer, salesArea, catalogQuery(req), catalogLanguage(req)));
    } catch (error) { respondRouteError(res, error); }
  });

  app.get("/api/sales-areas", async (req, res) => {
    try {
      res.json(await salesAreaDependencies().list(session(req).customer));
    } catch (error) { respondRouteError(res, error); }
  });

  app.get("/api/order-defaults", async (req, res) => {
    try {
      const active = session(req);
      const salesArea = await selectedSalesArea(active.customer, req.query as SalesAreaSource);
      res.json(await orderDefaultsDependencies().get(active.customer, salesArea));
    } catch (error) { respondRouteError(res, error); }
  });

  app.get("/api/products/:product/fulfillment", async (req, res) => {
    try {
      session(req);
      const product = String(req.params.product ?? "").trim();
      if (!product || product.length > 40) throw new Error("物料无效。");
      res.json(await fulfillmentDependencies().get(product));
    } catch (error) { respondRouteError(res, error); }
  });

  app.get("/api/me", async (req, res) => {
    try {
      const active = session(req);
      res.json(await customerDependencies().get(active.customer));
    } catch (error) { respondRouteError(res, error); }
  });

  app.get("/api/customer-360", async (req, res) => {
    try {
      const active = session(req);
      res.json(await customer360Dependencies().get(active.customer));
    }
    catch (error) { respondRouteError(res, error); }
  });

  app.get("/api/orders/history", async (req, res) => {
    try {
      res.json(await orderHistoryDependencies().list(session(req).customer, orderHistoryQuery(req)));
    } catch (error) { respondRouteError(res, error); }
  });

  app.get("/api/orders/:salesOrder", async (req, res) => {
    try {
      res.json(await orderHistoryDependencies().detail(session(req).customer, req.params.salesOrder));
    } catch (error) { respondRouteError(res, error); }
  });

  app.post("/api/orders/preview", async (req, res) => {
    try {
      const active = session(req);
      const checkout = checkoutFields(req.body);
      const cartGroups = await selectedCartGroups(active.customer, req.body);
      const preview = await Promise.all(cartGroups.map((group) => priceOrderGroup(active.customer, group)));
      const prepared = mallOrderDependencies().prepare(active.customer, cartGroups);
      const childIds = new Map(prepared.groups.map((group) => [group.salesArea.key, group.childOrderId]));
      res.json({ mallOrderId: prepared.mallOrderId, groups: preview.map((group) => ({ ...group, childOrderId: childIds.get(group.salesArea.key) })), checkout });
    } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : "请求失败。" }); }
  });

  app.post("/api/orders/submit", async (req, res) => {
    try {
      const { customer } = session(req);
      const checkout = checkoutFields(req.body);
      const { config } = orderDependencies();
      if (req.body?.confirm !== true) throw new Error("请确认订单后再同步 SAP。");
      const mallOrderId = optionalText(req.body?.mallOrderId);
      if (!mallOrderId || !/^MALL-\d{8}-[A-F0-9]{8}$/.test(mallOrderId)) throw new Error("商城订单号无效，请重新确认订单。");
      assertWriteAllowed(config, "CREATE_SALES_ORDER", "CREATE_SALES_ORDER");
      const groups = await Promise.all((await selectedCartGroups(customer, req.body)).map(async (group) => {
        const preview = await priceOrderGroup(customer, group);
        return {
          salesArea: group.salesArea,
          payload: {
            sales_order_type: process.env.PORTAL_SALES_ORDER_TYPE ?? "OR",
            sales_organization: group.salesArea.salesOrganization,
            distribution_channel: group.salesArea.distributionChannel,
            organization_division: group.salesArea.division,
            sold_to_party: customer,
            ...checkout,
            items: preview.items.map((item) => {
              const cartLine = group.items.find((line) => line.product === item.productId);
              if (!cartLine?.productionPlant) throw new Error(`物料 ${item.productId} 尚未选择工厂。`);
              return {
                material: item.productId,
                requested_quantity: item.quantity,
                requested_quantity_unit: item.priceUnit || "PC",
                customer_material: cartLine.customerMaterial,
                production_plant: cartLine.productionPlant,
                storage_location: cartLine.storageLocation,
              };
            }),
            dry_run: false,
            confirm: "CREATE_SALES_ORDER" as const,
            response_format: "json" as const,
          },
        };
      }));
      const submitted = await mallOrderDependencies().submit({ mallOrderId, customer, groups });
      const results = submitted.groups.map((group) => ({ ...group, success: group.status === "SUBMITTED" }));
      if (!results.some((result) => result.success)) {
        res.status(400).json({ success: false, mallOrderId: submitted.mallOrderId, groups: results });
        return;
      }
      res.json({ success: true, mallOrderId: submitted.mallOrderId, groups: results });
    } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : "请求失败。" }); }
  });

  return app;
}

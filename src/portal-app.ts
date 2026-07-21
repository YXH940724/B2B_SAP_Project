import crypto from "node:crypto";
import express from "express";
import type { AuthService } from "./auth-service.js";
import type { CatalogPage, CatalogQuery } from "./catalog.js";
import type { SapConfig } from "./config.js";
import { normalizeCustomer } from "./master-data.js";
import { SapODataClient } from "./odata-client.js";
import { getSellableOffer } from "./portal.js";
import { assertWriteAllowed, createPayload, PortalCheckoutSchema } from "./sales-orders.js";
import type { SalesArea } from "./sales-areas.js";
import type { Customer360Profile } from "./customer-360.js";
import { OrderHistoryError, type CustomerOrderHistory, type OrderDetail, type OrderQuery } from "./order-history.js";
import type { VerificationDelivery } from "./verification-delivery.js";

export interface PortalDependencies {
  auth: AuthService;
  contact: { get(customer: string): Promise<{ customer: string; email: string }> };
  delivery: VerificationDelivery;
  order?: { config: SapConfig; client: SapODataClient };
  catalog?: { list(customer: string, salesArea: SalesArea, query: CatalogQuery): Promise<CatalogPage> };
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

function salesAreaInput(source: Record<string, unknown>): Omit<SalesArea, "key"> {
  const salesOrganization = typeof source.salesOrganization === "string" ? source.salesOrganization.trim() : "";
  const distributionChannel = typeof source.distributionChannel === "string" ? source.distributionChannel.trim() : "";
  const division = typeof source.division === "string" ? source.division.trim() : "";
  if (!salesOrganization || !distributionChannel || !division) throw new Error("请选择有效的销售范围。");
  return { salesOrganization, distributionChannel, division };
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
    overallStatus: stringQuery(req.query.overallStatus),
    deliveryStatus: stringQuery(req.query.deliveryStatus),
    query: stringQuery(req.query.query),
    sort: stringQuery(req.query.sort) as OrderQuery["sort"] | undefined,
  };
}

function checkoutFields(body: unknown): { requested_delivery_date?: string; purchase_order_by_customer?: string; portal_note?: string } {
  const source = body as { requestedDeliveryDate?: unknown; purchaseOrderByCustomer?: unknown; note?: unknown } | undefined;
  const parsed = PortalCheckoutSchema.safeParse({
    requested_delivery_date: optionalText(source?.requestedDeliveryDate),
    purchase_order_by_customer: optionalText(source?.purchaseOrderByCustomer),
    portal_note: optionalText(source?.note),
  });
  if (parsed.success) return parsed.data;
  if (parsed.error.issues.some((issue) => issue.path[0] === "requested_delivery_date")) throw new Error("期望交货日期格式无效。");
  if (parsed.error.issues.some((issue) => issue.path[0] === "purchase_order_by_customer")) throw new Error("客户采购订单号无效。");
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

  function catalogDependencies(): NonNullable<PortalDependencies["catalog"]> {
    if (!deps.catalog) throw new Error("商品目录服务尚未配置。");
    return deps.catalog;
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

  async function selectedSalesArea(customer: string, source: Record<string, unknown>): Promise<SalesArea> {
    const requested = salesAreaInput(source);
    const areas = await salesAreaDependencies().list(customer);
    const area = areas.find((candidate) => candidate.salesOrganization === requested.salesOrganization
      && candidate.distributionChannel === requested.distributionChannel && candidate.division === requested.division);
    if (!area) throw new Error("所选销售范围不属于当前客户。");
    return area;
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
      res.json(await catalogDependencies().list(active.customer, salesArea, catalogQuery(req)));
    } catch (error) { respondRouteError(res, error); }
  });

  app.get("/api/sales-areas", async (req, res) => {
    try {
      res.json(await salesAreaDependencies().list(session(req).customer));
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
      const salesArea = await selectedSalesArea(active.customer, req.body ?? {});
      const { client, config } = orderDependencies();
      const items = Array.isArray(req.body?.items) ? req.body.items : [];
      if (!items.length || items.length > 100) throw new Error("请提供 1 至 100 行订单项目。");
      const priced = await Promise.all(items.map(async (item: { product: string; quantity: number }) => {
        const quantity = Number(item.quantity);
        if (!Number.isFinite(quantity) || quantity <= 0) throw new Error("物料数量必须大于零。");
        const offer = await getSellableOffer(client, config, active.customer, salesArea, String(item.product));
        return { ...offer, productId: String(item.product), quantity, lineTotal: Number(offer.unitPrice) * quantity };
      }));
      res.json({ items: priced, total: priced.reduce((sum, item) => sum + item.lineTotal, 0), checkout });
    } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : "请求失败。" }); }
  });

  app.post("/api/orders/submit", async (req, res) => {
    try {
      const { customer } = session(req);
      const salesArea = await selectedSalesArea(customer, req.body ?? {});
      const checkout = checkoutFields(req.body);
      const { client, config } = orderDependencies();
      if (req.body?.confirm !== true) throw new Error("请确认订单后再同步 SAP。");
      const preview = await Promise.all((req.body?.items ?? []).map(async (item: { product: string; quantity: number; plant?: string }) => {
        const offer = await getSellableOffer(client, config, customer, salesArea, item.product);
        return { material: item.product, requested_quantity: Number(item.quantity), requested_quantity_unit: offer.priceUnit || "PC", plant: item.plant };
      }));
      if (!preview.length) throw new Error("订单没有项目。");
      assertWriteAllowed(config, "CREATE_SALES_ORDER", "CREATE_SALES_ORDER");
      const payload = createPayload({ sales_order_type: process.env.PORTAL_SALES_ORDER_TYPE ?? "OR", sales_organization: salesArea.salesOrganization, distribution_channel: salesArea.distributionChannel, organization_division: salesArea.division, sold_to_party: customer, ...checkout, items: preview, dry_run: false, confirm: "CREATE_SALES_ORDER", response_format: "json" });
      const created = await client.write<unknown>("post", "/A_SalesOrder", payload);
      res.json({ success: true, salesOrder: created.data });
    } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : "请求失败。" }); }
  });

  return app;
}

import crypto from "node:crypto";
import express from "express";
import type { AuthService } from "./auth-service.js";
import type { SapConfig } from "./config.js";
import { normalizeCustomer } from "./master-data.js";
import { SapODataClient } from "./odata-client.js";
import { getSellableOffer } from "./portal.js";
import { assertWriteAllowed, createPayload } from "./sales-orders.js";
import type { VerificationDelivery } from "./verification-delivery.js";

export interface PortalDependencies {
  auth: AuthService;
  contact: { get(customer: string): Promise<{ customer: string; email: string }> };
  delivery: VerificationDelivery;
  order?: { config: SapConfig; client: SapODataClient };
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

  app.get("/api/catalog/:product", async (req, res) => {
    try {
      session(req);
      const { client, config } = orderDependencies();
      res.json(await getSellableOffer(client, config, req.params.product));
    } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : "请求失败。" }); }
  });

  app.post("/api/orders/preview", async (req, res) => {
    try {
      session(req);
      const { client, config } = orderDependencies();
      const items = Array.isArray(req.body?.items) ? req.body.items : [];
      if (!items.length || items.length > 100) throw new Error("请提供 1 至 100 行订单项目。");
      const priced = await Promise.all(items.map(async (item: { product: string; quantity: number }) => {
        const quantity = Number(item.quantity);
        if (!Number.isFinite(quantity) || quantity <= 0) throw new Error("物料数量必须大于零。");
        const offer = await getSellableOffer(client, config, String(item.product));
        return { ...offer, productId: String(item.product), quantity, lineTotal: Number(offer.unitPrice) * quantity };
      }));
      res.json({ items: priced, total: priced.reduce((sum, item) => sum + item.lineTotal, 0) });
    } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : "请求失败。" }); }
  });

  app.post("/api/orders/submit", async (req, res) => {
    try {
      const { customer } = session(req);
      const { client, config } = orderDependencies();
      if (req.body?.confirm !== true) throw new Error("请确认订单后再同步 SAP。");
      const preview = await Promise.all((req.body?.items ?? []).map(async (item: { product: string; quantity: number; plant?: string }) => {
        const offer = await getSellableOffer(client, config, item.product);
        return { material: item.product, requested_quantity: Number(item.quantity), requested_quantity_unit: offer.priceUnit || "PC", plant: item.plant };
      }));
      if (!preview.length) throw new Error("订单没有项目。");
      assertWriteAllowed(config, "CREATE_SALES_ORDER", "CREATE_SALES_ORDER");
      const payload = createPayload({ sales_order_type: process.env.PORTAL_SALES_ORDER_TYPE ?? "OR", sales_organization: process.env.PORTAL_SALES_ORGANIZATION ?? "1000", distribution_channel: process.env.PORTAL_DISTRIBUTION_CHANNEL ?? "10", organization_division: process.env.PORTAL_DIVISION ?? "00", sold_to_party: customer, items: preview, dry_run: false, confirm: "CREATE_SALES_ORDER", response_format: "json" });
      const created = await client.write<unknown>("post", "/A_SalesOrder", payload);
      res.json({ success: true, salesOrder: created.data });
    } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : "请求失败。" }); }
  });

  return app;
}

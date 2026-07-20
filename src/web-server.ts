import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { loadConfig } from "./config.js";
import { SapODataClient } from "./odata-client.js";
import { getCustomer } from "./master-data.js";
import { getSellableOffer } from "./portal.js";
import { assertWriteAllowed, createPayload } from "./sales-orders.js";

const config = loadConfig();
const client = new SapODataClient(config);
const app = express();
const sessions = new Map<string, { customer: string; expiresAt: number }>();
const portalPassword = process.env.PORTAL_PASSWORD;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public");

if (!portalPassword) throw new Error("PORTAL_PASSWORD is required for the order portal.");
app.use(express.json({ limit: "100kb" }));
app.use(express.static(root));

function session(req: express.Request): { customer: string } {
  const token = req.headers.cookie?.match(/(?:^|; )portal_session=([^;]+)/)?.[1];
  const value = token ? sessions.get(token) : undefined;
  if (!value || value.expiresAt < Date.now()) throw new Error("Please sign in again.");
  return { customer: value.customer };
}

function sendError(res: express.Response, error: unknown): void {
  res.status(error instanceof Error && /sign in|password/i.test(error.message) ? 401 : 400).json({ error: error instanceof Error ? error.message : "Request failed." });
}

app.post("/api/login", async (req, res) => {
  try {
    const customer = String(req.body?.customer ?? "").trim();
    const password = String(req.body?.password ?? "");
    if (!/^\d{1,10}$/.test(customer) || password !== portalPassword) throw new Error("Invalid customer number or password.");
    const token = crypto.randomUUID();
    sessions.set(token, { customer, expiresAt: Date.now() + 8 * 60 * 60 * 1000 });
    res.setHeader("Set-Cookie", `portal_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800`);
    res.json({ customer, master: await getCustomer(client, config, customer) });
  } catch (error) { sendError(res, error); }
});

app.get("/api/catalog/:product", async (req, res) => { try { session(req); res.json(await getSellableOffer(client, config, req.params.product)); } catch (error) { sendError(res, error); } });

app.post("/api/orders/preview", async (req, res) => {
  try {
    session(req);
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!items.length || items.length > 100) throw new Error("Provide 1 to 100 order items.");
    const priced = await Promise.all(items.map(async (item: { product: string; quantity: number }) => {
      const quantity = Number(item.quantity);
      if (!Number.isFinite(quantity) || quantity <= 0) throw new Error("Item quantity must be positive.");
      const offer = await getSellableOffer(client, config, String(item.product));
      return { ...offer, productId: String(item.product), quantity, lineTotal: Number(offer.unitPrice) * quantity };
    }));
    res.json({ items: priced, total: priced.reduce((sum, item) => sum + item.lineTotal, 0) });
  } catch (error) { sendError(res, error); }
});

app.post("/api/orders/submit", async (req, res) => {
  try {
    const { customer } = session(req);
    if (req.body?.confirm !== true) throw new Error("Confirm the order before synchronizing it to SAP.");
    const preview = await Promise.all((req.body?.items ?? []).map(async (item: { product: string; quantity: number; plant?: string }) => {
      const offer = await getSellableOffer(client, config, item.product);
      return { material: item.product, requested_quantity: Number(item.quantity), requested_quantity_unit: offer.priceUnit || "PC", plant: item.plant };
    }));
    if (!preview.length) throw new Error("Order contains no items.");
    assertWriteAllowed(config, "CREATE_SALES_ORDER", "CREATE_SALES_ORDER");
    const payload = createPayload({ sales_order_type: process.env.PORTAL_SALES_ORDER_TYPE ?? "OR", sales_organization: process.env.PORTAL_SALES_ORGANIZATION ?? "1000", distribution_channel: process.env.PORTAL_DISTRIBUTION_CHANNEL ?? "10", organization_division: process.env.PORTAL_DIVISION ?? "00", sold_to_party: customer, items: preview, dry_run: false, confirm: "CREATE_SALES_ORDER", response_format: "json" });
    const created = await client.write<unknown>("post", "/A_SalesOrder", payload);
    res.json({ success: true, salesOrder: created.data });
  } catch (error) { sendError(res, error); }
});

app.listen(Number(process.env.PORTAL_PORT ?? "3000"), () => console.log("Order portal is running on http://localhost:3000"));

import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export interface PortalUser {
  customer: string;
  passwordHash: string;
}

export interface VerificationRecord {
  customer: string;
  codeHash: string;
  expiresAt: number;
  attempts: number;
  requestCount: number;
  requestWindowStartedAt: number;
}

export type MallOrderStatus = "PENDING" | "SUBMITTING" | "SUBMITTED" | "FAILED";

export interface MallOrderChildRecord {
  id: string;
  mallOrderId: string;
  salesArea: string;
  status: MallOrderStatus;
  sapSalesOrder: string | null;
  requestJson: string;
  failureReason: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface MallOrderRecord {
  id: string;
  customer: string;
  createdAt: number;
  updatedAt: number;
  children: MallOrderChildRecord[];
}

export interface NewMallOrderChild {
  id: string;
  salesArea: string;
  requestJson: string;
}

export interface AuthStore {
  getUser(customer: string): PortalUser | undefined;
  createUser(customer: string, passwordHash: string, now: number): void;
  getVerification(customer: string): VerificationRecord | undefined;
  saveVerification(record: VerificationRecord): void;
  deleteVerification(customer: string): void;
  updateAttempts(customer: string, attempts: number): void;
  markLogin(customer: string, now: number): void;
  reserveMallOrder(customer: string, id: string, now: number): MallOrderRecord;
  createMallOrder(order: { id: string; customer: string; now: number }, children: NewMallOrderChild[]): MallOrderRecord;
  getMallOrder(customer: string, id: string): MallOrderRecord | undefined;
  getMallOrderChild(id: string): MallOrderChildRecord | undefined;
  markMallOrderChildSubmitting(id: string, now: number): void;
  markMallOrderChildSubmitted(id: string, sapSalesOrder: string, now: number): void;
  markMallOrderChildFailed(id: string, failureReason: string, now: number): void;
  close(): void;
}

export function createAuthStore(databasePath: string): AuthStore {
  if (databasePath !== ":memory:") fs.mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
  const database = new Database(databasePath);
  database.pragma("journal_mode = WAL");
  database.exec(`
    CREATE TABLE IF NOT EXISTS portal_users (
      customer TEXT PRIMARY KEY,
      password_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_login_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS verification_codes (
      customer TEXT PRIMARY KEY,
      code_hash TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL,
      request_count INTEGER NOT NULL,
      request_window_started_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS mall_orders (
      id TEXT PRIMARY KEY,
      customer TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS mall_order_children (
      id TEXT PRIMARY KEY,
      mall_order_id TEXT NOT NULL REFERENCES mall_orders(id),
      sales_area TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('PENDING', 'SUBMITTING', 'SUBMITTED', 'FAILED')),
      sap_sales_order TEXT,
      request_json TEXT NOT NULL,
      failure_reason TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(mall_order_id, sales_area)
    );
    CREATE INDEX IF NOT EXISTS idx_mall_orders_customer ON mall_orders(customer, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_mall_order_children_sap ON mall_order_children(sap_sales_order);
  `);

  const getUser = database.prepare("SELECT customer, password_hash FROM portal_users WHERE customer = ?");
  const insertUser = database.prepare("INSERT INTO portal_users (customer, password_hash, created_at) VALUES (?, ?, ?)");
  const getVerification = database.prepare("SELECT customer, code_hash, expires_at, attempts, request_count, request_window_started_at FROM verification_codes WHERE customer = ?");
  const saveVerification = database.prepare(`
    INSERT INTO verification_codes (customer, code_hash, expires_at, attempts, request_count, request_window_started_at)
    VALUES (@customer, @codeHash, @expiresAt, @attempts, @requestCount, @requestWindowStartedAt)
    ON CONFLICT(customer) DO UPDATE SET
      code_hash = excluded.code_hash,
      expires_at = excluded.expires_at,
      attempts = excluded.attempts,
      request_count = excluded.request_count,
      request_window_started_at = excluded.request_window_started_at
  `);
  const deleteVerification = database.prepare("DELETE FROM verification_codes WHERE customer = ?");
  const updateAttempts = database.prepare("UPDATE verification_codes SET attempts = ? WHERE customer = ?");
  const markLogin = database.prepare("UPDATE portal_users SET last_login_at = ? WHERE customer = ?");
  const getMallOrderRow = database.prepare("SELECT id, customer, created_at, updated_at FROM mall_orders WHERE id = ? AND customer = ?");
  const getMallOrderById = database.prepare("SELECT id, customer, created_at, updated_at FROM mall_orders WHERE id = ?");
  const getMallOrderChildren = database.prepare("SELECT id, mall_order_id, sales_area, status, sap_sales_order, request_json, failure_reason, created_at, updated_at FROM mall_order_children WHERE mall_order_id = ? ORDER BY id");
  const getMallOrderChild = database.prepare("SELECT id, mall_order_id, sales_area, status, sap_sales_order, request_json, failure_reason, created_at, updated_at FROM mall_order_children WHERE id = ?");
  const insertMallOrder = database.prepare("INSERT INTO mall_orders (id, customer, created_at, updated_at) VALUES (?, ?, ?, ?)");
  const insertMallOrderChild = database.prepare(`
    INSERT INTO mall_order_children (id, mall_order_id, sales_area, status, request_json, created_at, updated_at)
    VALUES (@id, @mallOrderId, @salesArea, 'PENDING', @requestJson, @now, @now)
  `);
  const markMallOrderChildSubmitting = database.prepare("UPDATE mall_order_children SET status = 'SUBMITTING', failure_reason = NULL, updated_at = ? WHERE id = ?");
  const markMallOrderChildSubmitted = database.prepare("UPDATE mall_order_children SET status = 'SUBMITTED', sap_sales_order = ?, failure_reason = NULL, updated_at = ? WHERE id = ?");
  const markMallOrderChildFailed = database.prepare("UPDATE mall_order_children SET status = 'FAILED', failure_reason = ?, updated_at = ? WHERE id = ?");

  type MallOrderRow = { id: string; customer: string; created_at: number; updated_at: number };
  type MallOrderChildRow = {
    id: string; mall_order_id: string; sales_area: string; status: MallOrderStatus; sap_sales_order: string | null;
    request_json: string; failure_reason: string | null; created_at: number; updated_at: number;
  };
  const toMallOrderChild = (row: MallOrderChildRow): MallOrderChildRecord => ({
    id: row.id, mallOrderId: row.mall_order_id, salesArea: row.sales_area, status: row.status,
    sapSalesOrder: row.sap_sales_order, requestJson: row.request_json, failureReason: row.failure_reason,
    createdAt: row.created_at, updatedAt: row.updated_at,
  });
  const toMallOrder = (row: MallOrderRow): MallOrderRecord => ({
    id: row.id, customer: row.customer, createdAt: row.created_at, updatedAt: row.updated_at,
    children: (getMallOrderChildren.all(row.id) as MallOrderChildRow[]).map(toMallOrderChild),
  });
  const createMallOrder = database.transaction((order: { id: string; customer: string; now: number }, children: NewMallOrderChild[]): MallOrderRecord => {
    const existing = getMallOrderById.get(order.id) as MallOrderRow | undefined;
    if (existing && existing.customer !== order.customer) throw new Error("商城订单号已存在，请重新获取确认信息。");
    if (!existing) insertMallOrder.run(order.id, order.customer, order.now, order.now);
    const existingChildren = getMallOrderChildren.all(order.id) as MallOrderChildRow[];
    if (!existingChildren.length) {
      children.forEach((child) => insertMallOrderChild.run({ ...child, mallOrderId: order.id, now: order.now }));
    } else if (existingChildren.length !== children.length || existingChildren.some((child, index) => child.id !== children[index]?.id)) {
      throw new Error("商城订单内容与已保存订单不一致。");
    }
    return toMallOrder((getMallOrderById.get(order.id) as MallOrderRow));
  });

  return {
    getUser(customer) {
      const row = getUser.get(customer) as { customer: string; password_hash: string } | undefined;
      return row ? { customer: row.customer, passwordHash: row.password_hash } : undefined;
    },
    createUser(customer, passwordHash, now) { insertUser.run(customer, passwordHash, now); },
    getVerification(customer) {
      const row = getVerification.get(customer) as {
        customer: string; code_hash: string; expires_at: number; attempts: number; request_count: number; request_window_started_at: number;
      } | undefined;
      return row ? {
        customer: row.customer, codeHash: row.code_hash, expiresAt: row.expires_at, attempts: row.attempts,
        requestCount: row.request_count, requestWindowStartedAt: row.request_window_started_at,
      } : undefined;
    },
    saveVerification(record) { saveVerification.run(record); },
    deleteVerification(customer) { deleteVerification.run(customer); },
    updateAttempts(customer, attempts) { updateAttempts.run(attempts, customer); },
    markLogin(customer, now) { markLogin.run(now, customer); },
    reserveMallOrder(customer, id, now) {
      if (getMallOrderById.get(id)) throw new Error("商城订单号已存在，请重新获取确认信息。");
      insertMallOrder.run(id, customer, now, now);
      return toMallOrder(getMallOrderById.get(id) as MallOrderRow);
    },
    createMallOrder(order, children) { return createMallOrder(order, children); },
    getMallOrder(customer, id) {
      const row = getMallOrderRow.get(id, customer) as MallOrderRow | undefined;
      return row ? toMallOrder(row) : undefined;
    },
    getMallOrderChild(id) {
      const row = getMallOrderChild.get(id) as MallOrderChildRow | undefined;
      return row ? toMallOrderChild(row) : undefined;
    },
    markMallOrderChildSubmitting(id, now) { markMallOrderChildSubmitting.run(now, id); },
    markMallOrderChildSubmitted(id, sapSalesOrder, now) { markMallOrderChildSubmitted.run(sapSalesOrder, now, id); },
    markMallOrderChildFailed(id, failureReason, now) { markMallOrderChildFailed.run(failureReason, now, id); },
    close() { database.close(); },
  };
}

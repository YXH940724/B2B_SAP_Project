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

export interface AuthStore {
  getUser(customer: string): PortalUser | undefined;
  createUser(customer: string, passwordHash: string, now: number): void;
  getVerification(customer: string): VerificationRecord | undefined;
  saveVerification(record: VerificationRecord): void;
  deleteVerification(customer: string): void;
  updateAttempts(customer: string, attempts: number): void;
  markLogin(customer: string, now: number): void;
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
    close() { database.close(); },
  };
}

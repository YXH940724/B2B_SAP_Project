import axios, { AxiosError, type AxiosInstance, type AxiosResponse } from "axios";
import type { SapConfig } from "./config.js";

export interface ODataEnvelope<T> {
  d?: T;
}

export interface ODataResponse<T> {
  data: T;
  etag?: string;
}

export class SapODataError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "SapODataError";
  }
}

export class SapODataClient {
  private readonly http: AxiosInstance;

  constructor(private readonly config: SapConfig) {
    this.http = axios.create({
      baseURL: config.baseUrl,
      timeout: config.timeoutMs,
      httpsAgent: config.httpsAgent,
      auth: { username: config.username, password: config.password },
      headers: { Accept: "application/json" },
    });
  }

  async get<T>(path: string, params: Record<string, string | number | undefined> = {}): Promise<ODataResponse<T>> {
    try {
      const response = await this.http.get<ODataEnvelope<T>>(path, { params: { "sap-client": this.config.client, ...params } });
      return { data: response.data.d ?? (response.data as T), etag: response.headers.etag as string | undefined };
    } catch (error) {
      throw toSapError(error);
    }
  }

  async write<T>(method: "post" | "patch", path: string, body: unknown, etag?: string): Promise<ODataResponse<T>> {
    const csrfToken = await this.fetchCsrfToken();
    try {
      const response = await this.http.request<ODataEnvelope<T>>({
        method,
        url: path,
        params: { "sap-client": this.config.client },
        data: body,
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": csrfToken,
          ...(etag ? { "If-Match": etag } : {}),
        },
      });
      return { data: response.data.d ?? (response.data as T), etag: response.headers.etag as string | undefined };
    } catch (error) {
      throw toSapError(error);
    }
  }

  private async fetchCsrfToken(): Promise<string> {
    try {
      const response: AxiosResponse = await this.http.get("/", {
        params: { "sap-client": this.config.client },
        headers: { "X-CSRF-Token": "Fetch" },
      });
      const token = response.headers["x-csrf-token"];
      if (typeof token !== "string" || !token) throw new SapODataError("SAP did not return a CSRF token. Verify the service user has write permission.");
      return token;
    } catch (error) {
      if (error instanceof SapODataError) throw error;
      throw toSapError(error);
    }
  }
}

function toSapError(error: unknown): SapODataError {
  if (!axios.isAxiosError(error)) return new SapODataError("Unexpected SAP OData client error.");
  const response = error.response;
  const message = readSapMessage(error);
  if (response?.status === 401) return new SapODataError("SAP authentication failed. Check SAP_USER and SAP_PASSWORD.", 401);
  if (response?.status === 403) return new SapODataError("SAP denied this operation. Check OData authorizations and CSRF configuration.", 403);
  if (response?.status === 404) return new SapODataError("SAP OData resource was not found. Verify the sales order ID and configured service URL.", 404);
  return new SapODataError(message, response?.status);
}

function readSapMessage(error: AxiosError<unknown>): string {
  const body = error.response?.data;
  if (typeof body === "object" && body !== null && "error" in body) {
    const detail = (body as { error?: { message?: { value?: unknown } } }).error?.message?.value;
    if (typeof detail === "string" && detail) return `SAP OData request failed: ${detail}`;
  }
  return error.code === "ECONNABORTED" ? "SAP OData request timed out." : "SAP OData request failed.";
}

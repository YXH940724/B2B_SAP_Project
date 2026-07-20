#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { SapODataClient } from "./odata-client.js";
import { CreateSalesOrderSchema, ResponseFormat, SalesOrderId, UpdateSalesOrderSchema, assertWriteAllowed, createPayload, getSalesOrder, getSalesOrderItems, normalizeSalesOrder, salesOrderPath } from "./sales-orders.js";

const config = loadConfig();
const client = new SapODataClient(config);
const server = new McpServer({
  name: "sap-odata-mcp-server",
  version: "1.0.0",
}, {
  instructions: "SAP S/4HANA sales-order MCP. Read tools are safe. Write tools default to dry_run and only send a change after SAP_WRITE_ENABLED=true plus the exact confirmation phrase. Never use write tools without a user-approved change request.",
});

function result(data: unknown, format: "markdown" | "json") {
  const text = format === "json" ? JSON.stringify(data, null, 2) : `\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``;
  return { content: [{ type: "text" as const, text }], structuredContent: data as Record<string, unknown> };
}

function failure(error: unknown) {
  const message = error instanceof Error ? error.message : "Unexpected SAP OData error.";
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

server.registerTool("sap_get_sales_order", {
  title: "Get SAP sales order",
  description: "Read a single SAP sales-order header and its ETag. Use the returned ETag for a later guarded update.",
  inputSchema: { sales_order: SalesOrderId, response_format: ResponseFormat },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
}, async ({ sales_order, response_format }) => {
  try { return result(await getSalesOrder(client, sales_order), response_format); } catch (error) { return failure(error); }
});

server.registerTool("sap_get_sales_order_items", {
  title: "Get SAP sales-order items",
  description: "Read up to 100 line items for one SAP sales order.",
  inputSchema: { sales_order: SalesOrderId, limit: z.number().int().min(1).max(100).default(20), response_format: ResponseFormat },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
}, async ({ sales_order, limit, response_format }) => {
  try { return result({ items: await getSalesOrderItems(client, sales_order, limit), limit }, response_format); } catch (error) { return failure(error); }
});

server.registerTool("sap_create_sales_order", {
  title: "Create SAP sales order",
  description: "Prepare or create an SAP sales order. Defaults to dry_run. A real create needs SAP_WRITE_ENABLED=true and confirm=CREATE_SALES_ORDER.",
  inputSchema: CreateSalesOrderSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
}, async (input) => {
  try {
    const payload = createPayload(input);
    if (input.dry_run) return result({ dry_run: true, operation: "create_sales_order", payload }, input.response_format);
    assertWriteAllowed(config, input.confirm, "CREATE_SALES_ORDER");
    const response = await client.write<unknown>("post", "/A_SalesOrder", payload);
    return result({ dry_run: false, created: response.data, etag: response.etag }, input.response_format);
  } catch (error) { return failure(error); }
});

server.registerTool("sap_update_sales_order", {
  title: "Update SAP sales order",
  description: "Prepare or update approved header fields on an existing SAP sales order. Defaults to dry_run and requires the ETag from sap_get_sales_order for an actual update.",
  inputSchema: UpdateSalesOrderSchema,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
}, async (input) => {
  try {
    const id = normalizeSalesOrder(input.sales_order);
    if (input.dry_run) return result({ dry_run: true, operation: "update_sales_order", sales_order: id, changes: input.changes, etag: input.etag }, input.response_format);
    assertWriteAllowed(config, input.confirm, "UPDATE_SALES_ORDER", input.changes);
    const response = await client.write<unknown>("patch", salesOrderPath(id), input.changes, input.etag);
    return result({ dry_run: false, updated: response.data, etag: response.etag }, input.response_format);
  } catch (error) { return failure(error); }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("SAP OData MCP server is running over stdio.");

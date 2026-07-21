import crypto from "node:crypto";
import type { AuthStore, MallOrderStatus, NewMallOrderChild } from "./auth-store.js";
import type { SapODataClient } from "./odata-client.js";
import { createPayload, findSalesOrderByShipToParty, normalizeSalesOrder, type CreateSalesOrderInput } from "./sales-orders.js";
import type { SalesArea } from "./sales-areas.js";

export type MallOrderGroupInput = {
  salesArea: SalesArea;
  payload: CreateSalesOrderInput;
};

export type MallOrderChildPlan = {
  id: string;
  group: MallOrderGroupInput;
};

export type MallOrderSubmissionInput = {
  mallOrderId: string;
  customer: string;
  groups: MallOrderGroupInput[];
};

export type MallOrderSubmissionGroup = {
  childOrderId: string;
  salesArea: SalesArea;
  status: MallOrderStatus;
  salesOrder?: string;
  error?: string;
};

export type MallOrderSubmissionResult = {
  mallOrderId: string;
  groups: MallOrderSubmissionGroup[];
};

export type MallOrderPreview = {
  mallOrderId: string;
  groups: Array<{ childOrderId: string; salesArea: SalesArea }>;
};

export function generateMallOrderId(now = new Date(), randomBytes: Buffer<ArrayBufferLike> = crypto.randomBytes(4)): string {
  const date = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, "0")}${String(now.getUTCDate()).padStart(2, "0")}`;
  return `MALL-${date}-${randomBytes.toString("hex").toUpperCase()}`;
}

export function buildMallOrderChildren<T extends { salesArea: SalesArea }>(parentId: string, groups: T[]): Array<{ id: string; group: T }> {
  return [...groups]
    .sort((left, right) => left.salesArea.key.localeCompare(right.salesArea.key))
    .map((group, index) => ({ id: `${parentId}-${String(index + 1).padStart(2, "0")}`, group }));
}

function salesOrderFromCreateResponse(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const salesOrder = (data as { SalesOrder?: unknown }).SalesOrder;
  return typeof salesOrder === "string" && salesOrder ? salesOrder : undefined;
}

function toChildRows(plans: MallOrderChildPlan[]): NewMallOrderChild[] {
  return plans.map(({ id, group }) => ({ id, salesArea: group.salesArea.key, requestJson: JSON.stringify(group.payload) }));
}

export class MallOrderSubmissionService {
  constructor(
    private readonly store: AuthStore,
    private readonly client: Pick<SapODataClient, "get" | "write">,
    private readonly now: () => number = Date.now,
    private readonly randomBytes: () => Buffer = () => crypto.randomBytes(4),
  ) {}

  prepare(customer: string, groups: Array<{ salesArea: SalesArea }>): MallOrderPreview {
    if (!groups.length) throw new Error("请至少选择一个销售范围。");
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const mallOrderId = generateMallOrderId(new Date(this.now()), this.randomBytes());
      try {
        this.store.reserveMallOrder(customer, mallOrderId, this.now());
        return {
          mallOrderId,
          groups: buildMallOrderChildren(mallOrderId, groups).map(({ id, group }) => ({ childOrderId: id, salesArea: group.salesArea })),
        };
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes("商城订单号已存在")) throw error;
      }
    }
    throw new Error("暂时无法生成商城订单号，请重新确认订单。");
  }

  async submit(input: MallOrderSubmissionInput): Promise<MallOrderSubmissionResult> {
    const plans = buildMallOrderChildren(input.mallOrderId, input.groups);
    const order = this.store.createMallOrder({ id: input.mallOrderId, customer: input.customer, now: this.now() }, toChildRows(plans));
    const childrenById = new Map(order.children.map((child) => [child.id, child]));
    const groups = await Promise.all(plans.map(async (plan) => {
      const child = childrenById.get(plan.id);
      if (!child) throw new Error("商城订单子单未保存。");
      if (child.status === "SUBMITTED" && child.sapSalesOrder) {
        return { childOrderId: plan.id, salesArea: plan.group.salesArea, status: "SUBMITTED" as const, salesOrder: child.sapSalesOrder };
      }
      return this.submitChild(input.customer, plan);
    }));
    return { mallOrderId: input.mallOrderId, groups };
  }

  private async submitChild(customer: string, plan: MallOrderChildPlan): Promise<MallOrderSubmissionGroup> {
    this.store.markMallOrderChildSubmitting(plan.id, this.now());
    try {
      let salesOrder = await findSalesOrderByShipToParty(this.client as SapODataClient, customer, plan.id);
      if (!salesOrder) {
        const created = await this.client.write("post", "/A_SalesOrder", createPayload({
          ...plan.group.payload,
          purchase_order_by_ship_to_party: plan.id,
        }));
        salesOrder = salesOrderFromCreateResponse(created.data);
      }
      if (!salesOrder) salesOrder = await findSalesOrderByShipToParty(this.client as SapODataClient, customer, plan.id);
      if (!salesOrder) throw new Error("SAP 未返回销售订单号。");
      const normalized = normalizeSalesOrder(salesOrder);
      this.store.markMallOrderChildSubmitted(plan.id, normalized, this.now());
      return { childOrderId: plan.id, salesArea: plan.group.salesArea, status: "SUBMITTED", salesOrder: normalized };
    } catch {
      try {
        const recovered = await findSalesOrderByShipToParty(this.client as SapODataClient, customer, plan.id);
        if (recovered) {
          const normalized = normalizeSalesOrder(recovered);
          this.store.markMallOrderChildSubmitted(plan.id, normalized, this.now());
          return { childOrderId: plan.id, salesArea: plan.group.salesArea, status: "SUBMITTED", salesOrder: normalized };
        }
      } catch {
        // The original failure is intentionally represented by a safe portal message below.
      }
      this.store.markMallOrderChildFailed(plan.id, "创建 SAP 销售订单失败。", this.now());
      return { childOrderId: plan.id, salesArea: plan.group.salesArea, status: "FAILED", error: "创建 SAP 销售订单失败。" };
    }
  }
}

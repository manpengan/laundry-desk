import {
  AiAssistantToolResultSchema,
  type AiAssistantToolCall,
  type AiAssistantToolResult,
} from "@laundry/contracts";

import { executeQuery } from "../bus/execute-query.js";
import { createRuntimeBus } from "../bus/runtime.js";
import { FakeSqlClient } from "../db/fake-client.js";
import { withPoolClient } from "../db/pg-sql-client.js";
import type { SqlClient } from "../db/types.js";
import type { LocalRuntime } from "../local/demo-seed.js";
import { redactAiText } from "./safety-guard.js";
import type { ReadonlyAssistantToolPort } from "./streaming-provider.js";
import type { AiRequestContext } from "./streaming-store.js";

type RecordValue = Readonly<Record<string, unknown>>;

const PROCEDURES = Object.freeze({
  order_intake: Object.freeze([
    "确认顾客与衣物明细均已录入。",
    "重新选择在架价目并核对预计取衣日期。",
    "仍失败时保留页面错误码并联系店长。",
  ]),
  pickup: Object.freeze([
    "使用票号、取衣码或衣物条码重新检索订单。",
    "核对所有待取衣物已上架且条码逐件一致。",
    "余额或状态异常时停止交付并联系店长。",
  ]),
  printing: Object.freeze([
    "确认打印工作器在线且队列没有失败任务。",
    "核对打印机电源、纸张和系统默认设备。",
    "只对原任务使用重试或补打，不重新开单。",
  ]),
  customer_lookup: Object.freeze([
    "优先使用完整手机号、票号或取衣码检索。",
    "出现多个候选时逐项核对，不合并或修改档案。",
    "仍无法确认身份时停止操作并联系店长。",
  ]),
});

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function integerValue(value: unknown): number {
  return Number.isSafeInteger(value) ? (value as number) : 0;
}

function maskName(value: unknown): string {
  const name = stringValue(value).trim();
  return name.length === 0 ? "未留姓名" : `${name.slice(0, 1)}**`;
}

function maskPhone(value: unknown): string {
  const phone = stringValue(value);
  if (phone.includes("*")) return phone.slice(0, 32);
  return /^1[3-9]\d{9}$/u.test(phone) ? `*******${phone.slice(-4)}` : "[PHONE_REDACTED]";
}

function requirePermission(context: AiRequestContext, permission: string): void {
  if (!(context.permissions ?? []).includes(permission))
    throw new Error("AI_TOOL_PERMISSION_DENIED");
}

async function runQuery(
  runtime: LocalRuntime,
  name: string,
  input: Readonly<Record<string, unknown>>,
  context: AiRequestContext,
): Promise<unknown> {
  const operation = async (client: SqlClient) => {
    const result = await executeQuery(client, context.tenant, name, input, {
      registry: createRuntimeBus(runtime).queryRegistry,
      actor: Object.freeze({
        staffId: context.tenant.staffId,
        deviceId: context.deviceId,
        via: "ai" as const,
        permissions: context.permissions ?? Object.freeze([]),
        riskCap: "R2" as const,
      }),
    });
    if (!result.ok) throw new Error(`AI_TOOL_QUERY_${result.error.code}`);
    return result.data.result;
  };
  if (runtime.mode === "pg" && runtime.pool !== null) {
    return withPoolClient(runtime.pool, operation);
  }
  return operation(new FakeSqlClient());
}

function businessResult(raw: unknown, businessDate: string | undefined): AiAssistantToolResult {
  if (!isRecord(raw)) throw new Error("AI_TOOL_RESULT_INVALID");
  const date = stringValue(raw.business_date, businessDate ?? "server_current_day");
  const item = Object.freeze({
    business_date: date,
    order_count: integerValue(raw.order_count),
    garment_count: integerValue(raw.garment_count),
    payable_cents: integerValue(raw.payable_cents),
    paid_cents: integerValue(raw.paid_cents),
    balance_cents: integerValue(raw.balance_cents),
  });
  return AiAssistantToolResultSchema.parse({
    summary: `${date} 经营汇总（金额单位：分）`,
    result_count: 1,
    sources: [{ kind: "query", ref: "query:stats.day.summary:0.3.0", label: "日经营汇总" }],
    filters: [{ field: "business_date", value: businessDate ?? "server_current_day" }],
    items: [item],
  });
}

function ordersResult(raw: unknown, limit: number): AiAssistantToolResult {
  const rows = isRecord(raw) && Array.isArray(raw.orders) ? raw.orders.slice(0, limit) : [];
  const items = rows.filter(isRecord).map((row) =>
    Object.freeze({
      order_id: stringValue(row.order_id),
      ticket_no: stringValue(row.ticket_no),
      status: stringValue(row.status),
      customer_name_masked: maskName(row.customer_name),
      customer_phone_masked: maskPhone(row.customer_phone),
      balance_cents: integerValue(row.balance_cents),
    }),
  );
  return AiAssistantToolResultSchema.parse({
    summary: `找到 ${items.length} 个订单候选；顾客资料已脱敏。`,
    result_count: items.length,
    sources: [{ kind: "query", ref: "query:order.lookup:0.1.0", label: "订单检索" }],
    filters: [
      { field: "lookup_key", value: "redacted" },
      { field: "limit", value: String(limit) },
    ],
    items,
  });
}

function customersResult(raw: unknown, limit: number): AiAssistantToolResult {
  const rows = isRecord(raw) && Array.isArray(raw.customers) ? raw.customers.slice(0, limit) : [];
  const items = rows.filter(isRecord).map((row) =>
    Object.freeze({
      customer_id: stringValue(row.customer_id),
      name_masked: maskName(row.name),
      phone_masked: maskPhone(row.phone_masked),
      version: integerValue(row.version),
      updated_at: integerValue(row.updated_at),
    }),
  );
  return AiAssistantToolResultSchema.parse({
    summary: `找到 ${items.length} 个顾客候选；姓名和手机号已脱敏。`,
    result_count: items.length,
    sources: [{ kind: "query", ref: "query:customer.search:0.2.0", label: "顾客检索" }],
    filters: [
      { field: "query", value: "redacted" },
      { field: "limit", value: String(limit) },
    ],
    items,
  });
}

function procedureResult(call: Extract<AiAssistantToolCall, { tool: "procedure.troubleshoot" }>) {
  const safeSymptom = redactAiText(call.args.symptom);
  return AiAssistantToolResultSchema.parse({
    summary: `按内置规程排查 ${call.args.topic}；症状已脱敏 ${safeSymptom.redactionCount} 处。`,
    result_count: PROCEDURES[call.args.topic].length,
    sources: [
      {
        kind: "document",
        ref: `document:procedure.${call.args.topic}:2026-08-13`,
        label: "Laundry Desk 内置操作规程",
      },
    ],
    filters: [{ field: "topic", value: call.args.topic }],
    items: PROCEDURES[call.args.topic].map((instruction, index) => ({
      step: index + 1,
      instruction,
    })),
  });
}

export function createReadonlyAssistantTool(runtime: LocalRuntime): ReadonlyAssistantToolPort {
  return Object.freeze({
    async execute(call, context, signal) {
      if (signal.aborted) throw new Error("AI_ABORTED");
      if (call.tool === "business.summary") {
        requirePermission(context, "accounting_read");
        const raw = await runQuery(runtime, "stats.day.summary", call.args, context);
        return businessResult(raw, call.args.business_date);
      }
      if (call.tool === "records.search") {
        requirePermission(context, "customer_read");
        const raw = await runQuery(
          runtime,
          call.args.scope === "orders" ? "order.lookup" : "customer.search",
          call.args.scope === "orders"
            ? { key: call.args.query, limit: call.args.limit }
            : { query: call.args.query, limit: call.args.limit },
          context,
        );
        return call.args.scope === "orders"
          ? ordersResult(raw, call.args.limit)
          : customersResult(raw, call.args.limit);
      }
      requirePermission(context, "ai_use");
      return procedureResult(call);
    },
  });
}

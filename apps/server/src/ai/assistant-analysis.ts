import {
  AiAssistantToolResultSchema,
  OwnerDashboardResultSchema,
  PickupReminderListResultSchema,
  type AiAssistantToolCall,
} from "@laundry/contracts";

type TrendCall = Extract<AiAssistantToolCall, { tool: "business.trend" }>;
type PickupCall = Extract<AiAssistantToolCall, { tool: "pickup.candidates" }>;

export function assistantTrend(raw: unknown, call: TrendCall) {
  const data = OwnerDashboardResultSchema.parse(raw);
  const selected = data.trend.slice(-call.args.days);
  const sum = (key: "performance_income_cents" | "real_income_cents") => {
    const value = selected.reduce((total, row) => total + row[key], 0);
    if (!Number.isSafeInteger(value)) throw new Error("AI_ANALYSIS_OVERFLOW");
    return value;
  };
  return AiAssistantToolResultSchema.parse({
    summary: `最近 ${call.args.days} 日经营汇总，金额单位为分；经营收入与实际收入采用不同口径，差额不代表异常或利润。`,
    result_count: 1,
    sources: [
      { kind: "query", ref: "query:reporting.owner_dashboard.get:0.1.0", label: "经营看板" },
    ],
    filters: [
      { field: "days", value: String(call.args.days) },
      { field: "through", value: data.business_date },
    ],
    items: [
      {
        from: selected[0]?.business_date ?? data.business_date,
        through: data.business_date,
        performance_income_cents: sum("performance_income_cents"),
        real_income_cents: sum("real_income_cents"),
        generated_at: data.generated_at,
      },
    ],
  });
}

export function assistantPickup(raw: unknown, call: PickupCall) {
  const data = PickupReminderListResultSchema.parse(raw);
  const rows = data.candidates.slice(0, call.args.limit);
  return AiAssistantToolResultSchema.parse({
    summary: `找到 ${rows.length} 个催取候选（最多 ${call.args.limit} 个），尚未联系顾客。先核对实物与联系方式，再由人工确认联系。`,
    result_count: rows.length,
    sources: [
      { kind: "query", ref: "query:notification.pickup_reminders.list:0.1.0", label: "待催取衣物" },
    ],
    filters: [
      { field: "min_age_days", value: String(call.args.min_age_days) },
      { field: "unpaid_only", value: String(call.args.unpaid_only) },
      { field: "limit", value: String(call.args.limit) },
    ],
    items: rows.map((row) => ({
      order_id: row.order_id,
      ticket_no: row.ticket_no,
      overdue_days: row.overdue_days,
      garment_count: row.garment_count,
      balance_cents: row.balance_cents,
      last_contact_at: row.last_contact_at,
    })),
  });
}

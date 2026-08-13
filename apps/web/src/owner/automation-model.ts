import {
  AutomationPolicyListResultSchema,
  AutomationPolicyMutationResultSchema,
  AutomationPolicyDraftSchema,
  AutomationRunListResultSchema,
  type AutomationPolicy,
  type AutomationPolicyDraft,
  type AutomationRun,
} from "@laundry/contracts";

import { isStepUpRequired } from "../commands/command-client.js";
import type { CommandPort, QueryPort } from "../commands/types.js";

type BusEnvelope = Readonly<{ execution: "executed" | "preview"; result: unknown }>;

function resultFrom(data: unknown): unknown {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const envelope = data as Partial<BusEnvelope>;
  return envelope.execution === "executed" ? envelope.result : null;
}

export async function loadAutomationPolicies(
  client: QueryPort,
  signal: AbortSignal,
): Promise<
  Readonly<{ ok: true; data: readonly AutomationPolicy[] }> | Readonly<{ ok: false; error: string }>
> {
  const response = await client.execute<unknown>(
    "automation.policies.list",
    { limit: 50 },
    { signal },
  );
  if (!response.ok)
    return Object.freeze({ ok: false, error: response.error.message ?? response.error.code });
  const parsed = AutomationPolicyListResultSchema.safeParse(resultFrom(response.data));
  return parsed.success
    ? Object.freeze({ ok: true as const, data: Object.freeze(parsed.data.policies) })
    : Object.freeze({ ok: false as const, error: "自动化策略返回格式无效" });
}

export async function loadAutomationRuns(
  client: QueryPort,
  policyId: string,
  signal: AbortSignal,
): Promise<
  Readonly<{ ok: true; data: readonly AutomationRun[] }> | Readonly<{ ok: false; error: string }>
> {
  const response = await client.execute<unknown>(
    "automation.runs.list",
    { policy_id: policyId, limit: 50 },
    { signal },
  );
  if (!response.ok)
    return Object.freeze({ ok: false, error: response.error.message ?? response.error.code });
  const parsed = AutomationRunListResultSchema.safeParse(resultFrom(response.data));
  return parsed.success
    ? Object.freeze({ ok: true as const, data: Object.freeze(parsed.data.runs) })
    : Object.freeze({ ok: false as const, error: "自动化运行记录返回格式无效" });
}

export type AutomationFormValue = Readonly<{
  name: string;
  localTime: string;
  minAgeDays: string;
  unpaidOnly: boolean;
  includeReady: boolean;
  includeRacked: boolean;
  maxObjects: string;
  maxRuns: string;
  maxAmountCents: string;
  reason: string;
}>;

export const EMPTY_AUTOMATION_FORM: AutomationFormValue = Object.freeze({
  name: "",
  localTime: "10:00",
  minAgeDays: "30",
  unpaidOnly: false,
  includeReady: true,
  includeRacked: true,
  maxObjects: "10",
  maxRuns: "1",
  maxAmountCents: "0",
  reason: "",
});

export function formFromPolicy(policy: AutomationPolicy): AutomationFormValue {
  return Object.freeze({
    name: policy.name,
    localTime: policy.schedule.local_time,
    minAgeDays: String(policy.object_filter.min_age_days),
    unpaidOnly: policy.object_filter.unpaid_only,
    includeReady: policy.object_filter.garment_statuses.includes("ready"),
    includeRacked: policy.object_filter.garment_statuses.includes("racked"),
    maxObjects: String(policy.object_filter.max_objects),
    maxRuns: String(policy.limits.max_runs_per_day),
    maxAmountCents: String(policy.limits.max_amount_cents),
    reason: "调整有界自动化策略",
  });
}

export function buildAutomationDraft(
  value: AutomationFormValue,
  now: Date,
): Readonly<{ ok: true; draft: AutomationPolicyDraft }> | Readonly<{ ok: false; error: string }> {
  const maxObjects = Number(value.maxObjects);
  const maxRuns = Number(value.maxRuns);
  const maxAmountCents = Number(value.maxAmountCents);
  const minAgeDays =
    value.minAgeDays === "30"
      ? 30
      : value.minAgeDays === "90"
        ? 90
        : value.minAgeDays === "180"
          ? 180
          : null;
  const garmentStatuses = Object.freeze([
    ...(value.includeReady ? (["ready"] as const) : []),
    ...(value.includeRacked ? (["racked"] as const) : []),
  ]);
  const valid =
    Number.isFinite(now.getTime()) &&
    value.name.trim().length > 0 &&
    value.reason.trim().length > 0 &&
    minAgeDays !== null &&
    garmentStatuses.length > 0 &&
    /^\d{2}:\d{2}$/u.test(value.localTime) &&
    Number.isSafeInteger(maxObjects) &&
    maxObjects >= 1 &&
    maxObjects <= 10 &&
    Number.isSafeInteger(maxRuns) &&
    maxRuns >= 1 &&
    maxRuns <= 24 &&
    Number.isSafeInteger(maxAmountCents) &&
    maxAmountCents >= 0 &&
    maxAmountCents <= 100_000;
  if (!valid)
    return Object.freeze({
      ok: false,
      error: "请填写名称、原因和有效的时间、次数、对象及金额上限",
    });
  const candidate: AutomationPolicyDraft = Object.freeze({
    name: value.name.trim(),
    tool: "notification.delivery_batch.enqueue",
    object_filter: Object.freeze({
      min_age_days: minAgeDays,
      unpaid_only: value.unpaidOnly,
      garment_statuses: garmentStatuses,
      max_objects: maxObjects,
    }),
    schedule: Object.freeze({
      cadence: "daily",
      local_time: value.localTime,
      days_of_week: Object.freeze([0, 1, 2, 3, 4, 5, 6]),
      window_start_local: "08:00",
      window_end_local: "22:00",
    }),
    limits: Object.freeze({ max_runs_per_day: maxRuns, max_amount_cents: maxAmountCents }),
    valid_from: now.toISOString(),
    valid_until: null,
    reason: value.reason.trim(),
  });
  if (!AutomationPolicyDraftSchema.safeParse(candidate).success) {
    return Object.freeze({ ok: false, error: "执行时间必须位于 08:00 至 22:00 的固定窗口内" });
  }
  return Object.freeze({ ok: true as const, draft: candidate });
}

export async function mutateAutomationPolicy(
  client: CommandPort,
  name: string,
  input: unknown,
  signal: AbortSignal,
): Promise<
  Readonly<{ ok: true; policy: AutomationPolicy }> | Readonly<{ ok: false; error: string }>
> {
  let response = await client.execute<unknown>(name, input, { signal });
  if (
    !response.ok &&
    isStepUpRequired(response) &&
    response.error.code === "POLICY_CONFIRMATION_REQUIRED"
  ) {
    response = await client.execute<unknown>(
      name,
      {},
      {
        confirmRef: response.error.detail.confirm_ref,
        signal,
      },
    );
  }
  if (!response.ok)
    return Object.freeze({ ok: false, error: response.error.message ?? response.error.code });
  const parsed = AutomationPolicyMutationResultSchema.safeParse(resultFrom(response.data));
  return parsed.success
    ? Object.freeze({ ok: true as const, policy: Object.freeze(parsed.data.policy) })
    : Object.freeze({ ok: false as const, error: "自动化策略变更结果无效" });
}

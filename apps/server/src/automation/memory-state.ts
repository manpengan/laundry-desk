import type { AutomationPolicyDraft, AutomationRun } from "@laundry/contracts";

import { nextAutomationRun } from "./schedule.js";
import type { AutomationStoreContext, StoredAutomationPolicy } from "./types.js";

export type InternalAutomationPolicy = StoredAutomationPolicy &
  Readonly<{
    activeRunId: string | null;
    leaseToken: string | null;
    leaseUntil: string | null;
  }>;

export type AutomationMemoryState = Readonly<{
  policies: ReadonlyMap<string, InternalAutomationPolicy>;
  runs: ReadonlyMap<string, AutomationRun>;
  usage: ReadonlyMap<string, Readonly<{ count: number; amountCents: number }>>;
}>;

export type MemoryAutomationOptions = Readonly<{
  timeZone: string;
  isActiveAdmin: (orgId: string, storeId: string, staffId: string) => boolean;
}>;

export const copyAutomationPolicy = (policy: InternalAutomationPolicy): InternalAutomationPolicy =>
  Object.freeze({
    ...policy,
    object_filter: Object.freeze({
      ...policy.object_filter,
      garment_statuses: Object.freeze([...policy.object_filter.garment_statuses]),
    }),
    schedule: Object.freeze({
      ...policy.schedule,
      days_of_week: Object.freeze([...policy.schedule.days_of_week]),
    }),
    limits: Object.freeze({ ...policy.limits }),
  });

export function exposeAutomationPolicy(policy: InternalAutomationPolicy): StoredAutomationPolicy {
  const {
    activeRunId: _activeRunId,
    leaseToken: _leaseToken,
    leaseUntil: _leaseUntil,
    ...publicPolicy
  } = copyAutomationPolicy(policy);
  void _activeRunId;
  void _leaseToken;
  void _leaseUntil;
  return Object.freeze(publicPolicy);
}

export function automationPolicyScoped(
  policy: InternalAutomationPolicy,
  context: AutomationStoreContext,
): boolean {
  return policy.org_id === context.tenant.orgId && policy.store_id === context.tenant.storeId;
}

export function scheduledAutomationAt(
  policy: InternalAutomationPolicy,
  timeZone: string,
  after: Date,
): string | null {
  return nextAutomationRun(policy.schedule, timeZone, after)?.toISOString() ?? null;
}

export const automationConfigFrom = (draft: AutomationPolicyDraft) =>
  Object.freeze({
    name: draft.name,
    tool: draft.tool,
    object_filter: Object.freeze({
      ...draft.object_filter,
      garment_statuses: Object.freeze([...draft.object_filter.garment_statuses]),
    }),
    schedule: Object.freeze({
      ...draft.schedule,
      days_of_week: Object.freeze([...draft.schedule.days_of_week]),
    }),
    limits: Object.freeze({ ...draft.limits }),
    valid_from: draft.valid_from,
    valid_until: draft.valid_until,
  });

export function automationRunFrom(
  policy: InternalAutomationPolicy,
  input: Readonly<{
    id: string;
    outcome: AutomationRun["outcome"];
    argsSha256: string;
    objectCount: number;
    amountCents: number;
    errorCode: string | null;
    startedAt: Date;
    completedAt: Date;
  }>,
): AutomationRun {
  return Object.freeze({
    run_id: input.id,
    policy_id: policy.policy_id,
    tool: policy.tool,
    decision: "policy",
    outcome: input.outcome,
    args_sha256: input.argsSha256,
    object_count: input.objectCount,
    amount_cents: input.amountCents,
    error_code: input.errorCode,
    started_at: input.startedAt.toISOString(),
    completed_at: input.completedAt.toISOString(),
  });
}

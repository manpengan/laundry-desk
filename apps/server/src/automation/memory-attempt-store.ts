import { insideAutomationWindow, localBusinessDate } from "./schedule.js";
import {
  automationPolicyScoped,
  automationRunFrom,
  copyAutomationPolicy,
  scheduledAutomationAt,
  type AutomationMemoryState,
  type MemoryAutomationOptions,
} from "./memory-state.js";
import type {
  AutomationAttempt,
  AutomationAttemptAuthorization,
  AutomationAttemptSettlement,
  AutomationRecordOnlyAttempt,
  AutomationStoreContext,
} from "./types.js";

type ReadState = () => AutomationMemoryState;
type WriteState = (state: AutomationMemoryState) => void;

const denied = (reason: AutomationAttemptAuthorization["reason"]) =>
  Object.freeze({ authorized: false as const, reason });

export class MemoryAutomationAttemptStore {
  constructor(
    private readonly options: MemoryAutomationOptions,
    private readonly read: ReadState,
    private readonly write: WriteState,
  ) {}

  async begin(
    context: AutomationStoreContext,
    attempt: AutomationAttempt,
  ): Promise<AutomationAttemptAuthorization> {
    const state = this.read();
    const policy = state.policies.get(attempt.policyId);
    if (
      !policy ||
      !automationPolicyScoped(policy, context) ||
      policy.status !== "active" ||
      policy.row_version !== attempt.policyVersion ||
      policy.approved_by_staff_id !== context.tenant.staffId ||
      !this.options.isActiveAdmin(policy.org_id, policy.store_id, context.tenant.staffId) ||
      policy.next_run_at === null ||
      policy.next_run_at > attempt.startedAt.toISOString() ||
      policy.valid_from > attempt.startedAt.toISOString() ||
      (policy.valid_until !== null && policy.valid_until <= attempt.startedAt.toISOString()) ||
      !insideAutomationWindow(policy.schedule, this.options.timeZone, attempt.startedAt) ||
      attempt.objectCount < 1 ||
      attempt.objectCount > policy.object_filter.max_objects ||
      attempt.amountCents < 0 ||
      attempt.amountCents > 100_000 ||
      (policy.leaseUntil !== null && policy.leaseUntil > attempt.startedAt.toISOString())
    ) {
      return denied("POLICY_DENIED");
    }

    const rollingObjects = [...state.runs.values()]
      .filter((run) => {
        const owner = state.policies.get(run.policy_id);
        return (
          owner !== undefined &&
          owner.org_id === policy.org_id &&
          owner.store_id === policy.store_id &&
          new Date(run.started_at).getTime() >= attempt.startedAt.getTime() - 86_400_000
        );
      })
      .reduce((total, run) => total + run.object_count, 0);
    if (rollingObjects + attempt.objectCount > 10) return denied("POLICY_DENIED");

    const usageKey = `${policy.org_id}|${policy.store_id}|${policy.policy_id}|${localBusinessDate(this.options.timeZone, attempt.startedAt)}`;
    const usage = state.usage.get(usageKey) ?? Object.freeze({ count: 0, amountCents: 0 });
    if (
      usage.count + 1 > policy.limits.max_runs_per_day ||
      usage.amountCents + attempt.amountCents > policy.limits.max_amount_cents
    ) {
      const run = automationRunFrom(policy, {
        id: attempt.runId,
        outcome: "denied",
        argsSha256: attempt.argsSha256,
        objectCount: attempt.objectCount,
        amountCents: attempt.amountCents,
        errorCode: "QUOTA_EXCEEDED",
        startedAt: attempt.startedAt,
        completedAt: attempt.startedAt,
      });
      const paused = copyAutomationPolicy({
        ...policy,
        status: "quota_paused",
        row_version: policy.row_version + 1,
        next_run_at: null,
        activeRunId: null,
        leaseToken: null,
        leaseUntil: null,
        last_run_at: attempt.startedAt.toISOString(),
        last_outcome: "denied",
        updated_at: attempt.startedAt.toISOString(),
      });
      this.write({
        ...state,
        policies: new Map(state.policies).set(policy.policy_id, paused),
        runs: new Map(state.runs).set(run.run_id, run),
      });
      return denied("QUOTA_EXCEEDED");
    }

    const leased = copyAutomationPolicy({
      ...policy,
      activeRunId: attempt.runId,
      leaseToken: attempt.leaseToken,
      leaseUntil: new Date(attempt.startedAt.getTime() + 300_000).toISOString(),
    });
    this.write({
      ...state,
      policies: new Map(state.policies).set(policy.policy_id, leased),
      usage: new Map(state.usage).set(
        usageKey,
        Object.freeze({
          count: usage.count + 1,
          amountCents: usage.amountCents + attempt.amountCents,
        }),
      ),
    });
    return Object.freeze({ authorized: true, reason: "AUTHORIZED" });
  }

  async settle(context: AutomationStoreContext, settlement: AutomationAttemptSettlement) {
    const state = this.read();
    const policy = state.policies.get(settlement.policyId);
    if (
      !policy ||
      !automationPolicyScoped(policy, context) ||
      policy.activeRunId !== settlement.runId ||
      policy.leaseToken !== settlement.leaseToken ||
      policy.approved_by_staff_id !== context.tenant.staffId ||
      !this.options.isActiveAdmin(policy.org_id, policy.store_id, context.tenant.staffId)
    ) {
      return false;
    }
    const failures =
      settlement.outcome === "failed" ? Math.min(3, policy.consecutive_failures + 1) : 0;
    const status = failures >= 3 ? "paused" : "active";
    const run = automationRunFrom(policy, {
      id: settlement.runId,
      outcome: settlement.outcome,
      argsSha256: settlement.argsSha256,
      objectCount: settlement.objectCount,
      amountCents: settlement.amountCents,
      errorCode: settlement.errorCode,
      startedAt: settlement.startedAt,
      completedAt: settlement.completedAt,
    });
    const updated = copyAutomationPolicy({
      ...policy,
      status,
      next_run_at:
        status === "active"
          ? scheduledAutomationAt(policy, this.options.timeZone, settlement.completedAt)
          : null,
      activeRunId: null,
      leaseToken: null,
      leaseUntil: null,
      last_run_at: settlement.completedAt.toISOString(),
      last_outcome: settlement.outcome,
      consecutive_failures: failures,
      updated_at: settlement.completedAt.toISOString(),
    });
    this.write({
      ...state,
      policies: new Map(state.policies).set(policy.policy_id, updated),
      runs: new Map(state.runs).set(run.run_id, run),
    });
    return true;
  }

  async record(context: AutomationStoreContext, attempt: AutomationRecordOnlyAttempt) {
    const state = this.read();
    const policy = state.policies.get(attempt.policyId);
    if (
      !policy ||
      !automationPolicyScoped(policy, context) ||
      policy.status !== "active" ||
      policy.row_version !== attempt.policyVersion ||
      policy.approved_by_staff_id !== context.tenant.staffId ||
      !this.options.isActiveAdmin(policy.org_id, policy.store_id, context.tenant.staffId)
    ) {
      return false;
    }
    const failures =
      attempt.outcome === "failed" ? Math.min(3, policy.consecutive_failures + 1) : 0;
    const status = failures >= 3 ? "paused" : "active";
    const run = automationRunFrom(policy, {
      id: attempt.runId,
      outcome: attempt.outcome,
      argsSha256: attempt.argsSha256,
      objectCount: 0,
      amountCents: 0,
      errorCode: attempt.errorCode,
      startedAt: attempt.at,
      completedAt: attempt.at,
    });
    const updated = copyAutomationPolicy({
      ...policy,
      status,
      next_run_at:
        status === "active"
          ? scheduledAutomationAt(policy, this.options.timeZone, attempt.at)
          : null,
      last_run_at: attempt.at.toISOString(),
      last_outcome: attempt.outcome,
      consecutive_failures: failures,
      updated_at: attempt.at.toISOString(),
    });
    this.write({
      ...state,
      policies: new Map(state.policies).set(policy.policy_id, updated),
      runs: new Map(state.runs).set(run.run_id, run),
    });
    return true;
  }
}

import type { AutomationPolicy, AutomationPolicyDraft } from "@laundry/contracts";

import {
  readMemoryTransactionState,
  writeMemoryTransactionState,
} from "../db/memory-unit-of-work.js";
import { MemoryAutomationAttemptStore } from "./memory-attempt-store.js";
import {
  automationConfigFrom,
  automationPolicyScoped,
  copyAutomationPolicy,
  exposeAutomationPolicy,
  scheduledAutomationAt,
  type AutomationMemoryState,
  type InternalAutomationPolicy,
  type MemoryAutomationOptions,
} from "./memory-state.js";
import type {
  AutomationAttempt,
  AutomationAttemptSettlement,
  AutomationRecordOnlyAttempt,
  AutomationStore,
  AutomationStoreContext,
  AutomationTransition,
} from "./types.js";

export class MemoryAutomationStore implements AutomationStore {
  private committed: AutomationMemoryState = Object.freeze({
    policies: new Map(),
    runs: new Map(),
    usage: new Map(),
  });
  private readonly attempts: MemoryAutomationAttemptStore;

  constructor(private readonly options: MemoryAutomationOptions) {
    this.attempts = new MemoryAutomationAttemptStore(
      options,
      () => this.state(),
      (next) => this.write(next),
    );
  }

  async create(
    context: AutomationStoreContext,
    id: string,
    draft: AutomationPolicyDraft,
    now: Date,
  ) {
    const state = this.state();
    if (state.policies.has(id)) return false;
    const policy: InternalAutomationPolicy = copyAutomationPolicy({
      policy_id: id,
      org_id: context.tenant.orgId,
      store_id: context.tenant.storeId,
      ...automationConfigFrom(draft),
      tool_version: "0.1.0",
      status: "pending_approval",
      row_version: 1,
      approved_by_staff_id: null,
      approved_at: null,
      next_run_at: null,
      last_run_at: null,
      last_outcome: null,
      consecutive_failures: 0,
      created_by_staff_id: context.tenant.staffId,
      updated_by_staff_id: context.tenant.staffId,
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
      activeRunId: null,
      leaseToken: null,
      leaseUntil: null,
    });
    this.write({ ...state, policies: new Map(state.policies).set(id, policy) });
    return true;
  }

  async update(
    context: AutomationStoreContext,
    id: string,
    expectedVersion: number,
    draft: AutomationPolicyDraft,
    now: Date,
  ) {
    const state = this.state();
    const current = state.policies.get(id);
    if (!this.canChange(current, context, expectedVersion, now)) return false;
    const updated = copyAutomationPolicy({
      ...current,
      ...automationConfigFrom(draft),
      tool_version: "0.1.0",
      status: "pending_approval",
      row_version: current.row_version + 1,
      approved_by_staff_id: null,
      approved_at: null,
      next_run_at: null,
      activeRunId: null,
      leaseToken: null,
      leaseUntil: null,
      updated_by_staff_id: context.tenant.staffId,
      updated_at: now.toISOString(),
    });
    this.write({ ...state, policies: new Map(state.policies).set(id, updated) });
    return true;
  }

  async transition(
    context: AutomationStoreContext,
    id: string,
    expectedVersion: number,
    operation: AutomationTransition,
    now: Date,
  ) {
    const state = this.state();
    const current = state.policies.get(id);
    if (!this.canChange(current, context, expectedVersion, now)) return false;
    const changes = this.transitionChanges(current, context, operation, now);
    if (changes === null) return false;
    const updated = copyAutomationPolicy({
      ...current,
      ...changes,
      activeRunId: null,
      leaseToken: null,
      leaseUntil: null,
      row_version: current.row_version + 1,
      updated_by_staff_id: context.tenant.staffId,
      updated_at: now.toISOString(),
    });
    this.write({ ...state, policies: new Map(state.policies).set(id, updated) });
    return true;
  }

  async get(context: AutomationStoreContext, id: string) {
    const policy = this.state().policies.get(id);
    return policy && automationPolicyScoped(policy, context)
      ? exposeAutomationPolicy(policy)
      : null;
  }

  async list(
    context: AutomationStoreContext,
    status: AutomationPolicy["status"] | undefined,
    limit: number,
  ) {
    return Object.freeze(
      [...this.state().policies.values()]
        .filter(
          (policy) =>
            automationPolicyScoped(policy, context) &&
            (status === undefined || policy.status === status),
        )
        .sort(
          (left, right) =>
            right.updated_at.localeCompare(left.updated_at) ||
            left.policy_id.localeCompare(right.policy_id),
        )
        .slice(0, limit)
        .map(exposeAutomationPolicy),
    );
  }

  async listRuns(context: AutomationStoreContext, policyId: string, limit: number) {
    const policy = this.state().policies.get(policyId);
    if (!policy || !automationPolicyScoped(policy, context)) return Object.freeze([]);
    return Object.freeze(
      [...this.state().runs.values()]
        .filter((run) => run.policy_id === policyId)
        .sort(
          (left, right) =>
            right.started_at.localeCompare(left.started_at) ||
            left.run_id.localeCompare(right.run_id),
        )
        .slice(0, limit),
    );
  }

  async listDue(context: AutomationStoreContext, now: Date, limit: number) {
    const nowIso = now.toISOString();
    return Object.freeze(
      [...this.state().policies.values()]
        .filter(
          (policy) =>
            automationPolicyScoped(policy, context) &&
            policy.status === "active" &&
            policy.next_run_at !== null &&
            policy.next_run_at <= nowIso &&
            policy.valid_from <= nowIso &&
            (policy.valid_until === null || policy.valid_until > nowIso) &&
            (policy.leaseUntil === null || policy.leaseUntil <= nowIso) &&
            policy.approved_by_staff_id !== null &&
            this.options.isActiveAdmin(policy.org_id, policy.store_id, policy.approved_by_staff_id),
        )
        .sort(
          (left, right) =>
            (left.next_run_at ?? "").localeCompare(right.next_run_at ?? "") ||
            left.policy_id.localeCompare(right.policy_id),
        )
        .slice(0, limit)
        .map(exposeAutomationPolicy),
    );
  }

  beginAttempt(context: AutomationStoreContext, attempt: AutomationAttempt) {
    return this.attempts.begin(context, attempt);
  }

  settleAttempt(context: AutomationStoreContext, settlement: AutomationAttemptSettlement) {
    return this.attempts.settle(context, settlement);
  }

  recordAttempt(context: AutomationStoreContext, attempt: AutomationRecordOnlyAttempt) {
    return this.attempts.record(context, attempt);
  }

  private canChange(
    policy: InternalAutomationPolicy | undefined,
    context: AutomationStoreContext,
    expectedVersion: number,
    now: Date,
  ): policy is InternalAutomationPolicy {
    return (
      policy !== undefined &&
      automationPolicyScoped(policy, context) &&
      policy.row_version === expectedVersion &&
      policy.status !== "archived" &&
      (policy.leaseUntil === null || policy.leaseUntil <= now.toISOString())
    );
  }

  private transitionChanges(
    policy: InternalAutomationPolicy,
    context: AutomationStoreContext,
    operation: AutomationTransition,
    now: Date,
  ): Partial<InternalAutomationPolicy> | null {
    const valid = policy.valid_until === null || policy.valid_until > now.toISOString();
    if (
      operation === "approve" &&
      policy.status === "pending_approval" &&
      valid &&
      this.options.isActiveAdmin(policy.org_id, policy.store_id, context.tenant.staffId)
    ) {
      const after = new Date(Math.max(now.getTime(), new Date(policy.valid_from).getTime()) - 1);
      return {
        status: "active",
        approved_by_staff_id: context.tenant.staffId,
        approved_at: now.toISOString(),
        next_run_at: scheduledAutomationAt(policy, this.options.timeZone, after),
      };
    }
    if (operation === "pause" && ["active", "quota_paused"].includes(policy.status)) {
      return { status: "paused", next_run_at: null };
    }
    if (
      operation === "resume" &&
      ["paused", "quota_paused"].includes(policy.status) &&
      policy.approved_by_staff_id !== null &&
      this.options.isActiveAdmin(policy.org_id, policy.store_id, policy.approved_by_staff_id) &&
      valid
    ) {
      return {
        status: "active",
        next_run_at: scheduledAutomationAt(policy, this.options.timeZone, now),
      };
    }
    return operation === "archive" ? { status: "archived", next_run_at: null } : null;
  }

  private state(): AutomationMemoryState {
    return readMemoryTransactionState(this, this.committed);
  }

  private write(next: AutomationMemoryState): void {
    writeMemoryTransactionState(
      this,
      () => this.committed,
      Object.freeze(next),
      (value) => {
        this.committed = value;
      },
    );
  }
}

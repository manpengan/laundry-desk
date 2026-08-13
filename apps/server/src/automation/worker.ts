import { createHash, randomUUID } from "node:crypto";

import {
  NotificationDeliveryBatchEnqueueInputSchema,
  createCommandError,
} from "@laundry/contracts";

import type { ChainPortHooks } from "../bus/chain-adapter.js";
import { executeCommand } from "../bus/executor.js";
import type {
  BusContext,
  CommandRegistry,
  CommandResult,
  CommandTransactionGuard,
} from "../bus/types.js";
import { permissionsForAuthority } from "../bus/runtime.js";
import { withTenantTransaction } from "../db/tenant-transaction.js";
import type { SqlClient, TenantContext } from "../db/types.js";
import type { NotificationHandlerDeps } from "../notification/types.js";
import {
  NOTIFICATION_ACTIVE_PENDING_LIMIT,
  NOTIFICATION_ROLLING_PENDING_LIMIT,
  type PendingActionStore,
} from "../pending-actions/types.js";
import { evaluateCurrentCommandPolicy } from "../handlers/default-chain-hooks.js";
import type {
  AutomationAttempt,
  AutomationStore,
  AutomationStoreContext,
  StoredAutomationPolicy,
} from "./types.js";

const TARGET_TOOL = "notification.delivery_batch.enqueue" as const;
const TARGET_VERSION = "0.1.0" as const;
const MAX_TICK_POLICIES = 20;
const SAFE_RISKS = new Set(["R0", "R1", "R2", "R3"]);
const FORBIDDEN_TOOL =
  /(?:refund|waive|free|balance|permission|credential|key|backup|restore|audit.*delete)/iu;

export type AutomationSqlRunner = <T>(operation: (client: SqlClient) => Promise<T>) => Promise<T>;

export type AutomationWorkerDeps = Readonly<{
  store: AutomationStore;
  notification: NotificationHandlerDeps;
  bus: () => Readonly<{ registry: CommandRegistry; chainHooks: ChainPortHooks }>;
  pendingStore: PendingActionStore;
  runWithSql: AutomationSqlRunner;
  discoveryTenant: TenantContext;
  now: () => Date;
  newId?: () => string;
}>;

export type AutomationTickOutcome = Readonly<{
  policy_id: string;
  run_id: string;
  outcome: "executed" | "failed" | "skipped" | "denied";
  error_code: string | null;
}>;

type ResolvedTarget = Readonly<{
  input: ReturnType<typeof NotificationDeliveryBatchEnqueueInputSchema.parse>;
  objectCount: number;
  amountCents: number;
  argsSha256: string;
}>;

const hash = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");

function validNow(deps: AutomationWorkerDeps): Date {
  const now = deps.now();
  if (!Number.isFinite(now.getTime())) throw new TypeError("Invalid automation worker clock");
  return now;
}

function tenantFor(policy: StoredAutomationPolicy): TenantContext {
  if (policy.approved_by_staff_id === null) throw new TypeError("Automation approval is missing");
  return Object.freeze({
    orgId: policy.org_id,
    storeId: policy.store_id,
    staffId: policy.approved_by_staff_id,
  });
}

function assertToolAuthority(deps: AutomationWorkerDeps, policy: StoredAutomationPolicy): void {
  const registered = deps.bus().registry.get(policy.tool);
  if (
    policy.tool !== TARGET_TOOL ||
    policy.tool_version !== TARGET_VERSION ||
    FORBIDDEN_TOOL.test(policy.tool) ||
    registered === undefined ||
    registered.definition.version !== TARGET_VERSION ||
    !SAFE_RISKS.has(registered.definition.risk)
  ) {
    throw new TypeError("Automation target is outside the static registry authority");
  }
}

async function resolveTarget(
  deps: AutomationWorkerDeps,
  policy: StoredAutomationPolicy,
  tenant: TenantContext,
  now: Date,
): Promise<ResolvedTarget | null> {
  const capability = deps.notification.delivery?.capability;
  if (
    capability === undefined ||
    capability.state === "disabled" ||
    capability.unit_cost_cents === null ||
    capability.max_batch_cost_cents === null
  ) {
    throw new TypeError("Automation notification capability unavailable");
  }
  const candidates = await deps.runWithSql((client) =>
    withTenantTransaction(client, tenant, (tx) =>
      deps.notification.store.listPickupReminders({
        client: tx,
        tenant,
        filters: Object.freeze({
          minAgeDays: policy.object_filter.min_age_days,
          unpaidOnly: policy.object_filter.unpaid_only,
          garmentStatuses: Object.freeze([...policy.object_filter.garment_statuses]),
          limit: policy.object_filter.max_objects,
        }),
        now,
      }),
    ),
  );
  const orderIds = Object.freeze(
    candidates.slice(0, policy.object_filter.max_objects).map((candidate) => candidate.order_id),
  );
  if (orderIds.length === 0) return null;
  const amountCents = capability.unit_cost_cents * orderIds.length;
  if (
    !Number.isSafeInteger(amountCents) ||
    amountCents > capability.max_batch_cost_cents ||
    amountCents > policy.limits.max_amount_cents
  ) {
    throw new TypeError("Automation target cost exceeds frozen bounds");
  }
  const input = NotificationDeliveryBatchEnqueueInputSchema.parse({
    order_ids: orderIds,
    channel: "sms",
    template_code: "pickup_reminder_v1",
    max_cost_cents: amountCents,
    min_age_days: policy.object_filter.min_age_days,
    unpaid_only: policy.object_filter.unpaid_only,
    garment_statuses: policy.object_filter.garment_statuses,
  });
  return Object.freeze({
    input,
    objectCount: orderIds.length,
    amountCents,
    argsSha256: hash(input),
  });
}

function workerPolicyHooks(base: ChainPortHooks): ChainPortHooks {
  return Object.freeze({
    ...base,
    checkPolicy: async (parsed, context) => {
      const bus = context.meta as BusContext;
      const decision = evaluateCurrentCommandPolicy(bus, parsed);
      // The approved, versioned policy is the standing R3 confirmation. The
      // normal pure C5 evaluation still runs; any R4/R5 step-up or deny remains
      // impossible to execute without weakening the shared policy engine.
      const allowed =
        bus.actor.via === "automation" &&
        bus.definition.name === TARGET_TOOL &&
        SAFE_RISKS.has(bus.definition.risk) &&
        !FORBIDDEN_TOOL.test(bus.definition.name) &&
        decision !== null &&
        SAFE_RISKS.has(decision.effectiveRisk) &&
        (decision.outcome === "allow" ||
          (decision.outcome === "confirm" && !decision.requiresOtherApprover));
      return allowed
        ? { ok: true as const, data: Object.freeze({ allowed: true as const }) }
        : { ok: false as const, error: createCommandError("POLICY_DENIED") };
    },
  });
}

function storeContext(client: SqlClient, tenant: TenantContext): AutomationStoreContext {
  return Object.freeze({ client, tenant });
}

function guardFor(
  deps: AutomationWorkerDeps,
  tenant: TenantContext,
  attempt: AutomationAttempt,
): CommandTransactionGuard {
  return Object.freeze({
    before: async (client) => {
      const risk = await deps.pendingStore.measureRiskReservation(
        Object.freeze({
          kind: "notification_delivery_rolling_24h",
          command: TARGET_TOOL,
          commandVersion: TARGET_VERSION,
          units: attempt.objectCount,
          threshold: 10,
          windowSeconds: 86_400,
          activePendingLimit: NOTIFICATION_ACTIVE_PENDING_LIMIT,
          rollingPendingLimit: NOTIFICATION_ROLLING_PENDING_LIMIT,
          nowEpochSeconds: Math.floor(attempt.startedAt.getTime() / 1_000),
        }),
        Object.freeze({ client, tenant }),
      );
      if (risk.aggregate_units > risk.threshold) {
        await deps.store.recordAttempt(storeContext(client, tenant), {
          policyId: attempt.policyId,
          policyVersion: attempt.policyVersion,
          runId: attempt.runId,
          outcome: "failed",
          argsSha256: attempt.argsSha256,
          errorCode: "RISK_CAP_EXCEEDED",
          at: attempt.startedAt,
        });
        return Object.freeze({
          kind: "return" as const,
          result: Object.freeze({ ok: false as const, error: createCommandError("POLICY_DENIED") }),
        });
      }
      const authorization = await deps.store.beginAttempt(storeContext(client, tenant), attempt);
      if (!authorization.authorized) {
        return Object.freeze({
          kind: "return" as const,
          result: Object.freeze({ ok: false as const, error: createCommandError("POLICY_DENIED") }),
        });
      }
      return Object.freeze({ kind: "continue" as const, state: attempt });
    },
    settle: async (client, _context, state, result) => {
      const reserved = state as AutomationAttempt;
      const completedAt = validNow(deps);
      const changed = await deps.store.settleAttempt(storeContext(client, tenant), {
        ...reserved,
        outcome: result.ok ? "executed" : "failed",
        errorCode: result.ok ? null : result.error.code,
        completedAt,
      });
      if (!changed) throw new Error("Automation settlement authority changed");
    },
  });
}

async function recordWithoutTarget(
  deps: AutomationWorkerDeps,
  policy: StoredAutomationPolicy,
  runId: string,
  outcome: "skipped" | "failed",
  errorCode: string,
  now: Date,
): Promise<void> {
  const tenant = tenantFor(policy);
  await deps.runWithSql((client) =>
    withTenantTransaction(client, tenant, async (tx) => {
      const changed = await deps.store.recordAttempt(storeContext(tx, tenant), {
        policyId: policy.policy_id,
        policyVersion: policy.row_version,
        runId,
        outcome,
        argsSha256: hash(Object.freeze({ policy_id: policy.policy_id, empty: true })),
        errorCode,
        at: now,
      });
      if (!changed) throw new Error("Automation record authority changed");
    }),
  );
}

async function reserveRolledBackFailure(
  deps: AutomationWorkerDeps,
  tenant: TenantContext,
  attempt: AutomationAttempt,
  result: CommandResult,
): Promise<void> {
  if (result.ok) return;
  await deps.runWithSql((client) =>
    withTenantTransaction(client, tenant, async (tx) => {
      const authorization = await deps.store.beginAttempt(storeContext(tx, tenant), attempt);
      if (!authorization.authorized) return;
      const changed = await deps.store.settleAttempt(storeContext(tx, tenant), {
        ...attempt,
        outcome: "failed",
        errorCode: result.error.code,
        completedAt: validNow(deps),
      });
      if (!changed) throw new Error("Automation failure settlement authority changed");
    }),
  );
}

async function runPolicy(
  deps: AutomationWorkerDeps,
  policy: StoredAutomationPolicy,
): Promise<AutomationTickOutcome> {
  const now = validNow(deps);
  const runId = deps.newId?.() ?? randomUUID();
  try {
    assertToolAuthority(deps, policy);
    const tenant = tenantFor(policy);
    const target = await resolveTarget(deps, policy, tenant, now);
    if (target === null) {
      await recordWithoutTarget(deps, policy, runId, "skipped", "NO_ELIGIBLE_OBJECTS", now);
      return Object.freeze({
        policy_id: policy.policy_id,
        run_id: runId,
        outcome: "skipped",
        error_code: "NO_ELIGIBLE_OBJECTS",
      });
    }
    const attempt: AutomationAttempt = Object.freeze({
      policyId: policy.policy_id,
      policyVersion: policy.row_version,
      runId,
      leaseToken: deps.newId?.() ?? randomUUID(),
      argsSha256: target.argsSha256,
      objectCount: target.objectCount,
      amountCents: target.amountCents,
      startedAt: now,
    });
    const result = await deps.runWithSql((client) => {
      const bus = deps.bus();
      return executeCommand(client, tenant, TARGET_TOOL, target.input, {
        registry: bus.registry,
        actor: Object.freeze({
          staffId: tenant.staffId,
          deviceId: null,
          via: "automation",
          permissions: permissionsForAuthority({ role: "admin", is_privacy_admin: false }),
        }),
        chainHooks: workerPolicyHooks(bus.chainHooks),
        pendingStore: deps.pendingStore,
        transactionGuard: guardFor(deps, tenant, attempt),
        now: () => now,
      });
    });
    await reserveRolledBackFailure(deps, tenant, attempt, result);
    return Object.freeze({
      policy_id: policy.policy_id,
      run_id: runId,
      outcome: result.ok ? "executed" : "failed",
      error_code: result.ok ? null : result.error.code,
    });
  } catch (error) {
    try {
      await recordWithoutTarget(deps, policy, runId, "failed", "AUTOMATION_EXECUTION_FAILED", now);
    } catch (recordError) {
      throw new AggregateError(
        [error, recordError],
        "Automation execution and failure recording both failed",
      );
    }
    return Object.freeze({
      policy_id: policy.policy_id,
      run_id: runId,
      outcome: "failed",
      error_code: "AUTOMATION_EXECUTION_FAILED",
    });
  }
}

export async function runAutomationTick(
  deps: AutomationWorkerDeps,
  limit = MAX_TICK_POLICIES,
): Promise<readonly AutomationTickOutcome[]> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_TICK_POLICIES)
    throw new TypeError("Automation tick limit is invalid");
  const now = validNow(deps);
  const due = await deps.runWithSql((client) =>
    withTenantTransaction(client, deps.discoveryTenant, (tx) =>
      deps.store.listDue(storeContext(tx, deps.discoveryTenant), now, limit),
    ),
  );
  const outcomes: AutomationTickOutcome[] = [];
  for (const policy of due) outcomes.push(await runPolicy(deps, policy));
  return Object.freeze(outcomes);
}

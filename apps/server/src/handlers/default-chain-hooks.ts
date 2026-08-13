/** Default C1 chain hooks; production row scope remains enforced by PostgreSQL GUC/RLS. */

import { randomUUID } from "node:crypto";

import { createCommandError, type CommandError } from "@laundry/contracts";
import { measureInput, type SizeMeasures, type StepResult, type Thresholds } from "@laundry/domain";

import type { BusChainPorts, ChainPortHooks } from "../bus/chain-adapter.js";
import type { BusContext } from "../bus/types.js";
import { actorPermissionSet, requiredPermissionsFromInvariants } from "../bus/rbac.js";
import { evaluatePolicy } from "../policy/evaluate-policy.js";
import type {
  PolicyActor,
  PolicyCommandMeta,
  PolicyDecision,
  PolicyRiskInput,
} from "../policy/types.js";
import { processPendingActionStore } from "../pending-actions/process-store.js";
import { customerPrivacySubjectFromCommand } from "../pending-actions/privacy-subject.js";
import type { PendingActionStore } from "../pending-actions/types.js";
import {
  bindRiskReservation,
  measurePendingRisk,
  notificationPendingRetrySummary,
  pendingResponse,
  preparedPendingRetryMatches,
  sameRiskRequest,
  type PendingActionPreparer,
  type PendingRiskPreparer,
} from "./pending-policy.js";
import { REUSABLE_PENDING_COMMANDS } from "./reusable-pending-commands.js";

const okVoid = (): StepResult<void, CommandError> => ({ ok: true, data: undefined });

const okInvariants = (): StepResult<Readonly<{ preview: true }>, CommandError> => ({
  ok: true,
  data: Object.freeze({ preview: true as const }),
});

const okPolicy = (): StepResult<Readonly<{ allowed: true }>, CommandError> => ({
  ok: true,
  data: Object.freeze({ allowed: true as const }),
});

export { actorPermissionSet, requiredPermissionsFromInvariants } from "../bus/rbac.js";

export {
  combinePendingActionPreparers,
  type PendingActionPreparation,
  type PendingActionPreparer,
  type PendingRiskPreparer,
} from "./pending-policy.js";

export const defaultCheckRbac: BusChainPorts["checkRbac"] = async (_parsed, context) => {
  const bus = context.meta as BusContext;
  const required = requiredPermissionsFromInvariants(bus.definition.invariants);
  if (required.length === 0) return okVoid();

  const held = actorPermissionSet(bus.actor);
  const missing = required.filter((code) => !held.has(code));
  if (missing.length > 0) {
    return {
      ok: false,
      error: createCommandError("PERMISSION_DENIED"),
    };
  }
  return okVoid();
};

export const defaultCheckTenant: BusChainPorts["checkTenant"] = async () => okVoid();

export const defaultCheckInvariants: BusChainPorts["checkInvariants"] = async () => okInvariants();

function policyActorFrom(bus: BusContext): PolicyActor {
  return Object.freeze({
    staffId: bus.actor.staffId,
    via: bus.actor.via,
    permissions: Object.freeze([...(bus.actor.permissions ?? [])]),
    ...(bus.actor.riskCap !== undefined ? { riskCap: bus.actor.riskCap } : {}),
  });
}

function commandMetaFrom(bus: BusContext): PolicyCommandMeta {
  return Object.freeze({
    name: bus.definition.name,
    baseRisk: bus.definition.risk,
  });
}

function normalizedThresholds(
  value: BusContext["definition"]["hard_limits"],
): Thresholds | undefined {
  if (value === undefined) return undefined;
  const maxBatch = value.max_batch;
  const maxAmountCents = value.max_amount_cents;
  if (maxBatch === undefined && maxAmountCents === undefined) return undefined;
  return Object.freeze({
    ...(maxBatch === undefined ? {} : { max_batch: maxBatch }),
    ...(maxAmountCents === undefined ? {} : { max_amount_cents: maxAmountCents }),
  });
}

function normalizedSizeMeasures(value: NonNullable<BusContext["definition"]["size_measures"]>) {
  const result: SizeMeasures = Object.freeze({
    ...(value.batch === undefined ? {} : { batch: value.batch }),
    ...(value.amount === undefined ? {} : { amount: value.amount }),
  });
  return result;
}

function policyRiskInputFrom(bus: BusContext, parsed: unknown): PolicyRiskInput | null | undefined {
  const sizeMeasures = bus.definition.size_measures;
  if (sizeMeasures === undefined) {
    return bus.definition.hard_limits === undefined && bus.definition.risk_escalation === undefined
      ? undefined
      : null;
  }
  const measured = measureInput(parsed, normalizedSizeMeasures(sizeMeasures));
  if (!measured.ok) return null;
  const hardLimits = normalizedThresholds(bus.definition.hard_limits);
  const riskEscalation = normalizedThresholds(bus.definition.risk_escalation);
  if (
    (bus.definition.hard_limits !== undefined && hardLimits === undefined) ||
    (bus.definition.risk_escalation !== undefined && riskEscalation === undefined)
  ) {
    return null;
  }
  const hasFactoryLimits = hardLimits !== undefined || riskEscalation !== undefined;
  return Object.freeze({
    measures: measured.measures,
    ...(hasFactoryLimits
      ? {
          factoryLimits: Object.freeze({
            ...(hardLimits === undefined ? {} : { hard_limits: hardLimits }),
            ...(riskEscalation === undefined ? {} : { risk_escalation: riskEscalation }),
          }),
        }
      : {}),
  });
}

function frozenMinimumRisk(authority: unknown): "R4" | undefined {
  if (typeof authority !== "object" || authority === null || Array.isArray(authority)) {
    return undefined;
  }
  const risk = (authority as Readonly<Record<string, unknown>>).risk_reservation;
  if (typeof risk !== "object" || risk === null || Array.isArray(risk)) return undefined;
  const record = risk as Readonly<Record<string, unknown>>;
  return record.kind === "notification_delivery_rolling_24h" &&
    record.threshold === 10 &&
    typeof record.aggregate_units === "number" &&
    record.aggregate_units > 10
    ? "R4"
    : undefined;
}

function enforceMinimumRisk(decision: PolicyDecision, authority: unknown): PolicyDecision {
  if (decision.outcome === "deny" || frozenMinimumRisk(authority) !== "R4") return decision;
  if (decision.effectiveRisk === "R4" || decision.effectiveRisk === "R5") return decision;
  return Object.freeze({
    outcome: "step_up" as const,
    effectiveRisk: "R4" as const,
    escalated: true,
    requiresOtherApprover: true as const,
  });
}

function policyDecisionFrom(
  bus: BusContext,
  parsed: unknown,
  authority: unknown = bus.confirmAuthorization?.authority,
): PolicyDecision | null {
  const riskInput = policyRiskInputFrom(bus, parsed);
  if (riskInput === null) return null;
  return enforceMinimumRisk(
    evaluatePolicy({
      actor: policyActorFrom(bus),
      command: commandMetaFrom(bus),
      ...(riskInput === undefined ? {} : { riskInput }),
    }),
    authority,
  );
}

/** Pure C5 evaluation for tightly bounded standing authorities such as ADR-63 policies. */
export function evaluateCurrentCommandPolicy(
  bus: BusContext,
  parsed: unknown,
): PolicyDecision | null {
  return policyDecisionFrom(bus, parsed);
}

function confirmationMatchesCurrentPolicy(bus: BusContext, decision: PolicyDecision): boolean {
  const authorization = bus.confirmAuthorization;
  if (
    authorization === undefined ||
    (decision.outcome !== "confirm" && decision.outcome !== "step_up")
  ) {
    return false;
  }
  return (
    authorization.effectiveRisk === decision.effectiveRisk &&
    authorization.policyOutcome === decision.outcome &&
    authorization.requiresOtherApprover === decision.requiresOtherApprover
  );
}

/**
 * Enforce C5 risk gates:
 * - allow → continue
 * - deny → POLICY_DENIED
 * - confirm / step_up without prior card gate → create pending, fail with *_REQUIRED + confirm_ref
 * - request.confirmRef already validated in executeCommand → allow (card consumed later)
 */
export function createEnforcingPolicyCheck(
  pendingStore: PendingActionStore = processPendingActionStore,
  preparePendingAction?: PendingActionPreparer,
  preparePendingRisk?: PendingRiskPreparer,
): BusChainPorts["checkPolicy"] {
  return async (parsed, context) => {
    const bus = context.meta as BusContext;
    let decision = policyDecisionFrom(bus, parsed);

    if (decision === null) {
      return {
        ok: false,
        error: createCommandError("POLICY_DENIED"),
      };
    }

    if (bus.idempotentReplay === true) {
      return decision.outcome === "deny"
        ? {
            ok: false,
            error: createCommandError("POLICY_DENIED"),
          }
        : okPolicy();
    }

    // Confirm path: executeCommand pre-validated the card and rewrote input to frozen args.
    if (bus.confirmAuthorized === true) {
      return confirmationMatchesCurrentPolicy(bus, decision)
        ? okPolicy()
        : {
            ok: false,
            error: createCommandError("POLICY_DENIED"),
          };
    }

    if (decision.outcome === "deny") {
      return {
        ok: false,
        error: createCommandError("POLICY_DENIED"),
      };
    }

    if (decision.outcome === "allow") {
      return okPolicy();
    }

    // confirm | step_up — create WYSIWYS card and refuse direct execution.
    if (bus.transactionClient === undefined) {
      throw new Error("Pending action creation requires the command transaction");
    }
    const transaction = Object.freeze({ tenant: bus.tenant, client: bus.transactionClient });
    await pendingStore.lockPrivacy(transaction);
    const idempotencyKey = bus.request.idempotencyKey;
    if (
      idempotencyKey !== undefined &&
      bus.definition.name === "notification.delivery_batch.enqueue"
    ) {
      const existing = await pendingStore.findByIdempotency(
        bus.definition.name,
        idempotencyKey,
        transaction,
      );
      if (existing !== null) {
        const summary = notificationPendingRetrySummary(existing, parsed, bus);
        return summary === null
          ? { ok: false, error: createCommandError("POLICY_DENIED") }
          : pendingResponse(existing, summary);
      }
    }
    const earlyRiskRequest = preparePendingRisk?.(parsed, bus) ?? null;
    const earlyRiskReservation =
      earlyRiskRequest === null
        ? undefined
        : await measurePendingRisk(pendingStore, earlyRiskRequest, transaction);
    if (earlyRiskReservation === null) {
      return { ok: false, error: createCommandError("POLICY_DENIED") };
    }
    let preparation =
      preparePendingAction === undefined ? null : await preparePendingAction(parsed, bus);
    if (idempotencyKey !== undefined && REUSABLE_PENDING_COMMANDS.has(bus.definition.name)) {
      const existing = await pendingStore.findByIdempotency(
        bus.definition.name,
        idempotencyKey,
        transaction,
      );
      if (existing !== null) {
        return preparedPendingRetryMatches(existing, parsed, bus, preparation, decision)
          ? pendingResponse(existing, preparation?.summary)
          : { ok: false, error: createCommandError("POLICY_DENIED") };
      }
    }
    if (preparation?.riskReservation !== undefined) {
      let reservation;
      if (earlyRiskRequest !== null) {
        if (!sameRiskRequest(earlyRiskRequest, preparation.riskReservation)) {
          return { ok: false, error: createCommandError("POLICY_DENIED") };
        }
        reservation = earlyRiskReservation;
      } else {
        reservation = await measurePendingRisk(
          pendingStore,
          preparation.riskReservation,
          transaction,
        );
        if (reservation === null) {
          return { ok: false, error: createCommandError("POLICY_DENIED") };
        }
      }
      if (reservation === undefined) throw new Error("Pending risk reservation is missing");
      preparation = bindRiskReservation(preparation, reservation);
      decision = policyDecisionFrom(bus, parsed, preparation.authority);
      if (decision === null || decision.outcome === "deny" || decision.outcome === "allow") {
        return {
          ok: false,
          error: createCommandError("POLICY_DENIED"),
        };
      }
    } else if (earlyRiskRequest !== null) {
      return { ok: false, error: createCommandError("POLICY_DENIED") };
    }
    const nonce = randomUUID();
    const now = preparation?.createdAtEpoch ?? Math.floor(Date.now() / 1000);
    await pendingStore.create(
      {
        nonce,
        command: bus.definition.name,
        commandVersion: bus.definition.version,
        args: parsed,
        ...(preparation === null ? {} : { authority: preparation.authority }),
        entityVersions: Object.freeze([]),
        creatorStaffId: bus.actor.staffId,
        orgId: bus.tenant.orgId,
        storeId: bus.tenant.storeId,
        idempotencyKey: idempotencyKey ?? nonce,
        privacySubjectCustomerId:
          preparation?.privacySubjectCustomerId ??
          customerPrivacySubjectFromCommand(bus.definition.name, parsed),
        createdAt: now,
        effectiveRisk: decision.effectiveRisk,
        policyOutcome: decision.outcome,
        requiresOtherApprover: decision.requiresOtherApprover,
      },
      transaction,
    );

    const code =
      decision.outcome === "confirm"
        ? ("POLICY_CONFIRMATION_REQUIRED" as const)
        : ("POLICY_STEP_UP_REQUIRED" as const);

    return {
      ok: false,
      error: createCommandError(code, {
        kind: "confirmation",
        confirm_ref: nonce,
        ...(preparation?.summary === undefined ? {} : { summary: preparation.summary }),
      }),
    };
  };
}

export const defaultCheckPolicy: BusChainPorts["checkPolicy"] =
  createEnforcingPolicyCheck(processPendingActionStore);

/** Build default hooks; callers may override individual steps. */
export function createDefaultChainHooks(
  overrides: ChainPortHooks = {},
  pendingStore: PendingActionStore = processPendingActionStore,
  preparePendingAction?: PendingActionPreparer,
  preparePendingRisk?: PendingRiskPreparer,
): ChainPortHooks {
  return Object.freeze({
    checkRbac: overrides.checkRbac ?? defaultCheckRbac,
    checkTenant: overrides.checkTenant ?? defaultCheckTenant,
    checkPolicy:
      overrides.checkPolicy ??
      createEnforcingPolicyCheck(pendingStore, preparePendingAction, preparePendingRisk),
    checkInvariants: overrides.checkInvariants ?? defaultCheckInvariants,
  });
}

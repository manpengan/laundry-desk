/**
 * Default C1 chain port hooks for M1 integration wiring.
 *
 * - parse: always definition-bound in createChainPorts (not overridden here)
 * - rbac: allow when every `rbac.*` invariant permission is present on actor
 * - tenant: always allow (unit/integration tests; production GUC still scopes rows)
 * - policy: C5 evaluatePolicy — confirm/step_up fail-closed unless confirm_ref path
 * - invariants: allow (concrete invariant runners land later)
 */

import { randomUUID } from "node:crypto";

import { createCommandError, type CommandError } from "@laundry/contracts";
import type { StepResult } from "@laundry/domain";

import type { BusChainPorts, ChainPortHooks } from "../bus/chain-adapter.js";
import type { ActorContext, BusContext } from "../bus/types.js";
import { evaluatePolicy } from "../policy/evaluate-policy.js";
import type { PolicyActor, PolicyCommandMeta, PolicyDecision } from "../policy/types.js";
import { processPendingActionStore } from "../pending-actions/process-store.js";
import type { PendingActionStore } from "../pending-actions/types.js";

const okVoid = (): StepResult<void, CommandError> => ({ ok: true, data: undefined });

const okInvariants = (): StepResult<Readonly<{ preview: true }>, CommandError> => ({
  ok: true,
  data: Object.freeze({ preview: true as const }),
});

const okPolicy = (): StepResult<Readonly<{ allowed: true }>, CommandError> => ({
  ok: true,
  data: Object.freeze({ allowed: true as const }),
});

/** Permissions implied by `rbac.<code>` invariant bindings on a command definition. */
export function requiredPermissionsFromInvariants(
  invariants: readonly string[],
): readonly string[] {
  return Object.freeze(
    invariants
      .filter((name) => name.startsWith("rbac."))
      .map((name) => name.slice("rbac.".length))
      .filter((code) => code.length > 0),
  );
}

export function actorPermissionSet(actor: ActorContext): ReadonlySet<string> {
  return new Set(actor.permissions ?? []);
}

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

/**
 * Enforce C5 risk gates:
 * - allow → continue
 * - deny → POLICY_DENIED
 * - confirm / step_up without prior card gate → create pending, fail with *_REQUIRED + confirm_ref
 * - request.confirmRef already validated in executeCommand → allow (card consumed later)
 */
export function createEnforcingPolicyCheck(
  pendingStore: PendingActionStore = processPendingActionStore,
): BusChainPorts["checkPolicy"] {
  return async (parsed, context) => {
    const bus = context.meta as BusContext;

    // Confirm path: executeCommand pre-validated the card and rewrote input to frozen args.
    if (bus.confirmAuthorized === true) {
      return okPolicy();
    }

    const decision: PolicyDecision = evaluatePolicy({
      actor: policyActorFrom(bus),
      command: commandMetaFrom(bus),
    });

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
    const nonce = randomUUID();
    const now = Math.floor(Date.now() / 1000);
    pendingStore.create({
      nonce,
      command: bus.definition.name,
      commandVersion: bus.definition.version,
      args: parsed,
      entityVersions: Object.freeze([]),
      creatorStaffId: bus.actor.staffId,
      orgId: bus.tenant.orgId,
      storeId: bus.tenant.storeId,
      idempotencyKey: bus.request.idempotencyKey ?? nonce,
      createdAt: now,
      effectiveRisk: decision.effectiveRisk,
      policyOutcome: decision.outcome,
      requiresOtherApprover: decision.requiresOtherApprover,
    });

    const code =
      decision.outcome === "confirm"
        ? ("POLICY_CONFIRMATION_REQUIRED" as const)
        : ("POLICY_STEP_UP_REQUIRED" as const);

    return {
      ok: false,
      error: createCommandError(code, {
        kind: "confirmation",
        confirm_ref: nonce,
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
): ChainPortHooks {
  return Object.freeze({
    checkRbac: overrides.checkRbac ?? defaultCheckRbac,
    checkTenant: overrides.checkTenant ?? defaultCheckTenant,
    checkPolicy: overrides.checkPolicy ?? createEnforcingPolicyCheck(pendingStore),
    checkInvariants: overrides.checkInvariants ?? defaultCheckInvariants,
  });
}

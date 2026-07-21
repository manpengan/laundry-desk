/**
 * Default C1 chain port hooks for M1 integration wiring.
 *
 * - parse: always definition-bound in createChainPorts (not overridden here)
 * - rbac: allow when every `rbac.*` invariant permission is present on actor
 * - tenant: always allow (unit/integration tests; production GUC still scopes rows)
 * - policy: C5 evaluatePolicy / checkPolicy
 * - invariants: allow (concrete invariant runners land later)
 */

import { createCommandError, type CommandError } from "@laundry/contracts";
import type { StepResult } from "@laundry/domain";

import type { BusChainPorts, ChainPortHooks } from "../bus/chain-adapter.js";
import type { ActorContext, BusContext } from "../bus/types.js";
import { checkPolicy } from "../policy/evaluate-policy.js";
import type { PolicyActor, PolicyCommandMeta } from "../policy/types.js";

const okVoid = (): StepResult<void, CommandError> => ({ ok: true, data: undefined });

const okInvariants = (): StepResult<Readonly<{ preview: true }>, CommandError> => ({
  ok: true,
  data: Object.freeze({ preview: true as const }),
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

export const defaultCheckPolicy: BusChainPorts["checkPolicy"] = async (_parsed, context) => {
  const bus = context.meta as BusContext;
  const policyActor: PolicyActor = Object.freeze({
    staffId: bus.actor.staffId,
    via: bus.actor.via,
    permissions: Object.freeze([...(bus.actor.permissions ?? [])]),
    ...(bus.actor.riskCap !== undefined ? { riskCap: bus.actor.riskCap } : {}),
  });
  const command: PolicyCommandMeta = Object.freeze({
    name: bus.definition.name,
    baseRisk: bus.definition.risk,
  });

  const decision = checkPolicy({ actor: policyActor, command });
  if (decision.ok === false) {
    return {
      ok: false,
      error: createCommandError("POLICY_DENIED"),
    };
  }
  // allow | confirm | step_up — materialization of pending cards is residual.
  return {
    ok: true,
    data: Object.freeze({ allowed: true as const }),
  };
};

/** Build default hooks; callers may override individual steps. */
export function createDefaultChainHooks(overrides: ChainPortHooks = {}): ChainPortHooks {
  return Object.freeze({
    checkRbac: overrides.checkRbac ?? defaultCheckRbac,
    checkTenant: overrides.checkTenant ?? defaultCheckTenant,
    checkPolicy: overrides.checkPolicy ?? defaultCheckPolicy,
    checkInvariants: overrides.checkInvariants ?? defaultCheckInvariants,
  });
}

/**
 * C5 pure policy evaluation.
 *
 * Decision table (ADR-05 / architecture §6.5):
 * | Effective risk | ui              | ai (+ risk_cap) | automation     | edge_replay    |
 * |----------------|-----------------|-----------------|----------------|----------------|
 * | R0 / R1 / R2   | allow           | allow if ≤cap   | allow          | allow          |
 * | R3             | confirm         | confirm if ≤cap | confirm        | confirm        |
 * | R4             | step_up         | step_up if ≤cap | deny           | deny           |
 * | R5             | step_up         | deny            | deny           | deny           |
 *
 * Optional B4 `evaluateRisk` upgrades R3→R4 via measures/thresholds.
 */

import { evaluateRisk, type EvaluateRiskResult, type RiskLevel } from "@laundry/domain";

import type {
  EvaluatePolicyInput,
  PolicyActor,
  PolicyDecision,
  PolicyDenyReason,
  PolicyPortError,
} from "./types.js";

const RISK_RANK: Readonly<Record<RiskLevel, number>> = Object.freeze({
  R0: 0,
  R1: 1,
  R2: 2,
  R3: 3,
  R4: 4,
  R5: 5,
});

const isRiskLevel = (value: string): value is RiskLevel =>
  Object.prototype.hasOwnProperty.call(RISK_RANK, value);

const riskAtMost = (risk: RiskLevel, cap: RiskLevel): boolean => RISK_RANK[risk] <= RISK_RANK[cap];

const deny = (
  effectiveRisk: RiskLevel,
  escalated: boolean,
  reason: PolicyDenyReason,
  message: string,
): PolicyDecision =>
  Object.freeze({
    outcome: "deny" as const,
    effectiveRisk,
    escalated,
    reason,
    message,
  });

const allow = (effectiveRisk: RiskLevel, escalated: boolean): PolicyDecision =>
  Object.freeze({ outcome: "allow" as const, effectiveRisk, escalated });

const confirm = (effectiveRisk: RiskLevel, escalated: boolean): PolicyDecision =>
  Object.freeze({
    outcome: "confirm" as const,
    effectiveRisk,
    escalated,
    requiresOtherApprover: false as const,
  });

const stepUp = (effectiveRisk: RiskLevel, escalated: boolean): PolicyDecision =>
  Object.freeze({
    outcome: "step_up" as const,
    effectiveRisk,
    escalated,
    requiresOtherApprover: true as const,
  });

type ResolvedRisk = Readonly<{ risk: RiskLevel; escalated: boolean }>;

const resolveEffectiveRisk = (input: EvaluatePolicyInput): ResolvedRisk | PolicyDecision => {
  if (!isRiskLevel(input.command.baseRisk)) {
    return deny("R5", false, "unknown_risk", `Unknown base risk: ${input.command.baseRisk}`);
  }

  if (input.riskInput === undefined) {
    return Object.freeze({ risk: input.command.baseRisk, escalated: false });
  }

  const evaluated: EvaluateRiskResult = evaluateRisk({
    baseRisk: input.command.baseRisk,
    measures: input.riskInput.measures,
    ...(input.riskInput.factoryLimits !== undefined
      ? { factoryLimits: input.riskInput.factoryLimits }
      : {}),
    ...(input.riskInput.orgOverride !== undefined
      ? { orgOverride: input.riskInput.orgOverride }
      : {}),
  });

  if (!evaluated.ok) {
    if (evaluated.code === "hard_limit_exceeded") {
      return deny(input.command.baseRisk, false, "hard_limit_exceeded", evaluated.message);
    }
    return deny(input.command.baseRisk, false, "risk_eval_failed", evaluated.message);
  }

  return Object.freeze({ risk: evaluated.risk, escalated: evaluated.escalated });
};

const checkPermission = (
  actor: PolicyActor,
  required: string | undefined,
  risk: RiskLevel,
  escalated: boolean,
): PolicyDecision | undefined => {
  if (required === undefined) return undefined;
  if (actor.permissions.includes(required)) return undefined;
  return deny(risk, escalated, "missing_permission", `Missing permission: ${required}`);
};

const checkAiCap = (
  actor: PolicyActor,
  risk: RiskLevel,
  escalated: boolean,
): PolicyDecision | undefined => {
  if (actor.via !== "ai") return undefined;
  if (risk === "R5") {
    return deny(risk, escalated, "ai_r5_forbidden", "R5 commands are never available to AI");
  }
  if (actor.riskCap !== undefined && !riskAtMost(risk, actor.riskCap)) {
    return deny(
      risk,
      escalated,
      "risk_cap_exceeded",
      `Effective risk ${risk} exceeds AI risk_cap ${actor.riskCap}`,
    );
  }
  return undefined;
};

/**
 * Map effective risk + via → allow | confirm | step_up | deny.
 * Does not create pending cards; callers materialize confirm/step_up via pending store.
 */
export function evaluatePolicy(input: EvaluatePolicyInput): PolicyDecision {
  const resolved = resolveEffectiveRisk(input);
  if ("outcome" in resolved) return resolved;

  const { risk, escalated } = resolved;
  const { actor, command } = input;

  const permissionDeny = checkPermission(actor, command.requiredPermission, risk, escalated);
  if (permissionDeny !== undefined) return permissionDeny;

  const aiDeny = checkAiCap(actor, risk, escalated);
  if (aiDeny !== undefined) return aiDeny;

  if (risk === "R0" || risk === "R1" || risk === "R2") {
    return allow(risk, escalated);
  }

  if (risk === "R3") {
    return confirm(risk, escalated);
  }

  // R4 / R5
  if (actor.via === "automation") {
    return deny(
      risk,
      escalated,
      "automation_r4_plus_forbidden",
      "Automation may not execute R4+ commands (hard red line)",
    );
  }
  if (actor.via === "edge_replay") {
    return deny(
      risk,
      escalated,
      "edge_r4_plus_forbidden",
      "Edge offline replay may not execute R4+ commands",
    );
  }
  if (actor.via === "ai" && risk === "R5") {
    return deny(risk, escalated, "ai_r5_forbidden", "R5 commands are never available to AI");
  }

  return stepUp(risk, escalated);
}

/** Convert a deny decision into the command-chain policy step error shape. */
export function policyDecisionToPortError(decision: PolicyDecision): PolicyPortError | null {
  if (decision.outcome !== "deny") return null;
  return Object.freeze({
    code: "POLICY_DENIED" as const,
    reason: decision.reason,
    message: decision.message,
    effectiveRisk: decision.effectiveRisk,
  });
}

/**
 * Domain command-chain policy port adapter.
 * - deny → `{ ok: false, error }` (fail-closed)
 * - allow | confirm | step_up → `{ ok: true, data: decision }`
 *
 * Compatible with `CommandChainPorts.checkPolicy` (domain B2).
 */
export function checkPolicy(
  input: EvaluatePolicyInput,
): Readonly<{ ok: true; data: PolicyDecision }> | Readonly<{ ok: false; error: PolicyPortError }> {
  const decision = evaluatePolicy(input);
  if (decision.outcome === "deny") {
    return Object.freeze({
      ok: false as const,
      error: Object.freeze({
        code: "POLICY_DENIED" as const,
        reason: decision.reason,
        message: decision.message,
        effectiveRisk: decision.effectiveRisk,
      }),
    });
  }
  return Object.freeze({ ok: true as const, data: decision });
}

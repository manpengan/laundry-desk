/**
 * C5 Policy Engine types (ADR-05).
 * Decisions drive Command Bus policy step: allow / confirm card / step-up / deny.
 */

import type { LimitGroups, MeasuredSizes, RiskLevel } from "@laundry/domain";

/** Outcomes of pure policy evaluation (before pending-card / step-up IO). */
export type PolicyOutcome = "allow" | "deny" | "confirm" | "step_up";

export type CommandVia = "ui" | "ai" | "automation" | "edge_replay";

/**
 * Actor facts available at the policy step.
 * RBAC may already have passed; policy still enforces risk gates + AI risk_cap.
 */
export type PolicyActor = Readonly<{
  staffId: string;
  via: CommandVia;
  /** Permission codes the actor holds (fail-closed if requiredPermission missing). */
  permissions: readonly string[];
  /**
   * AI preset risk ceiling (architecture §9.4). Commands whose effective risk
   * exceeds this cap are denied for via=ai. Omit for non-AI actors.
   */
  riskCap?: RiskLevel;
}>;

export type PolicyCommandMeta = Readonly<{
  name: string;
  /** Base risk from A1 command definition (before B4 escalation). */
  baseRisk: RiskLevel;
  /** Optional permission code required in addition to RBAC port. */
  requiredPermission?: string;
}>;

/**
 * Optional B4 inputs. When omitted, `baseRisk` is used as the effective risk.
 * When present, `evaluateRisk` runs; hard-limit failures become deny.
 */
export type PolicyRiskInput = Readonly<{
  measures: MeasuredSizes;
  factoryLimits?: LimitGroups;
  orgOverride?: LimitGroups;
}>;

export type EvaluatePolicyInput = Readonly<{
  actor: PolicyActor;
  command: PolicyCommandMeta;
  riskInput?: PolicyRiskInput;
}>;

export type PolicyDenyReason =
  | "missing_permission"
  | "risk_cap_exceeded"
  | "ai_r5_forbidden"
  | "automation_r4_plus_forbidden"
  | "edge_r4_plus_forbidden"
  | "hard_limit_exceeded"
  | "risk_eval_failed"
  | "unknown_risk";

export type PolicyDecisionAllow = Readonly<{
  outcome: "allow";
  effectiveRisk: RiskLevel;
  escalated: boolean;
}>;

export type PolicyDecisionConfirm = Readonly<{
  outcome: "confirm";
  effectiveRisk: RiskLevel;
  escalated: boolean;
  /** Pending card must require a different staff member as approver. */
  requiresOtherApprover: false;
}>;

export type PolicyDecisionStepUp = Readonly<{
  outcome: "step_up";
  effectiveRisk: RiskLevel;
  escalated: boolean;
  /** R4+ step-up: creator cannot self-approve (ADR-05 #11). */
  requiresOtherApprover: true;
}>;

export type PolicyDecisionDeny = Readonly<{
  outcome: "deny";
  effectiveRisk: RiskLevel;
  escalated: boolean;
  reason: PolicyDenyReason;
  message: string;
}>;

export type PolicyDecision =
  PolicyDecisionAllow | PolicyDecisionConfirm | PolicyDecisionStepUp | PolicyDecisionDeny;

/** Structured error returned by checkPolicy port on deny. */
export type PolicyPortError = Readonly<{
  code: "POLICY_DENIED";
  reason: PolicyDenyReason;
  message: string;
  effectiveRisk: RiskLevel;
}>;

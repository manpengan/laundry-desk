/**
 * B4: risk evaluation pure function.
 * Fixed order (ADR-09): measured sizes → hard_limits (reject) → risk_escalation (R3→R4 only).
 * Per-org overrides may only tighten existing factory lines.
 */

import type { MeasuredSizes } from "./measure-input.js";

export type RiskLevel = "R0" | "R1" | "R2" | "R3" | "R4" | "R5";

export type Thresholds = {
  readonly max_batch?: number;
  readonly max_amount_cents?: number;
};

/** Factory or org override groups for hard rejection and R3→R4 escalation. */
export type LimitGroups = {
  readonly hard_limits?: Thresholds;
  readonly risk_escalation?: Thresholds;
};

export type EvaluateRiskParams = {
  readonly baseRisk: RiskLevel;
  readonly measures: MeasuredSizes;
  /** Factory lines from the command registry; defaults to no limits. */
  readonly factoryLimits?: LimitGroups;
  /** Optional per-org override; must only tighten factory lines. */
  readonly orgOverride?: LimitGroups;
};

export type EvaluateRiskSuccess = {
  readonly ok: true;
  readonly risk: RiskLevel;
  readonly escalated: boolean;
  readonly effectiveLimits: LimitGroups;
};

export type EvaluateRiskFailureCode =
  | "hard_limit_exceeded"
  | "invalid_override"
  | "missing_measure"
  | "invalid_threshold"
  | "invalid_base_risk";

export type EvaluateRiskFailure = {
  readonly ok: false;
  readonly code: EvaluateRiskFailureCode;
  readonly message: string;
  readonly dimension?: "max_batch" | "max_amount_cents";
  readonly measured?: number;
  readonly limit?: number;
};

export type EvaluateRiskResult = EvaluateRiskSuccess | EvaluateRiskFailure;

const RISK_LEVELS = new Set<RiskLevel>(["R0", "R1", "R2", "R3", "R4", "R5"]);
const LIMIT_GROUPS = ["hard_limits", "risk_escalation"] as const;
const DIMENSIONS = ["max_batch", "max_amount_cents"] as const;

type Dimension = (typeof DIMENSIONS)[number];
type LimitGroupName = (typeof LIMIT_GROUPS)[number];

const fail = (
  code: EvaluateRiskFailureCode,
  message: string,
  extras: Omit<EvaluateRiskFailure, "ok" | "code" | "message"> = {},
): EvaluateRiskFailure => Object.freeze({ ok: false, code, message, ...extras });

const isPositiveSafeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

const readDimension = (thresholds: Thresholds | undefined, dimension: Dimension): number | undefined => {
  if (thresholds === undefined || !Object.hasOwn(thresholds, dimension)) return undefined;
  const value = thresholds[dimension];
  return value;
};

const assertThresholdValue = (
  value: number | undefined,
  path: string,
): EvaluateRiskFailure | undefined => {
  if (value === undefined) return undefined;
  if (!isPositiveSafeInteger(value)) {
    return fail("invalid_threshold", `${path} must be a positive safe integer`);
  }
  return undefined;
};

const validateThresholds = (
  thresholds: Thresholds | undefined,
  group: LimitGroupName,
): EvaluateRiskFailure | undefined => {
  if (thresholds === undefined) return undefined;
  for (const dimension of DIMENSIONS) {
    const value = readDimension(thresholds, dimension);
    const invalid = assertThresholdValue(value, `${group}.${dimension}`);
    if (invalid !== undefined) return invalid;
  }
  return undefined;
};

const validateLimitGroups = (limits: LimitGroups, label: string): EvaluateRiskFailure | undefined => {
  for (const group of LIMIT_GROUPS) {
    const invalid = validateThresholds(limits[group], group);
    if (invalid !== undefined) {
      return fail(invalid.code, `${label}: ${invalid.message}`);
    }
  }
  return undefined;
};

const freezeThresholds = (thresholds: Thresholds): Thresholds => {
  const next: { max_batch?: number; max_amount_cents?: number } = {};
  const batch = readDimension(thresholds, "max_batch");
  const amount = readDimension(thresholds, "max_amount_cents");
  if (batch !== undefined) next.max_batch = batch;
  if (amount !== undefined) next.max_amount_cents = amount;
  return Object.freeze(next);
};

const freezeLimitGroups = (limits: LimitGroups): LimitGroups => {
  const next: { hard_limits?: Thresholds; risk_escalation?: Thresholds } = {};
  if (limits.hard_limits !== undefined) next.hard_limits = freezeThresholds(limits.hard_limits);
  if (limits.risk_escalation !== undefined) {
    next.risk_escalation = freezeThresholds(limits.risk_escalation);
  }
  return Object.freeze(next);
};

const mergeThresholds = (
  factory: Thresholds | undefined,
  override: Thresholds | undefined,
): Thresholds | undefined => {
  if (factory === undefined) return undefined;
  if (override === undefined) return freezeThresholds(factory);
  return freezeThresholds({ ...factory, ...override });
};

const rejectWiderOverride = (
  factory: LimitGroups,
  override: LimitGroups,
): EvaluateRiskFailure | undefined => {
  for (const group of LIMIT_GROUPS) {
    const overrideGroup = override[group];
    if (overrideGroup === undefined) continue;
    for (const dimension of DIMENSIONS) {
      const overrideValue = readDimension(overrideGroup, dimension);
      if (overrideValue === undefined) continue;
      const factoryValue = readDimension(factory[group], dimension);
      if (factoryValue !== undefined && overrideValue <= factoryValue) continue;
      const extras: { dimension: Dimension; measured: number; limit?: number } = {
        dimension,
        measured: overrideValue,
      };
      if (factoryValue !== undefined) extras.limit = factoryValue;
      return fail(
        "invalid_override",
        `Org override may only tighten factory ${group}.${dimension}`,
        extras,
      );
    }
  }
  return undefined;
};

const rejectEscalationAboveHard = (
  hardLimits: Thresholds | undefined,
  riskEscalation: Thresholds | undefined,
): EvaluateRiskFailure | undefined => {
  for (const dimension of DIMENSIONS) {
    const hard = readDimension(hardLimits, dimension);
    const escalation = readDimension(riskEscalation, dimension);
    if (hard !== undefined && escalation !== undefined && escalation > hard) {
      return fail(
        "invalid_override",
        `Risk escalation must not exceed hard limit for ${dimension}`,
        { dimension, measured: escalation, limit: hard },
      );
    }
  }
  return undefined;
};

/**
 * Merge org override onto factory lines. Override may only tighten existing dimensions.
 * Mirrors contracts `validateStricterLimitOverride` semantics without importing contracts.
 */
export function mergeStricterLimitOverride(
  factory: LimitGroups,
  override: LimitGroups,
): { readonly ok: true; readonly limits: LimitGroups } | EvaluateRiskFailure {
  const factoryError = validateLimitGroups(factory, "factory");
  if (factoryError !== undefined) return factoryError;
  const overrideError = validateLimitGroups(override, "override");
  if (overrideError !== undefined) return overrideError;
  const wider = rejectWiderOverride(factory, override);
  if (wider !== undefined) return wider;

  const hardLimits = mergeThresholds(factory.hard_limits, override.hard_limits);
  const riskEscalation = mergeThresholds(factory.risk_escalation, override.risk_escalation);
  const ordering = rejectEscalationAboveHard(hardLimits, riskEscalation);
  if (ordering !== undefined) return ordering;

  const limits: { hard_limits?: Thresholds; risk_escalation?: Thresholds } = {};
  if (hardLimits !== undefined) limits.hard_limits = hardLimits;
  if (riskEscalation !== undefined) limits.risk_escalation = riskEscalation;
  return Object.freeze({ ok: true, limits: freezeLimitGroups(limits) });
}

const measureForDimension = (measures: MeasuredSizes, dimension: Dimension): number | undefined => {
  if (dimension === "max_batch") return measures.batch;
  return measures.amount_cents;
};

const exceeds = (measured: number, limit: number): boolean => measured > limit;

const checkHardLimits = (
  measures: MeasuredSizes,
  hardLimits: Thresholds | undefined,
): EvaluateRiskFailure | undefined => {
  if (hardLimits === undefined) return undefined;
  for (const dimension of DIMENSIONS) {
    const limit = readDimension(hardLimits, dimension);
    if (limit === undefined) continue;
    const measured = measureForDimension(measures, dimension);
    if (measured === undefined) {
      return fail("missing_measure", `hard_limits.${dimension} requires a measured value`, {
        dimension,
        limit,
      });
    }
    if (exceeds(measured, limit)) {
      return fail("hard_limit_exceeded", `Measured ${dimension} exceeds hard limit`, {
        dimension,
        measured,
        limit,
      });
    }
  }
  return undefined;
};

const shouldEscalate = (measures: MeasuredSizes, escalation: Thresholds | undefined): boolean => {
  if (escalation === undefined) return false;
  for (const dimension of DIMENSIONS) {
    const limit = readDimension(escalation, dimension);
    if (limit === undefined) continue;
    const measured = measureForDimension(measures, dimension);
    if (measured === undefined) continue;
    if (exceeds(measured, limit)) return true;
  }
  return false;
};

/**
 * Evaluate effective risk after hard-limit rejection and R3→R4 escalation.
 * Never reverses order: hard_limits reject before risk_escalation is considered.
 */
export function evaluateRisk(params: EvaluateRiskParams): EvaluateRiskResult {
  if (!RISK_LEVELS.has(params.baseRisk)) {
    return fail("invalid_base_risk", `Unknown base risk: ${String(params.baseRisk)}`);
  }

  const factory = params.factoryLimits ?? Object.freeze({});
  const factoryError = validateLimitGroups(factory, "factory");
  if (factoryError !== undefined) return factoryError;

  let effective: LimitGroups;
  if (params.orgOverride !== undefined) {
    const merged = mergeStricterLimitOverride(factory, params.orgOverride);
    if (!merged.ok) return merged;
    effective = merged.limits;
  } else {
    effective = freezeLimitGroups(factory);
  }

  const hardReject = checkHardLimits(params.measures, effective.hard_limits);
  if (hardReject !== undefined) return hardReject;

  // Escalation is defined only for base R3 (ADR-09 revision 2 / ADR-05).
  if (params.baseRisk === "R3" && shouldEscalate(params.measures, effective.risk_escalation)) {
    return Object.freeze({
      ok: true,
      risk: "R4",
      escalated: true,
      effectiveLimits: effective,
    });
  }

  return Object.freeze({
    ok: true,
    risk: params.baseRisk,
    escalated: false,
    effectiveLimits: effective,
  });
}

import { z } from "zod";

import {
  LimitConfigurationSchema,
  PositiveSafeIntegerSchema,
  SizeMeasuresSchema,
  ThresholdsSchema,
} from "./limits.js";
import {
  CommandNameSchema,
  RedactionRuleSchema,
  RedactionRulesSchema,
  SemVerSchema,
  StableBindingIdsSchema,
  type RedactionRule,
} from "./primitives.js";

/** Architecture §6.5 / ADR-05 #4: command risk classification. */
export const RiskSchema = z.enum(["R0", "R1", "R2", "R3", "R4", "R5"]);

/** A1 query boundary: reads may only declare R0 through R2. */
export const QueryRiskSchema = z.enum(["R0", "R1", "R2"]);

/** ADR-04 #7 / ADR-09: the authorization required for offline command execution. */
export const OfflineModeSchema = z.enum(["denied", "grant", "primary_lease"]);

/** ADR-05 #12: commands may receive secrets; queries may not return them. */
export const CommandDataClassificationSchema = z.enum(["public", "internal", "pii", "secret"]);
export const QueryDataClassificationSchema = z.enum(["public", "internal", "pii"]);

/** Backward-compatible public alias; command metadata owns the complete classification set. */
export const DataClassificationSchema = CommandDataClassificationSchema;
export const ResultRedactionRuleSchema = RedactionRuleSchema;
export const InputRedactionRuleSchema = RedactionRuleSchema;

/** A1 fail-closed ceiling for PII query projection and transport. */
export const PII_QUERY_MAX_RESULT_ROWS = 1_000;

const CommonMetadataShape = {
  /** Architecture §6.5: stable dotted command/query identifier. */
  name: CommandNameSchema,
  /** ADR-08: full definition SemVer. */
  version: SemVerSchema,
  /** Architecture §6.5: human-facing behavior description. */
  description: z.string().trim().min(1),
  /** ADR-05 #2: authoritative LLM-facing behavior description used by C4. */
  description_llm: z.string().trim().min(1),
  /** Architecture §6.5: executable invariant binding names. */
  invariants: StableBindingIdsSchema,
  /** Architecture §6.5: whether replay with one idempotency key is safe. */
  idempotent: z.boolean(),
  /** ADR-05 #1: executable event or side-effect binding names. */
  sideEffects: StableBindingIdsSchema,
  /** ADR-04 #7 / ADR-09: offline authorization class, not an authorization grant. */
  offline_mode: OfflineModeSchema,
  /** ADR-05 #2/#12: independent input audit/projection redaction rules. */
  input_redaction: RedactionRulesSchema,
  /** ADR-05 #2/#12: independent result audit/projection redaction rules. */
  result_redaction: RedactionRulesSchema,
};

const CommandMetadataBaseSchema = z
  .object({
    ...CommonMetadataShape,
    kind: z.literal("command"),
    /** Architecture §6.5 / ADR-05 #4: R0 through R5 command risk. */
    risk: RiskSchema,
    /** ADR-05 #12: includes secret for credential-bearing R5 command input. */
    data_classification: CommandDataClassificationSchema,
    /** ADR-09: deterministic batch and/or amount measurement declarations. */
    size_measures: SizeMeasuresSchema.optional(),
    /** ADR-09: direct-rejection factory thresholds. */
    hard_limits: ThresholdsSchema.optional(),
    /** ADR-09: R3-to-R4 step-up factory thresholds. */
    risk_escalation: ThresholdsSchema.optional(),
  })
  .strict();

type CommandMetadataValue = z.infer<typeof CommandMetadataBaseSchema>;

const addCommandLimitIssues = (
  metadata: CommandMetadataValue,
  context: z.core.$RefinementCtx<CommandMetadataValue>,
): void => {
  const result = LimitConfigurationSchema.safeParse({
    ...(metadata.size_measures === undefined ? {} : { size_measures: metadata.size_measures }),
    ...(metadata.hard_limits === undefined ? {} : { hard_limits: metadata.hard_limits }),
    ...(metadata.risk_escalation === undefined
      ? {}
      : { risk_escalation: metadata.risk_escalation }),
  });
  if (!result.success) {
    result.error.issues.forEach((issue) =>
      context.addIssue({ code: "custom", message: issue.message, path: issue.path }),
    );
  }
};

const addSecretIssues = (
  metadata: CommandMetadataValue,
  context: z.core.$RefinementCtx<CommandMetadataValue>,
): void => {
  if (metadata.data_classification !== "secret") return;
  if (metadata.risk !== "R5") {
    context.addIssue({ code: "custom", message: "Secret commands must be R5", path: ["risk"] });
  }
  if (metadata.offline_mode !== "denied") {
    context.addIssue({
      code: "custom",
      message: "Secret commands must deny offline execution",
      path: ["offline_mode"],
    });
  }
  if (
    metadata.input_redaction.length === 0 ||
    metadata.input_redaction.some((rule) => rule.strategy !== "remove")
  ) {
    context.addIssue({
      code: "custom",
      message: "Secret command input redaction must be non-empty and remove-only",
      path: ["input_redaction"],
    });
  }
};

/** ADR-09 / A1: the complete strict command metadata contract. */
export const CommandMetadataSchema = CommandMetadataBaseSchema.superRefine((metadata, context) => {
  addCommandLimitIssues(metadata, context);
  if (metadata.offline_mode !== "denied" && !metadata.idempotent) {
    context.addIssue({
      code: "custom",
      message: "Offline-authorized commands must be idempotent",
      path: ["idempotent"],
    });
  }
  if (metadata.risk_escalation !== undefined && metadata.risk !== "R3") {
    context.addIssue({
      code: "custom",
      message: "Risk escalation is only defined for base risk R3",
      path: ["risk_escalation"],
    });
  }
  addSecretIssues(metadata, context);
});

const QueryMetadataBaseSchema = z
  .object({
    ...CommonMetadataShape,
    kind: z.literal("query"),
    /** A1 query boundary: query risk is restricted to R0 through R2. */
    risk: QueryRiskSchema,
    /** A1 query boundary: query definitions are always idempotent. */
    idempotent: z.literal(true),
    /** A1 query boundary: queries declare no command invariants. */
    invariants: z.array(z.never()).length(0),
    /** A1 query boundary: queries declare no side effects. */
    sideEffects: z.array(z.never()).length(0),
    /** Architecture §11: server queries are not queued or replayed offline. */
    offline_mode: z.literal("denied"),
    /** ADR-05 #12: queries may return public, internal, or PII data, never secrets. */
    data_classification: QueryDataClassificationSchema,
    /** A1 review: hard upper bound on returned result rows. */
    max_result_rows: PositiveSafeIntegerSchema,
  })
  .strict();

/** A1: the complete strict, bounded, side-effect-free query metadata contract. */
export const QueryMetadataSchema = QueryMetadataBaseSchema.superRefine((metadata, context) => {
  if (metadata.data_classification !== "pii") return;
  if (metadata.risk !== "R2") {
    context.addIssue({ code: "custom", message: "PII queries must be R2", path: ["risk"] });
  }
  if (metadata.result_redaction.length === 0) {
    context.addIssue({
      code: "custom",
      message: "PII queries must declare result redaction",
      path: ["result_redaction"],
    });
  }
  if (metadata.max_result_rows > PII_QUERY_MAX_RESULT_ROWS) {
    context.addIssue({
      code: "custom",
      message: `PII queries may return at most ${PII_QUERY_MAX_RESULT_ROWS} rows`,
      path: ["max_result_rows"],
    });
  }
});

type DeepReadonly<T> = T extends readonly (infer Item)[]
  ? readonly DeepReadonly<Item>[]
  : T extends object
    ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
    : T;

export type Risk = z.infer<typeof RiskSchema>;
export type QueryRisk = z.infer<typeof QueryRiskSchema>;
export type OfflineMode = z.infer<typeof OfflineModeSchema>;
export type DataClassification = z.infer<typeof CommandDataClassificationSchema>;
export type ResultRedactionRule = RedactionRule;
export type InputRedactionRule = RedactionRule;
export type CommandMetadata = DeepReadonly<z.infer<typeof CommandMetadataSchema>>;
export type QueryMetadata = DeepReadonly<z.infer<typeof QueryMetadataSchema>>;

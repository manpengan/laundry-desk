import { z } from "zod";

import { JsonPointerSchema, SafePropertyKeySchema } from "./primitives.js";

/** ADR-09: all quantity and cent thresholds are positive safe integers. */
export const PositiveSafeIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

const NumericSumMeasureSchema = z
  .object({
    kind: z.literal("numeric_sum"),
    /** ADR-09: pointer to the array whose numeric fields are summed. */
    path: JsonPointerSchema,
    /** ADR-09: one own-property key on each array element. */
    field: SafePropertyKeySchema,
  })
  .strict();

/** ADR-09: the deterministic batch-size calculation. */
export const BatchMeasureSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("array_length"), path: JsonPointerSchema }).strict(),
  NumericSumMeasureSchema,
]);

/** ADR-09: the deterministic amount-in-cents calculation. */
export const AmountMeasureSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("field"), path: JsonPointerSchema }).strict(),
  NumericSumMeasureSchema,
]);

/** ADR-09 decision 2: at least one declared batch/amount measure. */
export const SizeMeasuresSchema = z
  .object({
    batch: BatchMeasureSchema.optional(),
    amount: AmountMeasureSchema.optional(),
  })
  .strict()
  .refine((measures) => measures.batch !== undefined || measures.amount !== undefined, {
    message: "A size measure group must declare batch or amount",
  });

/** ADR-09 decision 2: at least one positive batch/amount threshold. */
export const ThresholdsSchema = z
  .object({
    max_batch: PositiveSafeIntegerSchema.optional(),
    max_amount_cents: PositiveSafeIntegerSchema.optional(),
  })
  .strict()
  .superRefine((thresholds, context) => {
    (["max_batch", "max_amount_cents"] as const).forEach((dimension) => {
      if (Object.hasOwn(thresholds, dimension) && thresholds[dimension] === undefined) {
        context.addIssue({
          code: "custom",
          message: "Threshold values may not be explicitly undefined",
          path: [dimension],
        });
      }
    });
  })
  .refine(
    (thresholds) => thresholds.max_batch !== undefined || thresholds.max_amount_cents !== undefined,
    { message: "A threshold group must declare batch or amount" },
  );

const LimitConfigurationBaseSchema = z
  .object({
    size_measures: SizeMeasuresSchema.optional(),
    hard_limits: ThresholdsSchema.optional(),
    risk_escalation: ThresholdsSchema.optional(),
  })
  .strict();

type LimitConfiguration = z.infer<typeof LimitConfigurationBaseSchema>;

const escalationExceedsHardLimit = (
  configuration: Pick<LimitConfiguration, "hard_limits" | "risk_escalation">,
  dimension: "max_batch" | "max_amount_cents",
): boolean => {
  const hard = configuration.hard_limits?.[dimension];
  const escalation = configuration.risk_escalation?.[dimension];
  return hard !== undefined && escalation !== undefined && escalation > hard;
};

const addOrderingIssue = (
  configuration: Pick<LimitConfiguration, "hard_limits" | "risk_escalation">,
  dimension: "max_batch" | "max_amount_cents",
  context: z.core.$RefinementCtx<LimitConfiguration>,
): void => {
  if (escalationExceedsHardLimit(configuration, dimension)) {
    context.addIssue({
      code: "custom",
      message: "Risk escalation must not exceed the matching hard limit",
      path: ["risk_escalation", dimension],
    });
  }
};

const addMeasureIssue = (
  configuration: LimitConfiguration,
  dimension: "batch" | "amount",
  context: z.core.$RefinementCtx<LimitConfiguration>,
): void => {
  const thresholdKey = dimension === "batch" ? "max_batch" : "max_amount_cents";
  const hasThreshold =
    configuration.hard_limits?.[thresholdKey] !== undefined ||
    configuration.risk_escalation?.[thresholdKey] !== undefined;
  if (hasThreshold && configuration.size_measures?.[dimension] === undefined) {
    context.addIssue({
      code: "custom",
      message: `A ${dimension} threshold requires its size measure`,
      path: ["size_measures", dimension],
    });
  }
};

const validateLimitConfiguration = (
  configuration: LimitConfiguration,
  context: z.core.$RefinementCtx<LimitConfiguration>,
): void => {
  addMeasureIssue(configuration, "batch", context);
  addMeasureIssue(configuration, "amount", context);
  addOrderingIssue(configuration, "max_batch", context);
  addOrderingIssue(configuration, "max_amount_cents", context);
};

/** ADR-09 well-formedness for command measure, hard-limit, and escalation groups. */
export const LimitConfigurationSchema = z
  .object(LimitConfigurationBaseSchema.shape)
  .strict()
  .superRefine(validateLimitConfiguration);

const LimitGroupsSchema = z
  .object({
    hard_limits: ThresholdsSchema.optional(),
    risk_escalation: ThresholdsSchema.optional(),
  })
  .strict();

type DeepReadonly<T> = T extends readonly (infer Item)[]
  ? readonly DeepReadonly<Item>[]
  : T extends object
    ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
    : T;

export type LimitGroups = DeepReadonly<z.infer<typeof LimitGroupsSchema>>;

const LIMIT_GROUPS = ["hard_limits", "risk_escalation"] as const;
const LIMIT_DIMENSIONS = ["max_batch", "max_amount_cents"] as const;

const StricterOverrideSchema = (factory: z.infer<typeof LimitGroupsSchema>) =>
  LimitGroupsSchema.superRefine((override, context) => {
    LIMIT_GROUPS.forEach((group) => {
      LIMIT_DIMENSIONS.forEach((dimension) => {
        const overrideValue = override[group]?.[dimension];
        if (overrideValue === undefined) return;
        const factoryValue = factory[group]?.[dimension];
        if (factoryValue === undefined || overrideValue > factoryValue) {
          context.addIssue({
            code: "custom",
            message: "An organization override may only tighten an existing factory line",
            path: [group, dimension],
          });
        }
      });
    });
  });

const mergeThresholds = (
  factory: z.infer<typeof ThresholdsSchema> | undefined,
  override: z.infer<typeof ThresholdsSchema> | undefined,
): Readonly<z.infer<typeof ThresholdsSchema>> | undefined => {
  if (factory === undefined) return undefined;
  return Object.freeze({ ...factory, ...override });
};

const MergedLimitGroupsSchema = LimitGroupsSchema.superRefine((configuration, context) => {
  LIMIT_DIMENSIONS.forEach((dimension) => {
    if (escalationExceedsHardLimit(configuration, dimension)) {
      context.addIssue({
        code: "custom",
        message: "Risk escalation must not exceed the matching hard limit",
        path: ["risk_escalation", dimension],
      });
    }
  });
});

/** ADR-09 decision 3: validate and merge a per-org override that can only tighten factory lines. */
export const validateStricterLimitOverride = (
  factoryInput: LimitGroups,
  overrideInput: LimitGroups,
): LimitGroups => {
  const factory = LimitGroupsSchema.parse(factoryInput);
  const override = StricterOverrideSchema(factory).parse(overrideInput);
  const hardLimits = mergeThresholds(factory.hard_limits, override.hard_limits);
  const riskEscalation = mergeThresholds(factory.risk_escalation, override.risk_escalation);
  const merged = MergedLimitGroupsSchema.parse({
    ...(hardLimits === undefined ? {} : { hard_limits: hardLimits }),
    ...(riskEscalation === undefined ? {} : { risk_escalation: riskEscalation }),
  });

  return Object.freeze({
    ...(merged.hard_limits === undefined ? {} : { hard_limits: Object.freeze(merged.hard_limits) }),
    ...(merged.risk_escalation === undefined
      ? {}
      : { risk_escalation: Object.freeze(merged.risk_escalation) }),
  });
};

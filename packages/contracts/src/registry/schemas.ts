import { z } from "zod";

const STABLE_ID = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/u;
const COMMAND_NAME = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/u;
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;
const JSON_POINTER = /^(?:\/(?:[^~/]|~0|~1)*)+$/u;

const uniqueIds = (ids: readonly string[]): boolean => new Set(ids).size === ids.length;

export const RiskSchema = z.enum(["R0", "R1", "R2", "R3", "R4", "R5"]);
export const QueryRiskSchema = z.enum(["R0", "R1", "R2"]);
export const DataClassificationSchema = z.enum(["public", "internal", "pii"]);
export const ResultRedactionRuleSchema = z
  .object({
    path: z.string().regex(JSON_POINTER),
    strategy: z.enum(["remove", "mask", "last4"]),
  })
  .strict();

const idList = z.array(z.string().regex(STABLE_ID)).refine(uniqueIds, {
  message: "Identifiers must be unique",
});

const CommonMetadataShape = {
  name: z.string().regex(COMMAND_NAME),
  version: z.string().regex(SEMVER),
  description: z.string().trim().min(1),
  invariants: idList,
  data_classification: DataClassificationSchema,
  max_batch: z.number().int().positive(),
  result_redaction: z.array(ResultRedactionRuleSchema),
};

export const CommandMetadataSchema = z
  .object({
    ...CommonMetadataShape,
    kind: z.literal("command"),
    risk: RiskSchema,
    idempotent: z.boolean(),
    sideEffects: idList,
    offline_allowed: z.boolean(),
  })
  .strict();

export const QueryMetadataSchema = z
  .object({
    ...CommonMetadataShape,
    kind: z.literal("query"),
    risk: QueryRiskSchema,
    idempotent: z.literal(true),
    sideEffects: z.array(z.never()).length(0),
    offline_allowed: z.literal(false),
  })
  .strict();

export type Risk = z.infer<typeof RiskSchema>;
export type QueryRisk = z.infer<typeof QueryRiskSchema>;
export type DataClassification = z.infer<typeof DataClassificationSchema>;
export type ResultRedactionRule = Readonly<z.infer<typeof ResultRedactionRuleSchema>>;

type ReadonlyMetadata<
  T extends {
    invariants: string[];
    sideEffects: unknown[];
    result_redaction: z.infer<typeof ResultRedactionRuleSchema>[];
  },
> = Readonly<
  Omit<T, "invariants" | "sideEffects" | "result_redaction"> & {
    readonly invariants: readonly string[];
    readonly sideEffects: readonly T["sideEffects"][number][];
    readonly result_redaction: readonly ResultRedactionRule[];
  }
>;

export type CommandMetadata = ReadonlyMetadata<z.infer<typeof CommandMetadataSchema>>;
export type QueryMetadata = ReadonlyMetadata<z.infer<typeof QueryMetadataSchema>>;

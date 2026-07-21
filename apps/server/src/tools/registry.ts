/**
 * C4 AI Tool Registry — read-only projection of the command/query catalog.
 * R5 and secret-classified definitions are never projected (ADR-05 #2/#4).
 * No second tool implementation; descriptors are views over @laundry/contracts.
 */

import {
  M1_FIRST_WAVE_DEFINITIONS,
  isAiProjectableDefinition,
  type AiProjectableDefinition,
  type RedactionRule,
} from "@laundry/contracts";
import { z } from "zod";

/** JSON-compatible OpenAPI-ish schema object (no $schema / timestamps). */
export type JsonSchemaProjection = Readonly<Record<string, unknown>>;

export type ToolExample = Readonly<{
  args: Readonly<Record<string, unknown>>;
  description?: string;
}>;

export type LlmToolLimits = Readonly<{
  max_batch?: number;
  max_amount_cents?: number;
}>;

/**
 * LLM-facing tool descriptor projected from a single contract definition.
 * risk never includes R5; data_classification never includes secret.
 */
export type LlmToolDescriptor = Readonly<{
  name: string;
  version: string;
  kind: "command" | "query";
  description: string;
  risk: string;
  data_classification: string;
  offline_mode: string;
  input_json_schema: JsonSchemaProjection;
  input_redaction: readonly RedactionRule[];
  result_redaction: readonly RedactionRule[];
  hard_limits?: LlmToolLimits;
  risk_escalation?: LlmToolLimits;
  max_result_rows?: number;
  examples: readonly ToolExample[];
}>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Convert Zod input to a stable JSON Schema projection for tool calling. */
export function projectInputJsonSchema(input: z.ZodType): JsonSchemaProjection {
  const raw = z.toJSONSchema(input, { target: "openapi-3.1" });
  if (!isRecord(raw)) {
    throw new TypeError("z.toJSONSchema must return an object");
  }
  const copy: Record<string, unknown> = { ...raw };
  Reflect.deleteProperty(copy, "$schema");
  return Object.freeze(copy);
}

/** Drop example args fields listed under remove-strategy input_redaction. */
export function stripRedactedExampleArgs(
  args: Readonly<Record<string, unknown>>,
  inputRedaction: readonly RedactionRule[],
): Readonly<Record<string, unknown>> {
  const removeKeys = new Set<string>();
  for (const rule of inputRedaction) {
    if (rule.strategy !== "remove") continue;
    const segments = rule.path.startsWith("/") ? rule.path.slice(1).split("/") : [];
    if (segments.length === 1 && segments[0] !== undefined) {
      removeKeys.add(segments[0]);
    }
  }
  if (removeKeys.size === 0) return Object.freeze({ ...args });
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (!removeKeys.has(key)) next[key] = value;
  }
  return Object.freeze(next);
}

function projectExamples(definition: AiProjectableDefinition): readonly ToolExample[] {
  const examples = definition.examples ?? [];
  return Object.freeze(
    examples.map((example) => {
      const stripped = stripRedactedExampleArgs(example.args, definition.input_redaction);
      if (example.description === undefined) {
        return Object.freeze({ args: stripped });
      }
      return Object.freeze({ args: stripped, description: example.description });
    }),
  );
}

function projectLimits(value: unknown): LlmToolLimits | undefined {
  if (value === undefined || value === null || typeof value !== "object") return undefined;
  const record = value as Readonly<Record<string, unknown>>;
  const out: { max_batch?: number; max_amount_cents?: number } = {};
  if (typeof record.max_batch === "number") out.max_batch = record.max_batch;
  if (typeof record.max_amount_cents === "number") out.max_amount_cents = record.max_amount_cents;
  if (out.max_batch === undefined && out.max_amount_cents === undefined) return undefined;
  return Object.freeze(out);
}

/** Project one AI-projectable definition into an LLM tool descriptor. */
export function projectDefinitionToTool(definition: AiProjectableDefinition): LlmToolDescriptor {
  const base: {
    name: string;
    version: string;
    kind: "command" | "query";
    description: string;
    risk: string;
    data_classification: string;
    offline_mode: string;
    input_json_schema: JsonSchemaProjection;
    input_redaction: readonly RedactionRule[];
    result_redaction: readonly RedactionRule[];
    examples: readonly ToolExample[];
    hard_limits?: LlmToolLimits;
    risk_escalation?: LlmToolLimits;
    max_result_rows?: number;
  } = {
    name: definition.name,
    version: definition.version,
    kind: definition.kind,
    description: definition.description_llm,
    risk: definition.risk,
    data_classification: definition.data_classification,
    offline_mode: definition.offline_mode,
    input_json_schema: projectInputJsonSchema(definition.input),
    input_redaction: definition.input_redaction,
    result_redaction: definition.result_redaction,
    examples: projectExamples(definition),
  };

  if (definition.kind === "command") {
    const hard = projectLimits(definition.hard_limits);
    const escalation = projectLimits(definition.risk_escalation);
    if (hard !== undefined) base.hard_limits = hard;
    if (escalation !== undefined) base.risk_escalation = escalation;
  } else {
    base.max_result_rows = definition.max_result_rows;
  }

  return Object.freeze(base);
}

/**
 * Project the M1 first-wave catalog (plus optional extra safe definitions)
 * into LLM tool descriptors. Mechanically excludes R5 and secret.
 */
export function projectCatalogToTools(
  definitions: readonly (typeof M1_FIRST_WAVE_DEFINITIONS)[number][] = M1_FIRST_WAVE_DEFINITIONS,
): readonly LlmToolDescriptor[] {
  const tools: LlmToolDescriptor[] = [];
  for (const definition of definitions) {
    if (!isAiProjectableDefinition(definition)) continue;
    tools.push(projectDefinitionToTool(definition));
  }
  return Object.freeze(tools.sort((a, b) => a.name.localeCompare(b.name)));
}

import { z } from "zod";

import { copyJsonMetadata } from "./schema-graph.js";

const STABLE_ID = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/u;
const COMMAND_NAME = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/u;
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;
const POINTER_TOKEN = /^(?:[^~]|~0|~1)+$/u;
const SAFE_PROPERTY_KEY = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/u;
const DANGEROUS_PROPERTIES = new Set(["__proto__", "prototype", "constructor"]);

const decodePointerToken = (token: string): string =>
  token.replaceAll("~1", "/").replaceAll("~0", "~");

const pointerSegments = (path: string): readonly string[] | undefined => {
  if (!path.startsWith("/")) return undefined;
  const tokens = path.slice(1).split("/");
  if (tokens.some((token) => !POINTER_TOKEN.test(token))) return undefined;
  return tokens.map(decodePointerToken);
};

const isSafePointer = (path: string): boolean => {
  const segments = pointerSegments(path);
  return segments !== undefined && segments.every((segment) => !DANGEROUS_PROPERTIES.has(segment));
};

const isPathPrefix = (left: readonly string[], right: readonly string[]): boolean =>
  left.length <= right.length && left.every((segment, index) => segment === right[index]);

const findPathConflict = (paths: readonly string[], index: number): number | undefined => {
  const current = pointerSegments(paths[index] ?? "");
  if (current === undefined) return undefined;

  for (let otherIndex = 0; otherIndex < index; otherIndex += 1) {
    const other = pointerSegments(paths[otherIndex] ?? "");
    if (other !== undefined && (isPathPrefix(current, other) || isPathPrefix(other, current))) {
      return otherIndex;
    }
  }
  return undefined;
};

/** Architecture §6.5: a stable executable binding identifier. */
export const StableBindingIdSchema = z.string().regex(STABLE_ID);

/** Architecture §6.5: command/query names contain at least two dotted segments. */
export const CommandNameSchema = z.string().regex(COMMAND_NAME);

/** ADR-08: each command/query definition carries a complete SemVer. */
export const SemVerSchema = z.string().regex(SEMVER);

/** C4: an example argument object is inert, acyclic JSON metadata, never executable input. */
export const ExampleArgsSchema = z.custom<Readonly<Record<string, unknown>>>(
  (value) => {
    try {
      copyJsonMetadata(value);
      return true;
    } catch {
      return false;
    }
  },
  { message: "Example args must be a JSON-compatible object" },
);

/** Architecture §6.5 / ADR-05 #2: one authoritative LLM projection example. */
export const ContractExampleSchema = z
  .object({
    args: ExampleArgsSchema,
    description: z.string().trim().min(1).optional(),
  })
  .strict();

export const ContractExamplesSchema = z.array(ContractExampleSchema);

/** ADR-05 #2/#12: a non-root, prototype-safe RFC 6901 JSON Pointer. */
export const JsonPointerSchema = z.string().refine(isSafePointer, {
  message: "Expected a non-root, prototype-safe RFC 6901 JSON Pointer",
});

/** ADR-09: numeric_sum.field is one safe lower snake_case own-property key. */
export const SafePropertyKeySchema = z
  .string()
  .regex(SAFE_PROPERTY_KEY)
  .refine((field) => !DANGEROUS_PROPERTIES.has(field), {
    message: "Prototype-related property names are forbidden",
  });

/** ADR-05 #2/#12: one declarative input or result redaction rule. */
export const RedactionRuleSchema = z
  .object({
    /** RFC 6901 path resolved through own properties only by downstream walkers. */
    path: JsonPointerSchema,
    /** The only transformations frozen for C3/C4 redaction. */
    strategy: z.enum(["remove", "mask", "last4"]),
  })
  .strict();

/** ADR-05 #2/#12: redaction paths may neither duplicate nor overlap by ancestry. */
export const RedactionRulesSchema = z.array(RedactionRuleSchema).superRefine((rules, context) => {
  const paths = rules.map((rule) => rule.path);
  paths.forEach((path, index) => {
    const conflict = findPathConflict(paths, index);
    if (conflict !== undefined) {
      context.addIssue({
        code: "custom",
        message: `Redaction path overlaps rule ${conflict}`,
        path: [index, "path"],
      });
    }
  });
});

/** Architecture §6.5: binding lists are ordered and duplicate-free. */
export const StableBindingIdsSchema = z
  .array(StableBindingIdSchema)
  .refine((ids) => new Set(ids).size === ids.length, {
    message: "Binding identifiers must be unique",
  });

export type RedactionRule = Readonly<z.infer<typeof RedactionRuleSchema>>;
export type ContractExample = Readonly<z.infer<typeof ContractExampleSchema>>;

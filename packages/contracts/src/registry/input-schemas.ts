import { z } from "zod";

export { captureInputIntegrity } from "./integrity-snapshot.js";
export { createProtectedInputView } from "./input-membrane.js";
export { cloneContractInput } from "./schema-clone.js";
export {
  copyJsonMetadata,
  isSafeContractInput,
  schemaMetadataOf,
  validateSchemaMetadata,
} from "./schema-graph.js";

type PathResolution =
  | Readonly<{ status: "missing" | "unresolved" }>
  | Readonly<{ status: "resolved"; schema: z.ZodType }>;

const unwrapPathSchema = (schema: z.ZodType): z.ZodType | undefined => {
  let current = schema;
  const seen = new Set<z.ZodType>();
  while (!seen.has(current)) {
    seen.add(current);
    const inner = (current.def as { innerType?: unknown }).innerType;
    if (inner instanceof z.ZodType) {
      current = inner;
      continue;
    }
    return current.def.type === "pipe" || current.def.type === "transform" ? undefined : current;
  }
  return undefined;
};

const decodePointer = (path: string): readonly string[] =>
  path
    .slice(1)
    .split("/")
    .map((token) => token.replaceAll("~1", "/").replaceAll("~0", "~"));

/** Resolves only statically knowable strict-object/array paths; callers fail closed on unresolved paths. */
export const resolveInputPath = (root: z.ZodObject, path: string): PathResolution => {
  let current: z.ZodType = root;
  for (const segment of decodePointer(path)) {
    const unwrapped = unwrapPathSchema(current);
    if (unwrapped === undefined) return { status: "unresolved" };
    if (unwrapped instanceof z.ZodObject) {
      const child = unwrapped.shape[segment];
      if (!(child instanceof z.ZodType)) return { status: "missing" };
      current = child;
      continue;
    }
    if (unwrapped instanceof z.ZodArray) {
      if (!/^(?:0|[1-9]\d*)$/u.test(segment)) return { status: "missing" };
      const element: unknown = unwrapped.element;
      if (!(element instanceof z.ZodType)) return { status: "unresolved" };
      current = element;
      continue;
    }
    return { status: "missing" };
  }
  const resolved = unwrapPathSchema(current);
  return resolved === undefined
    ? { status: "unresolved" }
    : { status: "resolved", schema: resolved };
};

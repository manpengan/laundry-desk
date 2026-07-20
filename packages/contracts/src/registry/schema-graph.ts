import { z } from "zod";

export type IntegrityCheck = () => boolean;

export type ZodCoreRecord = Record<PropertyKey, unknown> &
  Readonly<{
    constr: new (definition: object) => object;
    def: Record<PropertyKey, unknown>;
    traits: Set<string>;
  }>;

type SchemaGraphRole = "input" | "check" | "output";

const isRecord = (value: unknown): value is Record<PropertyKey, unknown> =>
  typeof value === "object" && value !== null;

const dataValue = (target: object, property: PropertyKey): unknown => {
  const descriptor = Object.getOwnPropertyDescriptor(target, property);
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
};

export const zodCoreOf = (value: object): ZodCoreRecord | undefined => {
  const core = dataValue(value, "_zod");
  if (!isRecord(core)) return undefined;
  const definition = dataValue(core, "def");
  const traits = dataValue(core, "traits");
  const constructor = dataValue(core, "constr");
  if (!isRecord(definition) || !(traits instanceof Set) || typeof constructor !== "function") {
    return undefined;
  }
  return core as ZodCoreRecord;
};

const definitionRole = (
  definition: Readonly<Record<PropertyKey, unknown>>,
  property: PropertyKey,
  role: SchemaGraphRole,
): SchemaGraphRole => {
  const type = dataValue(definition, "type");
  if (typeof type === "string" && property === "checks") return "check";
  if (type === "pipe" && property === "out") return "output";
  return role;
};

type SchemaVisitor = (schema: z.ZodType, core: ZodCoreRecord, role: SchemaGraphRole) => void;
type CoreVisitor = (value: object, core: ZodCoreRecord, role: SchemaGraphRole) => void;

const visitGraphValue = (
  value: unknown,
  role: SchemaGraphRole,
  seen: Readonly<Record<SchemaGraphRole, WeakSet<object>>>,
  visitSchema: SchemaVisitor,
  visitCore: CoreVisitor,
): void => {
  if (typeof value !== "object" || value === null || seen[role].has(value)) return;
  seen[role].add(value);

  const core = zodCoreOf(value);
  if (core !== undefined) {
    visitCore(value, core, role);
    if (value instanceof z.ZodType) {
      visitSchema(value, core, role);
      if (value instanceof z.ZodObject) {
        visitGraphValue(value.shape, role, seen, visitSchema, visitCore);
      }
    }
    visitGraphValue(core.def, role, seen, visitSchema, visitCore);
    return;
  }

  if (Array.isArray(value)) {
    for (const entry of value) visitGraphValue(entry, role, seen, visitSchema, visitCore);
    return;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return;
  for (const property of Reflect.ownKeys(value)) {
    const entry = dataValue(value, property);
    if (entry !== undefined) {
      visitGraphValue(
        entry,
        definitionRole(value as Record<PropertyKey, unknown>, property, role),
        seen,
        visitSchema,
        visitCore,
      );
    }
  }
};

export const visitZodGraph = (
  root: z.ZodType,
  visitSchema: SchemaVisitor,
  visitCore: CoreVisitor = () => undefined,
): void =>
  visitGraphValue(
    root,
    "input",
    { input: new WeakSet(), check: new WeakSet(), output: new WeakSet() },
    visitSchema,
    visitCore,
  );

const coreType = (core: ZodCoreRecord): unknown => dataValue(core.def, "type");

const isStrictClassicObject = (schema: z.ZodType, core: ZodCoreRecord): boolean => {
  if (coreType(core) !== "object") return true;
  if (!(schema instanceof z.ZodObject)) return false;
  const catchall = dataValue(core.def, "catchall");
  return (
    typeof catchall === "object" && catchall !== null && zodCoreOf(catchall)?.def.type === "never"
  );
};

const containsStatefulRegExp = (value: unknown, seen: WeakSet<object>): boolean => {
  if (typeof value !== "object" || value === null || seen.has(value)) return false;
  seen.add(value);
  if (value instanceof RegExp) return value.global || value.sticky;
  const core = zodCoreOf(value);
  if (core !== undefined) return containsStatefulRegExp(core.def, seen);
  if (value instanceof Map) {
    return [...value].some(
      ([key, entry]) => containsStatefulRegExp(key, seen) || containsStatefulRegExp(entry, seen),
    );
  }
  if (value instanceof Set) {
    return [...value].some((entry) => containsStatefulRegExp(entry, seen));
  }
  if (Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype) {
    return Reflect.ownKeys(value).some((property) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, property);
      return descriptor !== undefined && "value" in descriptor
        ? containsStatefulRegExp(descriptor.value, seen)
        : false;
    });
  }
  return false;
};

/** Rejects mini/core schemas, permissive leaves, catch fallbacks, and non-strict objects. */
export const isSafeContractInput = (value: unknown): value is z.ZodObject => {
  if (!(value instanceof z.ZodObject)) return false;
  const rootCore = zodCoreOf(value);
  if (rootCore === undefined || !isStrictClassicObject(value, rootCore)) return false;

  let safe = !containsStatefulRegExp(rootCore.def, new WeakSet());
  visitZodGraph(
    value,
    (schema, core, role) => {
      const type = coreType(core);
      if (
        type === "any" ||
        type === "unknown" ||
        type === "lazy" ||
        type === "catch" ||
        type === "default" ||
        type === "prefault" ||
        (type === "custom" && role !== "check") ||
        (type === "transform" && role !== "output") ||
        !isStrictClassicObject(schema, core)
      ) {
        safe = false;
      }
    },
    (node, core) => {
      if (containsStatefulRegExp(core.def, new WeakSet())) safe = false;
      if (core.traits.has("$ZodType") && !(node instanceof z.ZodType)) safe = false;
    },
  );
  return safe;
};

type JsonValue = null | boolean | number | string | JsonArray | JsonRecord;
interface JsonArray extends ReadonlyArray<JsonValue> {}
interface JsonRecord {
  readonly [key: string]: JsonValue;
}

const isJsonPrimitive = (value: unknown): value is null | boolean | number | string =>
  value === null ||
  typeof value === "boolean" ||
  typeof value === "string" ||
  (typeof value === "number" && Number.isFinite(value));

const copyJsonValue = (value: unknown, ancestors: WeakSet<object>): JsonValue => {
  if (isJsonPrimitive(value)) return value;
  if (typeof value !== "object" || value === null || ancestors.has(value)) {
    throw new TypeError("Schema metadata must be an acyclic JSON-compatible value");
  }
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("Schema metadata must contain only plain objects and arrays");
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const keys = Reflect.ownKeys(value).filter((key) => key !== "length");
      if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) {
        throw new TypeError("Schema metadata arrays must be dense JSON arrays");
      }
      return Object.freeze(
        keys.map((key) => {
          const descriptor = Object.getOwnPropertyDescriptor(value, key);
          if (descriptor === undefined || !("value" in descriptor)) {
            throw new TypeError("Schema metadata may not contain accessors");
          }
          return copyJsonValue(descriptor.value, ancestors);
        }),
      );
    }

    const entries = Reflect.ownKeys(value).map((key): readonly [string, JsonValue] => {
      if (typeof key !== "string") {
        throw new TypeError("Schema metadata may not contain symbol keys");
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor)) {
        throw new TypeError("Schema metadata may not contain accessors");
      }
      return [key, copyJsonValue(descriptor.value, ancestors)];
    });
    return Object.freeze(Object.fromEntries(entries)) as JsonRecord;
  } finally {
    ancestors.delete(value);
  }
};

export const copyJsonMetadata = (metadata: unknown): JsonRecord => {
  const copy = copyJsonValue(metadata, new WeakSet());
  if (typeof copy !== "object" || copy === null || Array.isArray(copy)) {
    throw new TypeError("Schema metadata root must be a plain object");
  }
  // The preceding JSON copier can only produce an array or JsonRecord object.
  return copy as JsonRecord;
};

type RegistryWithMap = Readonly<{ _map: WeakMap<object, unknown> }>;

/** Reads the exact registered metadata object without invoking metadata accessors. */
export const schemaMetadataOf = (schema: z.ZodType): unknown =>
  (z.globalRegistry as unknown as RegistryWithMap)._map.get(schema);

export const validateSchemaMetadata = (root: z.ZodType): void => {
  visitZodGraph(root, (schema) => {
    const metadata = schemaMetadataOf(schema);
    if (metadata !== undefined) copyJsonMetadata(metadata);
  });
};

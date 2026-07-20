import { z } from "zod";

import { type IntegrityCheck, schemaMetadataOf, visitZodGraph, zodCoreOf } from "./schema-graph.js";

type DescriptorSnapshot = Readonly<{
  property: PropertyKey;
  descriptor: PropertyDescriptor;
  accessorValue?: unknown;
}>;

type ObjectSnapshot = Readonly<{
  target: object;
  prototype: object | null;
  descriptors: readonly DescriptorSnapshot[];
}>;

type SetSnapshot = Readonly<{ target: Set<unknown>; values: readonly unknown[] }>;
type MapSnapshot = Readonly<{
  target: Map<unknown, unknown>;
  entries: readonly (readonly [unknown, unknown])[];
}>;
type DateSnapshot = Readonly<{ target: Date; time: number }>;

type MetadataSnapshot = Readonly<{ schema: z.ZodType; metadata: unknown }>;
type PrototypeSnapshot = Readonly<{
  target: object;
  prototype: object | null;
  descriptors: ReadonlyMap<PropertyKey, PropertyDescriptor>;
}>;

const DATE_GET_TIME = Date.prototype.getTime;

const descriptorMatches = (
  current: PropertyDescriptor | undefined,
  expected: PropertyDescriptor,
): boolean => {
  if (current === undefined) return false;
  if (
    current.configurable !== expected.configurable ||
    current.enumerable !== expected.enumerable ||
    "value" in current !== "value" in expected
  ) {
    return false;
  }
  if ("value" in expected && "value" in current) {
    return current.writable === expected.writable && Object.is(current.value, expected.value);
  }
  return (
    !("value" in current) &&
    Object.is(current.get, expected.get) &&
    Object.is(current.set, expected.set)
  );
};

const sameKeys = (left: readonly PropertyKey[], right: readonly PropertyKey[]): boolean =>
  left.length === right.length && left.every((key, index) => key === right[index]);

const isTraversableRecord = (value: object): boolean => {
  const prototype = Object.getPrototypeOf(value);
  return Array.isArray(value) || prototype === Object.prototype || prototype === null;
};

const schemaAccessorKeys = (schema: z.ZodType): ReadonlySet<PropertyKey> => {
  const keys = new Set<PropertyKey>(["~standard", "description"]);
  if (schema instanceof z.ZodObject) keys.add("shape");
  if (schema.def.type === "literal") keys.add("value");
  return keys;
};

class IntegritySnapshotBuilder {
  readonly #seen = new WeakSet<object>();
  readonly #allowedAccessors = new WeakMap<object, ReadonlySet<PropertyKey>>();
  readonly #objects: ObjectSnapshot[] = [];
  readonly #sets: SetSnapshot[] = [];
  readonly #maps: MapSnapshot[] = [];
  readonly #dates: DateSnapshot[] = [];
  readonly #metadata: MetadataSnapshot[] = [];
  readonly #prototypeSeen = new WeakSet<object>();
  readonly #prototypes: PrototypeSnapshot[] = [];

  capture(root: z.ZodObject): IntegrityCheck {
    visitZodGraph(
      root,
      (schema) => {
        this.#capturePrototypeChain(schema);
        this.#allowedAccessors.set(schema, schemaAccessorKeys(schema));
        const metadata = schemaMetadataOf(schema);
        this.#metadata.push({ schema, metadata });
        if (typeof metadata === "object" && metadata !== null) this.#collect(metadata);
      },
      (node, core) => {
        if (node instanceof z.ZodType) {
          this.#allowedAccessors.set(node, schemaAccessorKeys(node));
        }
        // Zod v4 implements these derived core values with fixed lazy accessors.
        this.#allowedAccessors.set(
          core,
          new Set(["values", "optin", "optout", "propValues", "pattern"]),
        );
        this.#allowedAccessors.set(
          core.def,
          core.def.type === "object" ? new Set(["shape"]) : new Set(),
        );
      },
    );
    this.#collect(root);

    return () => this.#verify();
  }

  #collect(value: unknown): void {
    if (typeof value !== "object" || value === null || this.#seen.has(value)) return;
    this.#seen.add(value);

    const core = zodCoreOf(value);
    if (core !== undefined) {
      if (value instanceof z.ZodType && !this.#allowedAccessors.has(value)) {
        this.#allowedAccessors.set(value, schemaAccessorKeys(value));
      }
      this.#allowedAccessors.set(
        core,
        new Set(["values", "optin", "optout", "propValues", "pattern"]),
      );
      this.#allowedAccessors.set(
        core.def,
        core.def.type === "object" ? new Set(["shape"]) : new Set(),
      );
    }

    if (value instanceof Set) {
      const values = [...value.values()];
      this.#sets.push({ target: value, values });
      this.#captureObject(value);
      values.forEach((entry) => this.#collect(entry));
      return;
    }
    if (value instanceof Map) {
      const entries = [...value.entries()];
      this.#maps.push({ target: value, entries });
      this.#captureObject(value);
      entries.forEach(([key, entry]) => {
        this.#collect(key);
        this.#collect(entry);
      });
      return;
    }
    if (value instanceof Date) {
      this.#dates.push({ target: value, time: DATE_GET_TIME.call(value) });
      this.#capturePrototypeChain(value);
      this.#captureObject(value);
      return;
    }
    if (value instanceof RegExp) {
      this.#capturePrototypeChain(value);
      this.#captureObject(value);
      return;
    }
    if (zodCoreOf(value) === undefined && !isTraversableRecord(value)) return;
    this.#captureObject(value);
  }

  #captureObject(target: object): void {
    const descriptors = Reflect.ownKeys(target).map((property): DescriptorSnapshot => {
      const descriptor = Object.getOwnPropertyDescriptor(target, property);
      if (descriptor === undefined) throw new TypeError("Unable to snapshot schema descriptor");
      if ("value" in descriptor) {
        this.#collect(descriptor.value);
        return { property, descriptor };
      }
      if (!(this.#allowedAccessors.get(target)?.has(property) ?? false)) {
        throw new TypeError(
          `Contract input schema contains an unsafe accessor: ${String(property)}`,
        );
      }
      const accessorValue = Reflect.get(target, property, target) as unknown;
      this.#collect(accessorValue);
      return { property, descriptor, accessorValue };
    });
    this.#objects.push({ target, prototype: Object.getPrototypeOf(target), descriptors });
  }

  #capturePrototypeChain(target: object): void {
    let prototype = Object.getPrototypeOf(target) as object | null;
    while (prototype !== null && prototype !== Object.prototype) {
      if (!this.#prototypeSeen.has(prototype)) {
        this.#prototypeSeen.add(prototype);
        this.#prototypes.push({
          target: prototype,
          prototype: Object.getPrototypeOf(prototype) as object | null,
          descriptors: new Map(
            Reflect.ownKeys(prototype).map((property) => {
              const descriptor = Object.getOwnPropertyDescriptor(prototype, property);
              if (descriptor === undefined) {
                throw new TypeError("Unable to snapshot schema prototype");
              }
              return [property, descriptor] as const;
            }),
          ),
        });
      }
      prototype = Object.getPrototypeOf(prototype) as object | null;
    }
  }

  #verify(): boolean {
    return (
      this.#metadata.every(({ schema, metadata }) =>
        Object.is(schemaMetadataOf(schema), metadata),
      ) &&
      this.#prototypes.every(({ target, prototype, descriptors }) => {
        if (Object.getPrototypeOf(target) !== prototype) return false;
        if (!sameKeys(Reflect.ownKeys(target), [...descriptors.keys()])) return false;
        return [...descriptors].every(([property, descriptor]) =>
          descriptorMatches(Object.getOwnPropertyDescriptor(target, property), descriptor),
        );
      }) &&
      this.#objects.every(({ target, prototype, descriptors }) => {
        if (Object.getPrototypeOf(target) !== prototype) return false;
        if (
          !sameKeys(
            Reflect.ownKeys(target),
            descriptors.map(({ property }) => property),
          )
        ) {
          return false;
        }
        return descriptors.every(({ property, descriptor, accessorValue }) => {
          const current = Object.getOwnPropertyDescriptor(target, property);
          if (!descriptorMatches(current, descriptor)) return false;
          if ("value" in descriptor) return true;
          return Object.is(Reflect.get(target, property, target), accessorValue);
        });
      }) &&
      this.#sets.every(({ target, values }) => {
        const current = [...target.values()];
        return (
          current.length === values.length &&
          current.every((value, index) => value === values[index])
        );
      }) &&
      this.#maps.every(({ target, entries }) => {
        const current = [...target.entries()];
        return (
          current.length === entries.length &&
          current.every(
            ([key, value], index) => key === entries[index]?.[0] && value === entries[index]?.[1],
          )
        );
      }) &&
      this.#dates.every(({ target, time }) => Object.is(DATE_GET_TIME.call(target), time))
    );
  }
}

/** Captures canonical schema state without freezing or mutating it. */
export const captureInputIntegrity = (schema: z.ZodObject): IntegrityCheck =>
  new IntegritySnapshotBuilder().capture(schema);

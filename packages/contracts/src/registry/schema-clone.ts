import { z } from "zod";

import {
  copyJsonMetadata,
  schemaMetadataOf,
  type ZodCoreRecord,
  zodCoreOf,
} from "./schema-graph.js";

const REGEXP_EXEC = RegExp.prototype.exec;
const REGEXP_TEST = RegExp.prototype.test;
const DATE_GET_TIME = Date.prototype.getTime;

const isPlainRecord = (value: object): boolean => {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const dataValue = (target: object, property: PropertyKey): unknown => {
  const descriptor = Object.getOwnPropertyDescriptor(target, property);
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
};

class SchemaGraphCloner {
  readonly #copies = new WeakMap<object, object>();
  readonly #activeCoreNodes = new WeakSet<object>();

  clone<TSchema extends z.ZodObject>(schema: TSchema): TSchema {
    const clone = this.#cloneValue(schema);
    if (!(clone instanceof z.ZodObject)) {
      throw new TypeError("Contract input schema clone did not preserve its object root");
    }
    return clone as TSchema;
  }

  #cloneValue(value: unknown): unknown {
    if ((typeof value !== "object" && typeof value !== "function") || value === null) return value;
    if (typeof value === "function") return value;
    const cached = this.#copies.get(value);
    if (cached !== undefined) return cached;

    const core = zodCoreOf(value);
    if (core !== undefined) return this.#cloneCoreNode(value, core);
    if (value instanceof RegExp) return this.#cloneRegExp(value);
    if (value instanceof Date) return this.#cloneDate(value);
    if (value instanceof Map) return this.#cloneMap(value);
    if (value instanceof Set) return this.#cloneSet(value);
    if (Array.isArray(value) || isPlainRecord(value)) return this.#cloneContainer(value);

    throw new TypeError("Contract input schema contains an unsupported mutable definition value");
  }

  #cloneCoreNode(source: object, core: ZodCoreRecord): object {
    if (this.#activeCoreNodes.has(source)) {
      throw new TypeError("Contract input schema graph may not contain cycles");
    }
    this.#activeCoreNodes.add(source);
    try {
      const definition = this.#cloneValue(core.def);
      if (typeof definition !== "object" || definition === null) {
        throw new TypeError("Contract input schema has an invalid definition");
      }
      const clone = Reflect.construct(core.constr, [definition]) as object;
      this.#copies.set(source, clone);

      const cloneCore = zodCoreOf(clone);
      if (cloneCore === undefined) {
        throw new TypeError("Contract input schema clone has an invalid core");
      }
      const sourceCheck = dataValue(core, "check");
      if (dataValue(cloneCore, "check") === undefined && typeof sourceCheck === "function") {
        Object.defineProperty(cloneCore, "check", {
          configurable: true,
          enumerable: true,
          value: sourceCheck,
          writable: true,
        });
      }
      const sourceAttach = dataValue(core, "onattach");
      const cloneAttach = dataValue(cloneCore, "onattach");
      if (
        Array.isArray(sourceAttach) &&
        Array.isArray(cloneAttach) &&
        cloneAttach.length === 0 &&
        sourceAttach.length > 0
      ) {
        cloneAttach.push(...sourceAttach);
      }

      if (source instanceof z.ZodType && clone instanceof z.ZodType) {
        const metadata = schemaMetadataOf(source);
        if (metadata !== undefined) z.globalRegistry.add(clone, copyJsonMetadata(metadata));
      }
      return clone;
    } finally {
      this.#activeCoreNodes.delete(source);
    }
  }

  #cloneContainer(source: object): object {
    const clone: object = Array.isArray(source)
      ? []
      : Object.create(Object.getPrototypeOf(source) === null ? null : Object.prototype);
    this.#copies.set(source, clone);

    for (const property of Reflect.ownKeys(source)) {
      if (Array.isArray(source) && property === "length") continue;
      const descriptor = Object.getOwnPropertyDescriptor(source, property);
      if (descriptor === undefined) throw new TypeError("Unable to clone schema definition");

      let propertyValue: unknown;
      if ("value" in descriptor) {
        propertyValue = descriptor.value;
      } else if (property === "shape" && dataValue(source, "type") === "object") {
        propertyValue = Reflect.get(source, property, clone) as unknown;
      } else {
        throw new TypeError("Contract input schema contains an unsafe accessor");
      }

      Object.defineProperty(clone, property, {
        configurable: true,
        enumerable: descriptor.enumerable ?? false,
        value: this.#cloneValue(propertyValue),
        writable: true,
      });
    }
    return clone;
  }

  #cloneRegExp(source: RegExp): RegExp {
    const clone = new RegExp(source.source, source.flags);
    clone.lastIndex = source.lastIndex;
    Object.defineProperties(clone, {
      exec: {
        configurable: false,
        value: REGEXP_EXEC.bind(clone),
        writable: false,
      },
      test: {
        configurable: false,
        value: (input: string) => REGEXP_TEST.call(clone, input),
        writable: false,
      },
    });
    this.#copies.set(source, clone);
    return clone;
  }

  #cloneDate(source: Date): Date {
    const time = DATE_GET_TIME.call(source);
    if (!Number.isFinite(time)) {
      throw new TypeError("Contract input schema contains an invalid Date constraint");
    }
    const clone = new Date(time);
    this.#copies.set(source, clone);
    return clone;
  }

  #cloneMap(source: Map<unknown, unknown>): Map<unknown, unknown> {
    const clone = new Map<unknown, unknown>();
    this.#copies.set(source, clone);
    source.forEach((value, key) => clone.set(this.#cloneValue(key), this.#cloneValue(value)));
    return clone;
  }

  #cloneSet(source: Set<unknown>): Set<unknown> {
    const clone = new Set<unknown>();
    this.#copies.set(source, clone);
    source.forEach((value) => clone.add(this.#cloneValue(value)));
    return clone;
  }
}

/** Creates a caller-independent canonical Zod graph for C1 parsing. */
export const cloneContractInput = <TInput extends z.ZodObject>(input: TInput): TInput =>
  new SchemaGraphCloner().clone(input);

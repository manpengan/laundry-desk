import { z } from "zod";

import { type IntegrityCheck, zodCoreOf } from "./schema-graph.js";

const BLOCKED_SCHEMA_METHODS = new Set([
  "apply",
  "decode",
  "decodeAsync",
  "encode",
  "encodeAsync",
  "parse",
  "parseAsync",
  "register",
  "safeDecode",
  "safeDecodeAsync",
  "safeEncode",
  "safeEncodeAsync",
  "safeParse",
  "safeParseAsync",
]);
const BLOCKED_CORE_METHODS = new Set(["parse", "run"]);
const MUTATING_ARRAY_METHODS = new Set([
  "copyWithin",
  "fill",
  "pop",
  "push",
  "reverse",
  "shift",
  "sort",
  "splice",
  "unshift",
]);
const MUTATING_MAP_METHODS = new Set(["clear", "delete", "set"]);
const MUTATING_SET_METHODS = new Set(["add", "clear", "delete"]);
const MUTATING_REGEXP_METHODS = new Set(["compile", "exec", "test"]);

const integrityError = (): Error => new Error("Contract input schema integrity check failed");
const mutationError = (): TypeError => new TypeError("Contract input schema is read-only");

type ProtectionContext = Readonly<{
  proxies: WeakMap<object, object>;
  rawByProxy: WeakMap<object, object>;
  functions: WeakMap<object, Map<PropertyKey, Callable>>;
  verify: IntegrityCheck;
}>;

type Callable = (...args: readonly unknown[]) => unknown;

const assertIntegrity = (context: ProtectionContext): void => {
  if (!context.verify()) throw integrityError();
};

const isPromiseLike = (value: unknown): value is PromiseLike<unknown> =>
  (typeof value === "object" || typeof value === "function") &&
  value !== null &&
  typeof (value as { then?: unknown }).then === "function";

const unwrapArgument = (value: unknown, context: ProtectionContext): unknown =>
  typeof value === "object" && value !== null ? (context.rawByProxy.get(value) ?? value) : value;

const isCoreRecord = (value: object): boolean => {
  const definition = Object.getOwnPropertyDescriptor(value, "def");
  const traits = Object.getOwnPropertyDescriptor(value, "traits");
  return (
    definition !== undefined &&
    "value" in definition &&
    typeof definition.value === "object" &&
    definition.value !== null &&
    traits !== undefined &&
    "value" in traits &&
    traits.value instanceof Set
  );
};

const isStandardRecord = (value: object): boolean =>
  Reflect.get(value, "vendor", value) === "zod" && Reflect.get(value, "version", value) === 1;

const isBlockedMethod = (receiver: object, property: PropertyKey): boolean => {
  if (typeof property !== "string") return false;
  if (property === "validate" && isStandardRecord(receiver)) return true;
  if (isCoreRecord(receiver)) return BLOCKED_CORE_METHODS.has(property);
  if (receiver instanceof Map) return MUTATING_MAP_METHODS.has(property);
  if (receiver instanceof Set) return MUTATING_SET_METHODS.has(property);
  if (receiver instanceof RegExp) return MUTATING_REGEXP_METHODS.has(property);
  if (receiver instanceof Date) return property.startsWith("set");
  if (Array.isArray(receiver)) return MUTATING_ARRAY_METHODS.has(property);
  if (receiver instanceof z.ZodType) return BLOCKED_SCHEMA_METHODS.has(property);
  return false;
};

const protectResult = (
  result: unknown,
  _property: PropertyKey,
  context: ProtectionContext,
): unknown => {
  if (typeof result !== "object" || result === null) return result;
  return protectObject(result, context);
};

const blockedFunction =
  (context: ProtectionContext): Callable =>
  () => {
    assertIntegrity(context);
    throw mutationError();
  };

const schemaMetadataFunction =
  (schema: z.ZodType, context: ProtectionContext): Callable =>
  (...args: readonly unknown[]): unknown => {
    assertIntegrity(context);
    if (args.length > 0) throw mutationError();
    const metadata = z.globalRegistry.get(schema);
    assertIntegrity(context);
    return metadata === undefined ? undefined : protectObject(metadata, context);
  };

const findPropertyDescriptor = (
  target: object,
  property: PropertyKey,
): PropertyDescriptor | undefined => {
  let current: object | null = target;
  while (current !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(current, property);
    if (descriptor !== undefined) return descriptor;
    current = Object.getPrototypeOf(current);
  }
  return undefined;
};

const cloneDefinitionValue = (value: unknown, seen: WeakMap<object, object>): unknown => {
  if (typeof value !== "object" || value === null || zodCoreOf(value) !== undefined) return value;
  const cached = seen.get(value);
  if (cached !== undefined) return cached;
  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    seen.set(value, copy);
    value.forEach((entry) => copy.push(cloneDefinitionValue(entry, seen)));
    return copy;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  const copy: Record<PropertyKey, unknown> = {};
  seen.set(value, copy);
  Reflect.ownKeys(value).forEach((property) => {
    copy[property] = cloneDefinitionValue(Reflect.get(value, property, value) as unknown, seen);
  });
  return copy;
};

const inheritedSchemaOperation = (schema: z.ZodType, property: PropertyKey): unknown => {
  const core = zodCoreOf(schema);
  const constructor = core?.constr;
  if (typeof constructor !== "function") return Reflect.get(schema, property, schema) as unknown;
  const definition = cloneDefinitionValue(schema.def, new WeakMap());
  const surrogate = Reflect.construct(constructor, [definition]) as object;
  return Reflect.get(surrogate, property, surrogate) as unknown;
};

const readProperty = (target: object, property: PropertyKey): unknown => {
  if (target instanceof z.ZodType) {
    if (BLOCKED_SCHEMA_METHODS.has(String(property))) return undefined;
    if (property === "meta") return undefined;
    const own = Object.getOwnPropertyDescriptor(target, property);
    const descriptor =
      own ?? findPropertyDescriptor(Object.getPrototypeOf(target) as object, property);
    if (own === undefined && descriptor?.get !== undefined) {
      return inheritedSchemaOperation(target, property);
    }
  }
  return Reflect.get(target, property, target) as unknown;
};

const protectCallback =
  (callback: Callable, context: ProtectionContext): Callable =>
  (...args: readonly unknown[]): unknown => {
    assertIntegrity(context);
    const result = Reflect.apply(
      callback,
      undefined,
      args.map((argument) =>
        typeof argument === "object" && argument !== null
          ? protectObject(argument, context)
          : argument,
      ),
    );
    assertIntegrity(context);
    return unwrapArgument(result, context);
  };

const prepareArgument = (
  receiver: object,
  argument: unknown,
  context: ProtectionContext,
): unknown =>
  typeof argument === "function" &&
  (Array.isArray(receiver) || receiver instanceof Map || receiver instanceof Set)
    ? protectCallback(argument as Callable, context)
    : unwrapArgument(argument, context);

const guardedFunction = (
  receiver: object,
  property: PropertyKey,
  operation: Callable,
  context: ProtectionContext,
): Callable => {
  let receiverFunctions = context.functions.get(receiver);
  if (receiverFunctions === undefined) {
    receiverFunctions = new Map();
    context.functions.set(receiver, receiverFunctions);
  }
  const cached = receiverFunctions.get(property);
  if (cached !== undefined) return cached;

  const guarded = (...args: readonly unknown[]): unknown => {
    assertIntegrity(context);
    if (
      isBlockedMethod(receiver, property) ||
      (receiver instanceof z.ZodType && property === "meta" && args.length > 0)
    ) {
      throw mutationError();
    }
    let result: unknown;
    try {
      result = Reflect.apply(
        operation,
        receiver,
        args.map((arg) => prepareArgument(receiver, arg, context)),
      );
    } catch (error) {
      assertIntegrity(context);
      throw error;
    }
    if (isPromiseLike(result)) {
      return Promise.resolve(result).then(
        (resolved) => {
          assertIntegrity(context);
          return protectResult(resolved, property, context);
        },
        (error: unknown) => {
          assertIntegrity(context);
          throw error;
        },
      );
    }
    assertIntegrity(context);
    return protectResult(result, property, context);
  };
  receiverFunctions.set(property, guarded);
  return guarded;
};

const createShell = (target: object): object => {
  if (Array.isArray(target)) return new Array(target.length);
  return Object.create(Object.getPrototypeOf(target)) as object;
};

const protectProperty = (
  receiver: object,
  property: PropertyKey,
  value: unknown,
  context: ProtectionContext,
): unknown =>
  isBlockedMethod(receiver, property)
    ? blockedFunction(context)
    : receiver instanceof z.ZodType && property === "meta"
      ? schemaMetadataFunction(receiver, context)
      : typeof value === "function"
        ? guardedFunction(receiver, property, value as Callable, context)
        : typeof value === "object" && value !== null
          ? protectObject(value, context)
          : value;

const protectedDescriptor = (
  receiver: object,
  property: PropertyKey,
  descriptor: PropertyDescriptor,
  context: ProtectionContext,
): PropertyDescriptor => ({
  configurable: true,
  enumerable: descriptor.enumerable ?? false,
  value: protectProperty(receiver, property, Reflect.get(receiver, property, receiver), context),
  writable: false,
});

function protectObject<TObject extends object>(
  target: TObject,
  context: ProtectionContext,
): TObject {
  const cached = context.proxies.get(target);
  if (cached !== undefined) return cached as TObject;
  const shell = createShell(target);
  const proxy = new Proxy(shell, {
    defineProperty: () => {
      throw mutationError();
    },
    deleteProperty: () => {
      throw mutationError();
    },
    get: (_shell, property) => {
      assertIntegrity(context);
      return protectProperty(target, property, readProperty(target, property), context);
    },
    getOwnPropertyDescriptor: (shellTarget, property) => {
      assertIntegrity(context);
      const shellDescriptor = Object.getOwnPropertyDescriptor(shellTarget, property);
      if (shellDescriptor?.configurable === false) return shellDescriptor;
      const descriptor = Object.getOwnPropertyDescriptor(target, property);
      return descriptor === undefined
        ? undefined
        : protectedDescriptor(target, property, descriptor, context);
    },
    getPrototypeOf: () => {
      assertIntegrity(context);
      return Object.getPrototypeOf(target);
    },
    has: (_shell, property) => {
      assertIntegrity(context);
      return property in target;
    },
    isExtensible: () => {
      assertIntegrity(context);
      return true;
    },
    ownKeys: (shellTarget) => {
      assertIntegrity(context);
      const targetKeys = Reflect.ownKeys(target);
      const requiredKeys = Reflect.ownKeys(shellTarget).filter(
        (property) =>
          Object.getOwnPropertyDescriptor(shellTarget, property)?.configurable === false,
      );
      return [...new Set([...targetKeys, ...requiredKeys])];
    },
    preventExtensions: () => {
      throw mutationError();
    },
    set: () => {
      throw mutationError();
    },
    setPrototypeOf: () => {
      throw mutationError();
    },
  });
  context.proxies.set(target, proxy);
  context.rawByProxy.set(proxy, target);
  return proxy as TObject;
}

/** Creates a complete read-only membrane around the registered Zod input graph. */
export const createProtectedInputView = <TInput extends z.ZodObject>(
  schema: TInput,
  verify: IntegrityCheck,
): TInput =>
  protectObject(schema, {
    proxies: new WeakMap(),
    rawByProxy: new WeakMap(),
    functions: new WeakMap(),
    verify,
  });

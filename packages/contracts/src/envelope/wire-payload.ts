import { z } from "zod";

import { copyJsonMetadata } from "../registry/schema-graph.js";
import { CommandNameSchema, SemVerSchema } from "../registry/primitives.js";

type JsonPrimitive = null | boolean | number | string;
type JsonArray = readonly JsonValue[];
interface JsonRecord {
  readonly [key: string]: JsonValue;
}
type JsonValue = JsonPrimitive | JsonArray | JsonRecord;

const DangerousArgumentKeys = new Set(["__proto__", "prototype", "constructor"]);

/** A caller-generated UUID used by C1's tenant-scoped idempotency store. */
export const IdempotencyKeySchema = z.uuid();

/** ADR-05 #10: confirmation references identify server-frozen canonical arguments. */
export const ConfirmReferenceSchema = z.uuid();

const containsDangerousArgumentKey = (value: unknown, seen: WeakSet<object>): boolean => {
  if (typeof value !== "object" || value === null || seen.has(value)) return false;
  seen.add(value);
  return Reflect.ownKeys(value).some((key) => {
    if (typeof key === "string" && DangerousArgumentKeys.has(key)) return true;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor
      ? containsDangerousArgumentKey(descriptor.value, seen)
      : false;
  });
};

const copyWireArguments = (value: unknown): Readonly<Record<string, JsonValue>> => {
  if (containsDangerousArgumentKey(value, new WeakSet())) {
    throw new TypeError("Command arguments may not contain prototype-related keys");
  }
  return copyJsonMetadata(value) as Readonly<Record<string, JsonValue>>;
};

/**
 * A2 wire arguments are inert JSON records. C1 still parses them with the A1 command definition
 * before execution; this contract only prevents executable values and shared mutable metadata.
 */
export const WireArgumentsSchema = z.unknown().transform((value, context) => {
  try {
    return copyWireArguments(value);
  } catch {
    context.addIssue({ code: "custom", message: "Command arguments must be a JSON object" });
    return z.NEVER;
  }
});

const WireCommonShape = {
  /** Architecture §6.5: dynamic executions name one A1 command definition. */
  command: CommandNameSchema,
  /** ADR-08: dynamic callers identify the command contract SemVer they prepared. */
  version: SemVerSchema,
  /** Architecture §6.5 / ADR-04 #5: replay key supplied by the calling surface. */
  idempotency_key: IdempotencyKeySchema,
  /** Architecture §6.5: C1 returns a preview without a transaction when true. */
  dry_run: z.boolean(),
};

const DirectCommandWirePayloadSchema = z
  .object({
    ...WireCommonShape,
    mode: z.literal("direct"),
    args: WireArgumentsSchema,
  })
  .strict();

const ConfirmCommandWirePayloadSchema = z
  .object({
    ...WireCommonShape,
    mode: z.literal("confirm"),
    confirm_ref: ConfirmReferenceSchema,
  })
  .strict();

const UnbrandedCommandWirePayloadSchema = z.discriminatedUnion("mode", [
  DirectCommandWirePayloadSchema,
  ConfirmCommandWirePayloadSchema,
]);

declare const COMMAND_WIRE_PAYLOAD_BRAND: unique symbol;

type CommandWirePayloadBrand = Readonly<{
  [COMMAND_WIRE_PAYLOAD_BRAND]: true;
}>;

/**
 * A validated payload for transport inside the application. The private brand prevents a trusted
 * server envelope from being structurally re-used as wire data and leaking injected identity.
 */
export type CommandWirePayload = Readonly<z.output<typeof UnbrandedCommandWirePayloadSchema>> &
  CommandWirePayloadBrand;

/**
 * Client/LLM/Edge-sendable request shape. It deliberately has no actor or tenant fields: C8
 * ignores self-reported identity and injects authenticated context into a separate branded envelope.
 */
export const CommandWirePayloadSchema = UnbrandedCommandWirePayloadSchema.transform(
  (payload): CommandWirePayload => payload as CommandWirePayload,
);

/** @internal Used only by A2 server-envelope construction before the public transport brand. */
export const parseUnbrandedCommandWirePayload = (
  value: unknown,
): z.output<typeof UnbrandedCommandWirePayloadSchema> =>
  UnbrandedCommandWirePayloadSchema.parse(value);

/** Parses untrusted transport input into the branded A2 wire-payload type. */
export const parseCommandWirePayload = (value: unknown): CommandWirePayload =>
  CommandWirePayloadSchema.parse(value);

export type DirectCommandWirePayload = Readonly<z.output<typeof DirectCommandWirePayloadSchema>>;
export type ConfirmCommandWirePayload = Readonly<z.output<typeof ConfirmCommandWirePayloadSchema>>;

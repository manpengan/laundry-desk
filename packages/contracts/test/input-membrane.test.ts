import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineCommand, isContractDefinition } from "../src/index.js";

const baseCommand = {
  name: "orders.cancel",
  version: "1.0.0",
  description: "Cancel an order",
  description_llm: "Cancel one existing order after policy checks.",
  risk: "R3" as const,
  invariants: ["orders.exists"],
  idempotent: true,
  sideEffects: ["orders.status_changed"],
  offline_mode: "denied" as const,
  data_classification: "internal" as const,
  input_redaction: [],
  result_redaction: [],
};

const coreOf = (value: unknown): Record<PropertyKey, unknown> =>
  (value as { _zod: Record<PropertyKey, unknown> })._zod;

describe("public input membrane", () => {
  it("protects own descriptors, keys, prototypes, and extensibility operations", () => {
    const callerInput = z.strictObject({ code: z.string() });
    const definition = defineCommand({
      ...baseCommand,
      input: callerInput,
    });
    const descriptor = Object.getOwnPropertyDescriptor(definition.input, "def");

    expect(Reflect.ownKeys(definition.input)).toContain("def");
    expect(descriptor).toBeDefined();
    const describedDefinition =
      descriptor && "value" in descriptor ? (descriptor.value as Record<string, unknown>) : {};
    expect(describedDefinition).toBe(definition.input.def);
    expect(describedDefinition).not.toBe(callerInput.def);
    expect(() => Reflect.set(describedDefinition, "type", "any")).toThrow(TypeError);
    expect(() => Object.setPrototypeOf(definition.input, null)).toThrow(TypeError);
    expect(() => Object.preventExtensions(definition.input)).toThrow(TypeError);
    expect(Object.isExtensible(definition.input)).toBe(true);
    expect(isContractDefinition(definition)).toBe(true);
  });

  it("blocks mutation of Sets and Arrays reached through the public core", () => {
    const input = z.strictObject({ value: z.union([z.string(), z.number()]) });
    const definition = defineCommand({ ...baseCommand, input });
    const publicCore = coreOf(definition.input);
    const publicTraits = publicCore.traits as Set<string>;
    const publicOptions = definition.input.shape.value.def.options;
    const mutableOptions = publicOptions as unknown as z.ZodType[];

    expect(() => publicTraits.add("TamperedTrait")).toThrow(TypeError);
    expect(() => mutableOptions.push(z.boolean())).toThrow(TypeError);
    expect(publicOptions).toHaveLength(2);
    expect(isContractDefinition(definition)).toBe(true);
  });

  it("blocks mutation of Date values stored in canonical checks", () => {
    const definition = defineCommand({
      ...baseCommand,
      input: z.strictObject({
        received_at: z.date().max(new Date("2026-01-01T00:00:00.000Z")),
      }),
    });
    const checks = definition.input.shape.received_at.def.checks;
    const checkDefinition = coreOf(checks?.[0]).def as { value?: unknown };
    const limit = checkDefinition.value;

    expect(limit).toBeInstanceOf(Date);
    expect(() => (limit as Date).setTime(0)).toThrow(TypeError);
    expect(isContractDefinition(definition)).toBe(true);
  });

  it("blocks public Zod, Standard Schema, and core parsing surfaces", () => {
    const definition = defineCommand({
      ...baseCommand,
      input: z.strictObject({ code: z.string() }),
    });
    const run = coreOf(definition.input).run as () => unknown;

    expect(() => definition.input["~standard"].validate({ code: "ORDER" })).toThrow(TypeError);
    expect(() => definition.input.safeParse({ code: "ORDER" })).toThrow(TypeError);
    expect(() => run()).toThrow(TypeError);
  });

  it("does not block a user field named validate", () => {
    const definition = defineCommand({
      ...baseCommand,
      input: z.strictObject({ validate: z.string() }),
    });

    expect(definition.input.shape.validate).toBeInstanceOf(z.ZodString);
  });

  it("protects container callbacks, copies, and iterator results", () => {
    const definition = defineCommand({
      ...baseCommand,
      input: z.strictObject({ value: z.union([z.string().min(5), z.number()]) }),
    });
    const options = definition.input.shape.value.def.options;
    const exposed: z.ZodType[] = [];

    options.forEach((option) => exposed.push(option));
    exposed.push(options.slice()[0]!, options.values().next().value!);

    exposed.forEach((option) => {
      expect(() => Reflect.set(option.def, "type", "any")).toThrow(TypeError);
    });
    expect(isContractDefinition(definition)).toBe(true);
  });

  it("detects Zod prototype mutation before a public method can run", () => {
    const definition = defineCommand({
      ...baseCommand,
      input: z.strictObject({ code: z.string() }),
    });
    const prototype = Object.getPrototypeOf(definition.input) as object;
    const leak = Symbol("laundry.prototype.leak");

    Object.defineProperty(prototype, leak, {
      configurable: true,
      value(this: { _zod: unknown }) {
        return this._zod;
      },
    });
    try {
      expect(isContractDefinition(definition)).toBe(false);
      expect(() => Reflect.get(definition.input, leak)).toThrow(/integrity/i);
    } finally {
      Reflect.deleteProperty(prototype, leak);
    }
    expect(isContractDefinition(definition)).toBe(true);
  });

  it("protects schema-returning methods and blocks apply/register escape hatches", () => {
    const definition = defineCommand({
      ...baseCommand,
      input: z.strictObject({ code: z.string() }),
    });

    expect(() => definition.input.apply((schema) => schema)).toThrow(TypeError);
    expect(() => definition.input.register(z.globalRegistry, { title: "tampered" })).toThrow(
      TypeError,
    );

    for (const derived of [
      definition.input.brand(),
      definition.input.optional(),
      definition.input.clone(),
    ]) {
      expect(() => Reflect.set(derived.def, "type", "any")).toThrow(TypeError);
    }
    expect(isContractDefinition(definition)).toBe(true);
  });

  it("keeps z.toJSONSchema working through the protected public view", () => {
    const definition = defineCommand({
      ...baseCommand,
      input: z.strictObject({ code: z.string() }),
    });

    expect(z.toJSONSchema(definition.input)).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["code"],
    });
  });
});

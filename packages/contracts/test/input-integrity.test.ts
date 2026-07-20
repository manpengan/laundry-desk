import { describe, expect, it } from "vitest";
import { z, ZodError } from "zod";
import * as mini from "zod/mini";

import {
  defineCommand,
  defineQuery,
  isContractDefinition,
  parseContractInput,
} from "../src/index.js";

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

const checkedMinimum = (schema: z.ZodString): { minimum: number } => {
  const check = schema.def.checks?.[0] as unknown as { _zod: { def: { minimum: number } } };
  return check._zod.def;
};

describe("definition input snapshot", () => {
  it("preserves strictness, refinements, transforms, and public metadata", async () => {
    const input = z
      .strictObject({ quantity: z.string().transform(Number) })
      .refine(({ quantity }) => quantity > 0, "quantity must be positive")
      .meta({ title: "Positive quantity", description: "Decimal quantity string" });
    const definition = defineCommand({ ...baseCommand, input });

    expect(definition.input).not.toBe(input);
    expect(definition.input.meta()).toEqual(input.meta());
    await expect(parseContractInput(definition, { quantity: "0" })).rejects.toThrow(ZodError);
    await expect(parseContractInput(definition, { quantity: "2" })).resolves.toEqual({
      quantity: 2,
    });
    await expect(parseContractInput(definition, { quantity: "2", unknown: true })).rejects.toThrow(
      ZodError,
    );
  });

  it("copies and freezes nested public metadata without mutating the caller", () => {
    const metadata = { title: "Order code", nested: { label: "original" } };
    const input = z.strictObject({ code: z.string() }).meta(metadata);
    const definition = defineCommand({ ...baseCommand, input });

    metadata.nested.label = "caller mutation";
    const publicMetadata = definition.input.meta() as typeof metadata;

    expect(publicMetadata.nested.label).toBe("original");
    expect(() => Reflect.set(publicMetadata.nested, "label", "public mutation")).toThrow(TypeError);
    expect(publicMetadata.nested.label).toBe("original");
    expect(isContractDefinition(definition)).toBe(true);
    expect(metadata.nested.label).toBe("caller mutation");
  });

  it("is not changed when the caller replaces the original object shape", async () => {
    const input = z.strictObject({ quantity: z.string().transform(Number) });
    const definition = defineCommand({ ...baseCommand, input });

    expect(Reflect.set(input.shape, "quantity", z.number())).toBe(true);
    expect(input.safeParse({ quantity: "2" }).success).toBe(false);
    await expect(parseContractInput(definition, { quantity: "2" })).resolves.toEqual({
      quantity: 2,
    });
  });

  it("blocks mutation through the public definition shape", async () => {
    const definition = defineCommand({
      ...baseCommand,
      input: z.strictObject({ orderId: z.string().uuid() }),
    });

    expect(() => Reflect.set(definition.input.shape, "orderId", z.number())).toThrow(TypeError);
    expect(isContractDefinition(definition)).toBe(true);
    await expect(
      parseContractInput(definition, { orderId: crypto.randomUUID() }),
    ).resolves.toBeDefined();
  });

  it("blocks mutation through a public Zod check path", () => {
    const definition = defineCommand({
      ...baseCommand,
      input: z.strictObject({ code: z.string().min(5) }),
    });

    expect(() => Reflect.set(checkedMinimum(definition.input.shape.code), "minimum", 0)).toThrow(
      TypeError,
    );
    expect(isContractDefinition(definition)).toBe(true);
  });

  it("detaches canonical checks from caller-owned checks", async () => {
    const code = z.string().min(5);
    const definition = defineCommand({ ...baseCommand, input: z.strictObject({ code }) });

    checkedMinimum(code).minimum = 0;

    expect(isContractDefinition(definition)).toBe(true);
    await expect(parseContractInput(definition, { code: "x" })).rejects.toThrow(ZodError);
  });

  it("detaches canonical nested schemas from caller-owned schemas", async () => {
    const nested = z.strictObject({ token: z.string() });
    const definition = defineCommand({
      ...baseCommand,
      input: z.strictObject({ credentials: nested }),
      input_redaction: [{ path: "/credentials/token", strategy: "remove" }],
    });

    expect(Reflect.set(nested.shape, "token", z.number())).toBe(true);
    expect(isContractDefinition(definition)).toBe(true);
    await expect(
      parseContractInput(definition, { credentials: { token: "secret" } }),
    ).resolves.toEqual({ credentials: { token: "secret" } });
  });

  it("detaches nested definition containers from caller replacement", async () => {
    const nested = z.strictObject({ token: z.string() });
    const definition = defineCommand({
      ...baseCommand,
      input: z.strictObject({ credentials: nested }),
      input_redaction: [{ path: "/credentials/token", strategy: "remove" }],
    });

    Object.defineProperty(nested, "def", {
      configurable: true,
      enumerable: true,
      value: z.strictObject({ token: z.number() }).def,
      writable: true,
    });

    expect(isContractDefinition(definition)).toBe(true);
    await expect(
      parseContractInput(definition, { credentials: { token: "secret" } }),
    ).resolves.toEqual({ credentials: { token: "secret" } });
  });

  it("detaches nested parse cores from caller replacement", async () => {
    const nested = z.strictObject({ token: z.string() });
    const definition = defineCommand({
      ...baseCommand,
      input: z.strictObject({ credentials: nested }),
      input_redaction: [{ path: "/credentials/token", strategy: "remove" }],
    });
    const core = (nested as typeof nested & { _zod: { run: unknown } })._zod;

    Object.defineProperty(core, "run", { configurable: true, value: () => ({ value: true }) });

    expect(isContractDefinition(definition)).toBe(true);
    await expect(
      parseContractInput(definition, { credentials: { token: "secret" } }),
    ).resolves.toEqual({ credentials: { token: "secret" } });
  });

  it("validates declared input paths against the registered input schema", () => {
    const input = z.strictObject({ order_ids: z.array(z.string()), amount_cents: z.number() });
    expect(() =>
      defineCommand({
        ...baseCommand,
        input,
        input_redaction: [{ path: "/missing/token", strategy: "remove" }],
      }),
    ).toThrow(ZodError);
    expect(() =>
      defineCommand({
        ...baseCommand,
        input,
        size_measures: { batch: { kind: "array_length", path: "/amount_cents" } },
        hard_limits: { max_batch: 1 },
        risk_escalation: { max_batch: 1 },
      }),
    ).toThrow(ZodError);
  });

  it.each([
    {
      input_redaction: [{ path: "/transformed/bogus/deep", strategy: "mask" as const }],
    },
    {
      size_measures: { amount: { kind: "field" as const, path: "/transformed/value" } },
      hard_limits: { max_amount_cents: 1 },
      risk_escalation: { max_amount_cents: 1 },
    },
    {
      size_measures: { batch: { kind: "array_length" as const, path: "/transformed/value" } },
      hard_limits: { max_batch: 1 },
      risk_escalation: { max_batch: 1 },
    },
  ])(
    "rejects declarations that cannot be statically checked through a transform %#",
    (metadata) => {
      const input = z.strictObject({
        transformed: z.strictObject({ value: z.string() }).transform((value) => value),
      });

      expect(() => defineCommand({ ...baseCommand, input, ...metadata })).toThrow(ZodError);
    },
  );

  it.each([
    ["command transform", z.strictObject({ token: z.string() }).transform((value) => value)],
    [
      "command pipe",
      z.strictObject({ token: z.string() }).pipe(z.strictObject({ token: z.string() })),
    ],
  ])("rejects input redaction that crosses a %s", (_label, wrapped) => {
    expect(() =>
      defineCommand({
        ...baseCommand,
        input: z.strictObject({ credentials: wrapped }),
        input_redaction: [{ path: "/credentials/token", strategy: "remove" }],
      }),
    ).toThrow(ZodError);
  });

  it.each([
    ["transform", z.strictObject({ token: z.string() }).transform((value) => value)],
    ["pipe", z.strictObject({ token: z.string() }).pipe(z.strictObject({ token: z.string() }))],
  ])("rejects query input redaction that crosses a %s", (_label, wrapped) => {
    expect(() =>
      defineQuery({
        name: "orders.lookup",
        version: "1.0.0",
        description: "Look up one order",
        description_llm: "Look up one order after authorization.",
        risk: "R1",
        invariants: [],
        idempotent: true,
        sideEffects: [],
        offline_mode: "denied",
        data_classification: "internal",
        input_redaction: [{ path: "/credentials/token", strategy: "remove" }],
        result_redaction: [],
        max_result_rows: 1,
        input: z.strictObject({ credentials: wrapped }),
      }),
    ).toThrow(ZodError);
  });

  it("fails closed for secret offline and redaction declaration boundaries", () => {
    const input = z.strictObject({
      credentials: z.strictObject({ token: z.string() }),
      transformed: z.strictObject({ token: z.string() }).transform((value) => value),
    });
    const secretMetadata = {
      data_classification: "secret" as const,
      input_redaction: [{ path: "/credentials/token", strategy: "remove" as const }],
    };

    expect(() =>
      defineCommand({ ...baseCommand, input, ...secretMetadata, offline_mode: "primary_lease" }),
    ).toThrow(ZodError);
    expect(() =>
      defineCommand({
        ...baseCommand,
        input,
        ...secretMetadata,
        input_redaction: [{ path: "/missing/token", strategy: "remove" }],
      }),
    ).toThrow(ZodError);
    expect(() =>
      defineCommand({
        ...baseCommand,
        input,
        ...secretMetadata,
        input_redaction: [{ path: "/transformed/token", strategy: "remove" }],
      }),
    ).toThrow(ZodError);
  });

  it.each([
    ["mini any", mini.any()],
    ["mini unknown", mini.unknown()],
    ["mini object", mini.strictObject({ value: mini.string() })],
  ])("rejects nested zod/mini $ZodType values: %s", (_label, nested) => {
    expect(() =>
      defineCommand({
        ...baseCommand,
        input: z.strictObject({ nested: nested as never }),
      }),
    ).toThrow(ZodError);
  });

  it("rejects ZodCatch because fallback parsing weakens the input boundary", () => {
    expect(() =>
      defineCommand({
        ...baseCommand,
        input: z.strictObject({ code: z.string().catch("fallback") }),
      }),
    ).toThrow(ZodError);
  });

  it("does not confuse a user field named checks with an internal refinement list", () => {
    expect(() =>
      defineCommand({
        ...baseCommand,
        input: z.strictObject({ checks: z.custom<string>() }),
      }),
    ).toThrow(ZodError);
  });

  it("keeps classic strict objects, refinements, and transforms supported", async () => {
    const definition = defineCommand({
      ...baseCommand,
      input: z
        .strictObject({ quantity: z.string().transform(Number) })
        .refine(({ quantity }) => quantity > 0),
    });

    await expect(parseContractInput(definition, { quantity: "2" })).resolves.toEqual({
      quantity: 2,
    });
  });

  it("detaches caller-owned RegExp execution state", async () => {
    const pattern = /ORDER/u;
    const definition = defineCommand({
      ...baseCommand,
      input: z.strictObject({ code: z.string().regex(pattern) }),
    });

    pattern.exec("ORDER");
    Object.defineProperty(pattern, "lastIndex", { value: 1, writable: true });

    expect(isContractDefinition(definition)).toBe(true);
    await expect(parseContractInput(definition, { code: "ORDER" })).resolves.toEqual({
      code: "ORDER",
    });
  });

  it("detaches RegExp internal slots from caller-owned patterns", async () => {
    const pattern = /^ORDER$/u;
    const definition = defineCommand({
      ...baseCommand,
      input: z.strictObject({ code: z.string().regex(pattern) }),
    });

    pattern.compile(".*", "u");

    expect(isContractDefinition(definition)).toBe(true);
    await expect(parseContractInput(definition, { code: "BAD" })).rejects.toThrow(ZodError);
  });

  it("detaches schema containers from caller descriptor changes", () => {
    const child = z.string();
    const definition = defineCommand({
      ...baseCommand,
      input: z.strictObject({ code: child }),
    });

    Object.defineProperty(child.def, Symbol.for("laundry.tamper"), {
      configurable: true,
      value: true,
    });
    Object.setPrototypeOf(child.def, null);

    expect(isContractDefinition(definition)).toBe(true);
  });

  it("does not evaluate irrelevant caller core accessors", () => {
    const child = z.string();
    let reads = 0;
    Object.defineProperty(child._zod.bag, "dynamic", {
      configurable: true,
      enumerable: true,
      get: () => {
        reads += 1;
        return reads;
      },
    });

    const definition = defineCommand({ ...baseCommand, input: z.strictObject({ code: child }) });
    expect(reads).toBe(0);
    expect(isContractDefinition(definition)).toBe(true);
  });

  it("rejects a caller-defined accessor added to a child schema definition", () => {
    const child = z.string();
    Object.defineProperty(child.def, "dynamic", {
      configurable: true,
      enumerable: true,
      get: () => z.any(),
    });

    expect(() => defineCommand({ ...baseCommand, input: z.strictObject({ code: child }) })).toThrow(
      /accessor/i,
    );
  });

  it("does not share caller-added mutable core containers", () => {
    const child = z.string().regex(/ORDER/u);
    const map = new Map<string, number>([["limit", 1]]);
    (child._zod.bag as Record<string, unknown>).limits = map;
    const definition = defineCommand({
      ...baseCommand,
      input: z.strictObject({ code: child }),
    });

    map.set("limit", 2);
    child._zod.traits.add("TamperedTrait");

    expect(isContractDefinition(definition)).toBe(true);
  });

  it("isolates canonical parsing from caller mutation inside a transform", async () => {
    const child = z.string().transform((value) => {
      Object.defineProperty(child, "type", { configurable: true, value: "number" });
      return value;
    }) as unknown as z.ZodString;
    const definition = defineCommand({
      ...baseCommand,
      input: z.strictObject({ code: child }),
    });

    await expect(parseContractInput(definition, { code: "ORDER" })).resolves.toEqual({
      code: "ORDER",
    });
    expect(isContractDefinition(definition)).toBe(true);
  });

  it("isolates canonical parsing from transient caller-schema mutation", async () => {
    const victim = z.string();
    const originalRun = victim._zod.run;
    const permissiveRun = z.any()._zod.run;
    const definition = defineCommand({
      ...baseCommand,
      input: z.strictObject({
        start: z.string().transform((value) => {
          victim._zod.run = permissiveRun;
          return value;
        }),
        payload: victim,
        finish: z.string().transform((value) => {
          victim._zod.run = originalRun;
          return value;
        }),
      }),
    });

    await expect(
      parseContractInput(definition, { start: "x", payload: 123, finish: "x" }),
    ).rejects.toThrow(ZodError);
    expect(isContractDefinition(definition)).toBe(true);
  });

  it("preserves caller refinements while isolating their schema mutations", async () => {
    const source = z.string().superRefine((_value, context) => {
      Object.defineProperty(source, "type", { configurable: true, value: "number" });
      context.addIssue({ code: "custom", message: "rejected" });
    });
    const definition = defineCommand({
      ...baseCommand,
      input: z.strictObject({ code: source }),
    });

    await expect(parseContractInput(definition, { code: "ORDER" })).rejects.toThrow(ZodError);
    expect(isContractDefinition(definition)).toBe(true);
  });

  it("supports asynchronous transforms only through the canonical parser", async () => {
    const source = z.string();
    const field = source.transform(async (value) => {
      await Promise.resolve();
      Object.defineProperty(source, "type", { configurable: true, value: "number" });
      return value;
    });
    const definition = defineCommand({
      ...baseCommand,
      input: z.strictObject({ code: field }),
    });

    await expect(parseContractInput(definition, { code: "ORDER" })).resolves.toEqual({
      code: "ORDER",
    });
    expect(isContractDefinition(definition)).toBe(true);
  });
});

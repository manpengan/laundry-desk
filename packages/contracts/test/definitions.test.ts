import { describe, expect, it } from "vitest";
import { z, ZodError } from "zod";

import {
  defineCommand,
  defineQuery,
  isAiProjectableDefinition,
  isContractDefinition,
  parseContractInput,
} from "../src/index.js";

const commandInput = z.strictObject({
  orderId: z.string().uuid(),
  order_ids: z.array(z.string().uuid()),
  amount_cents: z.number().int(),
});

const validCommand = {
  name: "orders.cancel",
  version: "1.0.0",
  description: "Cancel an order",
  description_llm: "Cancel one existing order after policy checks.",
  input: commandInput,
  risk: "R3" as const,
  invariants: ["orders.exists"],
  idempotent: true,
  sideEffects: ["orders.status_changed"],
  offline_mode: "denied" as const,
  data_classification: "internal" as const,
  input_redaction: [],
  result_redaction: [],
  size_measures: {
    batch: { kind: "array_length" as const, path: "/order_ids" },
    amount: { kind: "field" as const, path: "/amount_cents" },
  },
  hard_limits: { max_batch: 20, max_amount_cents: 100_000 },
  risk_escalation: { max_batch: 10, max_amount_cents: 50_000 },
};

const validQuery = {
  name: "orders.get",
  version: "1.0.0",
  description: "Read an order",
  description_llm: "Read one order without causing side effects.",
  input: commandInput,
  risk: "R1" as const,
  invariants: [],
  idempotent: true as const,
  sideEffects: [],
  offline_mode: "denied" as const,
  data_classification: "internal" as const,
  input_redaction: [],
  result_redaction: [],
  max_result_rows: 1,
};

const expectInputIssue = (operation: () => unknown): void => {
  try {
    operation();
    throw new Error("Expected a ZodError");
  } catch (error) {
    expect(error).toBeInstanceOf(ZodError);
    if (!(error instanceof ZodError)) throw error;
    expect(error.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: ["input"] })]),
    );
  }
};

describe("definition discriminators", () => {
  it("adds the command discriminator after validating caller metadata", () => {
    const definition = defineCommand(validCommand);

    expect(definition).toMatchObject({ kind: "command", name: "orders.cancel" });
  });

  it("adds the query discriminator after validating caller metadata", () => {
    const definition = defineQuery(validQuery);

    expect(definition).toMatchObject({ kind: "query", name: "orders.get" });
  });

  it.each(["command", "query"] as const)(
    "rejects a caller-supplied command kind set to %s",
    (kind) => {
      expect(() => defineCommand({ ...validCommand, kind } as never)).toThrow(ZodError);
    },
  );

  it.each(["command", "query"] as const)(
    "rejects a caller-supplied query kind set to %s",
    (kind) => {
      expect(() => defineQuery({ ...validQuery, kind } as never)).toThrow(ZodError);
    },
  );

  it.each([
    ["command", () => defineCommand({ ...validCommand, unexpected: true } as never)],
    ["query", () => defineQuery({ ...validQuery, unexpected: true } as never)],
  ])("rejects unknown %s definition fields", (_kind, operation) => {
    expect(operation).toThrow(ZodError);
  });
});

describe("strict definition input boundary", () => {
  const forgedInput = {
    parse: () => undefined,
    safeParse: () => ({ success: true, data: undefined }),
  };

  it.each([
    ["command", validCommand, (candidate: never) => defineCommand(candidate)],
    ["query", validQuery, (candidate: never) => defineQuery(candidate)],
  ] as const)("rejects a %s definition missing input", (_kind, definition, factory) => {
    const candidate: Record<string, unknown> = { ...definition };
    delete candidate.input;

    expect(() => factory(candidate as never)).toThrow(ZodError);
  });

  it.each([
    ["z.any", z.any()],
    ["z.unknown", z.unknown()],
    ["array", z.array(z.string())],
    ["default strip object", z.object({ orderId: z.string() })],
    ["explicit strip object", z.object({ orderId: z.string() }).strip()],
    ["passthrough object", z.object({ orderId: z.string() }).passthrough()],
    ["loose object", z.looseObject({ orderId: z.string() })],
    ["forged schema", forgedInput],
  ])("rejects %s as command input", (_label, input) => {
    expectInputIssue(() => defineCommand({ ...validCommand, input } as never));
  });

  it.each([
    ["z.any", z.any()],
    ["default strip object", z.object({ orderId: z.string() })],
    ["passthrough object", z.object({ orderId: z.string() }).passthrough()],
    ["forged schema", forgedInput],
  ])("rejects %s as query input", (_label, input) => {
    expectInputIssue(() => defineQuery({ ...validQuery, input } as never));
  });

  it.each([
    ["nested z.any", z.strictObject({ payload: z.object({ value: z.any() }).strict() })],
    ["nested z.unknown", z.strictObject({ payload: z.array(z.unknown()) })],
    ["nested lazy any", z.strictObject({ payload: z.lazy(() => z.any()) })],
    ["standalone custom", z.strictObject({ payload: z.custom() })],
    ["standalone transform", z.strictObject({ payload: z.transform((value) => value) })],
    ["custom pipe output", z.strictObject({ payload: z.string().pipe(z.custom()) })],
    ["nested default-strip object", z.strictObject({ payload: z.object({ value: z.string() }) })],
    [
      "nested passthrough object",
      z.strictObject({ payload: z.object({ value: z.string() }).passthrough() }),
    ],
  ])("rejects %s in a contract input graph", (_label, input) => {
    expectInputIssue(() => defineCommand({ ...validCommand, input } as never));
    expectInputIssue(() => defineQuery({ ...validQuery, input } as never));
  });

  it.each([
    ["command", () => defineCommand(undefined as never)],
    ["query", () => defineQuery(null as never)],
  ])("reports an invalid %s envelope as ZodError", (_kind, operation) => {
    expect(operation).toThrow(ZodError);
  });

  it("uses the input value captured by validation instead of reading a caller getter twice", async () => {
    const candidate = { ...validCommand };
    let reads = 0;
    Object.defineProperty(candidate, "input", {
      configurable: true,
      enumerable: true,
      get: () => {
        reads += 1;
        return reads === 1 ? commandInput : z.any();
      },
    });

    const definition = defineCommand(candidate);

    expect(reads).toBe(1);
    await expect(
      parseContractInput(definition, {
        orderId: crypto.randomUUID(),
        order_ids: [],
        amount_cents: 0,
      }),
    ).resolves.toBeDefined();
  });
});

describe("immutable branded definitions", () => {
  it("deeply freezes copied serializable metadata without freezing caller values or input", () => {
    const invariants = ["orders.exists"];
    const batchMeasure = { kind: "array_length" as const, path: "/order_ids" };
    const sizeMeasures = {
      batch: batchMeasure,
      amount: { kind: "field" as const, path: "/amount_cents" },
    };
    const hardLimits = { max_batch: 20, max_amount_cents: 100_000 };
    const inputRule: {
      path: string;
      strategy: "remove" | "mask" | "last4";
    } = { path: "/pin", strategy: "remove" };
    const definition = defineCommand({
      ...validCommand,
      invariants,
      input: z.strictObject({
        orderId: z.string().uuid(),
        order_ids: z.array(z.string().uuid()),
        amount_cents: z.number().int(),
        pin: z.string(),
      }),
      input_redaction: [inputRule],
      size_measures: sizeMeasures,
      hard_limits: hardLimits,
    });

    invariants.push("orders.caller_mutation");
    batchMeasure.path = "/caller_mutation";
    hardLimits.max_batch = 1;
    inputRule.strategy = "mask";

    expect(definition.invariants).toEqual(["orders.exists"]);
    expect(definition.size_measures?.batch).toEqual({
      kind: "array_length",
      path: "/order_ids",
    });
    expect(definition.hard_limits?.max_batch).toBe(20);
    expect(definition.input_redaction).toEqual([{ path: "/pin", strategy: "remove" }]);
    expect(Object.isFrozen(definition)).toBe(true);
    expect(Object.isFrozen(definition.invariants)).toBe(true);
    expect(Object.isFrozen(definition.input_redaction[0])).toBe(true);
    expect(Object.isFrozen(definition.size_measures)).toBe(true);
    expect(Object.isFrozen(definition.size_measures?.batch)).toBe(true);
    expect(Object.isFrozen(definition.hard_limits)).toBe(true);
    expect(Object.isFrozen(definition.risk_escalation)).toBe(true);
    expect(Object.isFrozen(definition.input)).toBe(false);
    expect(Object.isFrozen(invariants)).toBe(false);
    expect(Object.isFrozen(sizeMeasures)).toBe(false);
    expect(Object.isFrozen(hardLimits)).toBe(false);
  });

  it("uses registry provenance rather than structural shape", () => {
    const definition = defineCommand(validCommand);
    const spreadClone = { ...definition };

    expect(isContractDefinition(definition)).toBe(true);
    expect(isContractDefinition(spreadClone)).toBe(false);
    expect(isContractDefinition({ ...validCommand, kind: "command" })).toBe(false);
    expect(isContractDefinition(null)).toBe(false);
    expect(Object.getOwnPropertySymbols(definition)).toEqual([]);
  });

  it("mechanically excludes R5 commands from AI projection", () => {
    const r5 = defineCommand({
      ...validCommand,
      risk: "R5",
      data_classification: "secret",
      input_redaction: [{ path: "/orderId", strategy: "remove" }],
      hard_limits: undefined,
      risk_escalation: undefined,
      size_measures: undefined,
    });

    expect(isAiProjectableDefinition(r5)).toBe(false);
    expect(isAiProjectableDefinition(defineCommand(validCommand))).toBe(true);
    expect(isAiProjectableDefinition(defineQuery(validQuery))).toBe(true);
  });
});

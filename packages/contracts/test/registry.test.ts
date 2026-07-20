import { describe, expect, expectTypeOf, it } from "vitest";
import { z, ZodError } from "zod";

import {
  defineCommand,
  defineQuery,
  type ContractDefinition,
  type InferContractInput,
  type InferContractOutput,
} from "../src/index.js";

const input = z.object({ orderId: z.string().uuid() });

const validCommand = {
  name: "orders.cancel",
  version: "1.0.0",
  description: "Cancel an order",
  input,
  risk: "R3" as const,
  invariants: ["orders.exists"],
  idempotent: true,
  sideEffects: ["orders.status_changed"],
  offline_allowed: false,
  data_classification: "internal" as const,
  max_batch: 1,
  result_redaction: [],
};

const validQuery = {
  ...validCommand,
  name: "orders.get",
  risk: "R1" as const,
  idempotent: true as const,
  sideEffects: [],
  offline_allowed: false as const,
};

const expectInputZodError = (operation: () => unknown): void => {
  try {
    operation();
    throw new Error("Expected operation to throw");
  } catch (error) {
    expect(error).toBeInstanceOf(ZodError);
    if (!(error instanceof ZodError)) {
      throw error;
    }
    expect(error.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: ["input"] })]),
    );
  }
};

const expectDiscriminatedContract = (
  definition: ContractDefinition<"command" | "query", typeof input>,
): void => {
  if (definition.kind === "query") {
    expectTypeOf(definition.risk).toEqualTypeOf<"R0" | "R1" | "R2">();
    expectTypeOf(definition.idempotent).toEqualTypeOf<true>();
    expectTypeOf(definition.offline_allowed).toEqualTypeOf<false>();
    expectTypeOf(definition.sideEffects).toEqualTypeOf<readonly never[]>();
  }
};

describe("defineCommand metadata", () => {
  it("accepts a valid command definition", () => {
    const definition = defineCommand(validCommand);

    expect(definition).toMatchObject({
      kind: "command",
      name: "orders.cancel",
      version: "1.0.0",
    });
    expect(definition.input).toBe(input);
  });

  it.each([
    "risk",
    "idempotent",
    "offline_allowed",
    "data_classification",
    "max_batch",
    "result_redaction",
  ] as const)("rejects a missing %s safety field", (field) => {
    const candidate = { ...validCommand } as Record<string, unknown>;
    delete candidate[field];

    expect(() => defineCommand(candidate as never)).toThrow(ZodError);
  });

  it.each([
    ["name", "Orders.Cancel"],
    ["version", "1"],
    ["version", "1.0.0-01"],
    ["max_batch", 0],
    ["max_batch", 1.5],
  ])("rejects invalid %s metadata", (field, value) => {
    expect(() => defineCommand({ ...validCommand, [field]: value } as never)).toThrow(ZodError);
  });

  it.each([
    ["invariants", ["Orders.exists"]],
    ["invariants", ["orders..exists"]],
    ["invariants", ["orders-exists"]],
    ["sideEffects", ["Orders.status_changed"]],
    ["sideEffects", ["orders..status_changed"]],
    ["sideEffects", ["orders-status_changed"]],
  ])("rejects invalid stable IDs in %s", (field, value) => {
    expect(() => defineCommand({ ...validCommand, [field]: value } as never)).toThrow(ZodError);
  });

  it.each(["01.0.0", "1.01.0", "1.0.01"])("rejects leading zeroes in core SemVer %s", (version) => {
    expect(() => defineCommand({ ...validCommand, version } as never)).toThrow(ZodError);
  });

  it.each(["1.0.0-", "1.0.0-alpha.", "1.0.0-alpha..1", "1.0.0+", "1.0.0+build.", "1.0.0+build..1"])(
    "rejects empty prerelease or build identifiers in SemVer %s",
    (version) => {
      expect(() => defineCommand({ ...validCommand, version } as never)).toThrow(ZodError);
    },
  );

  it("accepts prerelease and build SemVer metadata", () => {
    const definition = defineCommand({
      ...validCommand,
      version: "1.0.0-rc.1+build.7",
    });

    expect(definition.version).toBe("1.0.0-rc.1+build.7");
  });

  it.each([
    ["invariants", ["orders.exists", "orders.exists"]],
    ["sideEffects", ["orders.status_changed", "orders.status_changed"]],
  ])("rejects duplicate %s identifiers", (field, value) => {
    expect(() => defineCommand({ ...validCommand, [field]: value } as never)).toThrow(ZodError);
  });

  it("rejects unknown metadata fields", () => {
    expect(() => defineCommand({ ...validCommand, unexpected: true } as never)).toThrow(ZodError);
  });

  it.each(["", "   \t\n"])("rejects an empty description %#", (description) => {
    expect(() => defineCommand({ ...validCommand, description } as never)).toThrow(ZodError);
  });

  it.each(["customer/phone", "/customer/~phone"])("rejects invalid JSON Pointer %s", (path) => {
    expect(() =>
      defineCommand({
        ...validCommand,
        result_redaction: [{ path, strategy: "remove" }],
      } as never),
    ).toThrow(ZodError);
  });

  it("rejects an empty JSON Pointer", () => {
    expect(() =>
      defineCommand({
        ...validCommand,
        result_redaction: [{ path: "", strategy: "remove" }],
      } as never),
    ).toThrow(ZodError);
  });

  it.each([
    ["risk", "R6"],
    ["data_classification", "secret"],
    ["result_redaction", [{ path: "/customer/phone", strategy: "encrypt" }]],
  ])("rejects invalid %s enum values", (field, value) => {
    expect(() => defineCommand({ ...validCommand, [field]: value } as never)).toThrow(ZodError);
  });

  it("rejects unknown keys inside redaction rules", () => {
    expect(() =>
      defineCommand({
        ...validCommand,
        result_redaction: [{ path: "/customer/phone", strategy: "mask", unexpected: true }],
      } as never),
    ).toThrow(ZodError);
  });

  it("accepts escaped JSON Pointers and preserves redaction rule order", () => {
    const resultRedaction = [
      { path: "/customer/~0tag", strategy: "mask" as const },
      { path: "/customer/a~1b", strategy: "last4" as const },
    ];

    const definition = defineCommand({
      ...validCommand,
      result_redaction: resultRedaction,
    });

    expect(definition.result_redaction).toEqual(resultRedaction);
  });

  it("accepts root and empty-token JSON Pointers", () => {
    const resultRedaction = [
      { path: "/", strategy: "remove" as const },
      { path: "//", strategy: "mask" as const },
    ];

    const definition = defineCommand({ ...validCommand, result_redaction: resultRedaction });

    expect(definition.result_redaction).toEqual(resultRedaction);
  });
});

describe("defineQuery metadata", () => {
  it("returns a query and preserves the concrete input schema", () => {
    const definition = defineQuery(validQuery);

    expect(definition.kind).toBe("query");
    expect(definition.input).toBe(input);
  });

  it.each(["R3", "R4", "R5"])("rejects query risk %s", (risk) => {
    expect(() => defineQuery({ ...validQuery, risk } as never)).toThrow(ZodError);
  });

  it.each([
    ["idempotent", false],
    ["offline_allowed", true],
    ["sideEffects", ["orders.read"]],
  ])("rejects unsafe query %s metadata", (field, value) => {
    expect(() => defineQuery({ ...validQuery, [field]: value } as never)).toThrow(ZodError);
  });
});

describe("definition input boundary", () => {
  const fakeInput = {
    parse: () => undefined,
    safeParse: () => ({ success: true, data: undefined }),
  };

  it.each([
    ["command", () => defineCommand({ ...validCommand, input: fakeInput } as never)],
    ["query", () => defineQuery({ ...validQuery, input: fakeInput } as never)],
  ])("rejects a forged %s input with an input-path Zod issue", (_kind, operation) => {
    expectInputZodError(operation);
  });

  it.each([
    ["command", () => defineCommand(undefined as never)],
    ["query", () => defineQuery(null as never)],
  ])("reports an invalid %s envelope as ZodError", (_kind, operation) => {
    expect(operation).toThrow(ZodError);
  });
});

describe("immutable contract definitions", () => {
  it("copies and deeply freezes caller-owned metadata without freezing input", () => {
    const invariants = ["orders.exists"];
    const sideEffects = ["orders.status_changed"];
    const rule: { path: string; strategy: "remove" | "mask" | "last4" } = {
      path: "/customer/phone",
      strategy: "mask",
    };
    const resultRedaction = [rule];
    const definition = defineCommand({
      ...validCommand,
      invariants,
      sideEffects,
      result_redaction: resultRedaction,
    });

    invariants.push("orders.mutable_caller");
    sideEffects.splice(0, 1, "orders.mutable_caller");
    rule.strategy = "remove";
    resultRedaction.push({ path: "/customer/name", strategy: "remove" });

    expect(definition.invariants).toEqual(["orders.exists"]);
    expect(definition.sideEffects).toEqual(["orders.status_changed"]);
    expect(definition.result_redaction).toEqual([{ path: "/customer/phone", strategy: "mask" }]);
    expect(Object.isFrozen(definition)).toBe(true);
    expect(Object.isFrozen(definition.invariants)).toBe(true);
    expect(Object.isFrozen(definition.sideEffects)).toBe(true);
    expect(Object.isFrozen(definition.result_redaction)).toBe(true);
    expect(Object.isFrozen(definition.result_redaction[0])).toBe(true);
    expect(definition.input).toBe(input);
    expect(Object.isFrozen(definition.input)).toBe(false);

    expect(Reflect.set(definition, "description", "mutated")).toBe(false);
    expect(Reflect.set(definition.result_redaction[0]!, "strategy", "remove")).toBe(false);
    expect(() => Array.prototype.push.call(definition.invariants, "orders.write")).toThrow(
      TypeError,
    );
    expect(() => Array.prototype.splice.call(definition.sideEffects, 0, 1)).toThrow(TypeError);
    expect(() => Array.prototype.pop.call(definition.result_redaction)).toThrow(TypeError);
  });
});

describe("contract input and output inference", () => {
  it("preserves query literals when discriminating a contract definition union", () => {
    expectDiscriminatedContract(defineCommand(validCommand));
    expectDiscriminatedContract(defineQuery(validQuery));
  });

  it("distinguishes pre-transform input from parsed output", () => {
    const transformingCommand = defineCommand({
      ...validCommand,
      input: z.object({ quantity: z.string().transform(Number) }),
    });

    expectTypeOf<InferContractInput<typeof transformingCommand>>().toEqualTypeOf<{
      quantity: string;
    }>();
    expectTypeOf<InferContractOutput<typeof transformingCommand>>().toEqualTypeOf<{
      quantity: number;
    }>();
  });
});

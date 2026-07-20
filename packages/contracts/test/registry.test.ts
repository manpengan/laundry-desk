import { describe, expect, it } from "vitest";
import { z, ZodError } from "zod";

import { defineCommand } from "../src/index.js";

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
});

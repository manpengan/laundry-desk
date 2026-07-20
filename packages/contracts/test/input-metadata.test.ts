import { describe, expect, it } from "vitest";
import { z, ZodError } from "zod";

import { defineCommand, isContractDefinition, parseContractInput } from "../src/index.js";

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

describe("input schema metadata", () => {
  it.each([
    ["Date", new Date("2026-07-20T00:00:00Z")],
    ["Map", new Map([["key", "value"]])],
    ["Set", new Set(["value"])],
    ["class instance", new (class Metadata {})()],
  ])("rejects non-JSON-compatible %s metadata", (_label, unsafe) => {
    const input = z.strictObject({ code: z.string() }).meta({ unsafe } as never);

    expect(() => defineCommand({ ...baseCommand, input })).toThrow(ZodError);
  });

  it("rejects accessor metadata without evaluating the getter", () => {
    let reads = 0;
    const metadata = Object.defineProperty({}, "title", {
      enumerable: true,
      get: () => {
        reads += 1;
        return "dynamic";
      },
    });
    const input = z.strictObject({ code: z.string() }).meta(metadata);

    expect(() => defineCommand({ ...baseCommand, input })).toThrow(ZodError);
    expect(reads).toBe(0);
  });

  it("snapshots metadata recursively and detaches shared child changes", async () => {
    const nestedMetadata = { title: "Secret", nested: { label: "original" } };
    const child = z.string().meta(nestedMetadata);
    const definition = defineCommand({
      ...baseCommand,
      input: z.strictObject({ code: child }).meta({ title: "Order input" }),
    });

    nestedMetadata.nested.label = "tampered";

    expect(isContractDefinition(definition)).toBe(true);
    expect(definition.input.shape.code.meta()).toEqual({
      title: "Secret",
      nested: { label: "original" },
    });
    await expect(parseContractInput(definition, { code: "ORDER" })).resolves.toEqual({
      code: "ORDER",
    });
  });

  it("blocks public child registration and metadata mutation", () => {
    const child = z.string().meta({ nested: { label: "original" } });
    const definition = defineCommand({
      ...baseCommand,
      input: z.strictObject({ code: child }),
    });
    const publicChild = definition.input.shape.code;
    const publicMetadata = publicChild.meta() as { nested: { label: string } };

    expect(() => publicChild.register(z.globalRegistry, { title: "tampered" })).toThrow(TypeError);
    expect(() => Reflect.set(publicMetadata.nested, "label", "tampered")).toThrow(TypeError);
    expect(publicChild.meta()).toEqual({ nested: { label: "original" } });
    expect(isContractDefinition(definition)).toBe(true);
  });

  it("detaches canonical metadata when the caller re-registers a child", () => {
    const child = z.string().meta({ title: "original" });
    const definition = defineCommand({
      ...baseCommand,
      input: z.strictObject({ code: child }),
    });

    child.register(z.globalRegistry, { title: "tampered" });

    expect(isContractDefinition(definition)).toBe(true);
    expect(definition.input.shape.code.meta()).toEqual({ title: "original" });
  });
});

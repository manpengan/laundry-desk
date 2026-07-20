import { describe, expect, it } from "vitest";
import { z, ZodError } from "zod";

import { defineCommand, parseContractInput } from "../src/index.js";

const baseCommand = {
  name: "orders.update",
  version: "1.0.0",
  description: "Update an order",
  description_llm: "Update one order after validating its optional fields.",
  risk: "R3" as const,
  invariants: ["orders.exists"],
  idempotent: true,
  sideEffects: ["orders.updated"],
  offline_mode: "denied" as const,
  data_classification: "internal" as const,
  input_redaction: [],
  result_redaction: [],
};

describe("supported contract input schemas", () => {
  it("supports optional, nullable, union, and discriminated-union fields", async () => {
    const definition = defineCommand({
      ...baseCommand,
      input: z.strictObject({
        note: z.string().optional(),
        pickup_at: z.string().nullable(),
        reference: z.union([z.string(), z.number()]),
        destination: z.discriminatedUnion("kind", [
          z.strictObject({ kind: z.literal("store"), store_id: z.string().uuid() }),
          z.strictObject({ kind: z.literal("locker"), locker_id: z.string().uuid() }),
        ]),
      }),
    });
    const storeId = crypto.randomUUID();

    await expect(
      parseContractInput(definition, {
        pickup_at: null,
        reference: 42,
        destination: { kind: "store", store_id: storeId },
      }),
    ).resolves.toEqual({
      pickup_at: null,
      reference: 42,
      destination: { kind: "store", store_id: storeId },
    });
  });

  it("supports asynchronous canonical transforms", async () => {
    const definition = defineCommand({
      ...baseCommand,
      input: z.strictObject({
        code: z.string().transform(async (value) => Promise.resolve(value.toUpperCase())),
      }),
    });

    await expect(parseContractInput(definition, { code: "order" })).resolves.toEqual({
      code: "ORDER",
    });
  });

  it("reads a caller shape accessor once and validates that exact snapshot", async () => {
    const input = z.strictObject({ code: z.string() });
    let reads = 0;
    Object.defineProperty(input.def, "shape", {
      configurable: true,
      enumerable: true,
      get: () => {
        reads += 1;
        return reads === 1 ? { code: z.string() } : { code: z.any() };
      },
    });

    const definition = defineCommand({ ...baseCommand, input });

    expect(reads).toBe(1);
    await expect(parseContractInput(definition, { code: 123 })).rejects.toThrow(ZodError);
  });

  it.each([
    ["catch", z.string().catch("fallback")],
    ["default", z.string().default("fallback")],
    ["prefault", z.string().prefault("fallback")],
    ["global regexp", z.string().regex(/ORDER/gu)],
    ["sticky regexp", z.string().regex(/ORDER/uy)],
    ["invalid date limit", z.date().max(new Date(Number.NaN))],
  ])("rejects stateful or fallback input semantics: %s", (_label, field) => {
    expect(() => defineCommand({ ...baseCommand, input: z.strictObject({ field }) })).toThrow(
      ZodError,
    );
  });
});

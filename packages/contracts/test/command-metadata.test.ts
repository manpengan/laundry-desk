import { describe, expect, it } from "vitest";
import { ZodError } from "zod";

import { CommandMetadataSchema } from "../src/registry/schemas.js";

const commandWithoutEscalation = {
  kind: "command",
  name: "orders.cancel",
  version: "1.0.0",
  description: "Cancel an order",
  description_llm: "Cancel one existing order after explicit confirmation.",
  risk: "R3",
  invariants: ["orders.exists"],
  idempotent: true,
  sideEffects: ["orders.status_changed"],
  offline_mode: "denied",
  data_classification: "internal",
  input_redaction: [],
  result_redaction: [],
  size_measures: { batch: { kind: "array_length", path: "/order_ids" } },
  hard_limits: { max_batch: 100 },
} as const;

const validCommand = {
  ...commandWithoutEscalation,
  risk_escalation: { max_batch: 20 },
} as const;

describe("command metadata safety fields", () => {
  it("accepts a complete ADR-09 command", () => {
    expect(CommandMetadataSchema.parse(validCommand)).toEqual(validCommand);
  });

  it.each([
    "risk",
    "idempotent",
    "offline_mode",
    "data_classification",
    "input_redaction",
    "result_redaction",
    "description_llm",
  ] as const)("rejects missing %s", (field) => {
    const candidate: Record<string, unknown> = { ...validCommand };
    delete candidate[field];

    expect(() => CommandMetadataSchema.parse(candidate)).toThrow(ZodError);
  });

  it.each(["denied", "grant", "primary_lease"])("accepts offline mode %s", (offline_mode) => {
    expect(CommandMetadataSchema.parse({ ...validCommand, offline_mode }).offline_mode).toBe(
      offline_mode,
    );
  });

  it.each(["grant", "primary_lease"])(
    "requires idempotency for offline mode %s",
    (offline_mode) => {
      expect(() =>
        CommandMetadataSchema.parse({ ...validCommand, offline_mode, idempotent: false }),
      ).toThrow(ZodError);
    },
  );

  it("rejects unknown metadata", () => {
    expect(() => CommandMetadataSchema.parse({ ...validCommand, max_batch: 1 })).toThrow(ZodError);
  });

  it.each(["", "  "])("rejects empty model description %#", (description_llm) => {
    expect(() => CommandMetadataSchema.parse({ ...validCommand, description_llm })).toThrow(
      ZodError,
    );
  });
});

describe("command risk and secret rules", () => {
  it.each(["R0", "R1", "R2", "R4", "R5"])("rejects risk escalation for base risk %s", (risk) => {
    expect(() => CommandMetadataSchema.parse({ ...validCommand, risk })).toThrow(ZodError);
  });

  it("allows non-R3 commands when risk escalation is absent", () => {
    expect(CommandMetadataSchema.parse({ ...commandWithoutEscalation, risk: "R4" }).risk).toBe(
      "R4",
    );
  });

  it("accepts a fail-closed secret command with remove-only input redaction", () => {
    const secretCommand = {
      ...commandWithoutEscalation,
      risk: "R5",
      data_classification: "secret",
      input_redaction: [{ path: "/credentials/token", strategy: "remove" }],
    };

    expect(CommandMetadataSchema.parse(secretCommand).data_classification).toBe("secret");
  });

  it.each([
    { risk: "R4" },
    { offline_mode: "grant" },
    { input_redaction: [] },
    { input_redaction: [{ path: "/credentials/token", strategy: "mask" }] },
  ])("rejects unsafe secret combination %#", (change) => {
    const secretCommand = {
      ...commandWithoutEscalation,
      risk: "R5",
      data_classification: "secret",
      input_redaction: [{ path: "/credentials/token", strategy: "remove" }],
      ...change,
    };

    expect(() => CommandMetadataSchema.parse(secretCommand)).toThrow(ZodError);
  });
});

describe("command limit relationships", () => {
  it("requires the corresponding measure for every declared threshold", () => {
    expect(() =>
      CommandMetadataSchema.parse({
        ...validCommand,
        size_measures: { amount: { kind: "field", path: "/amount_cents" } },
      }),
    ).toThrow(ZodError);
  });

  it("rejects escalation above the matching hard limit", () => {
    expect(() =>
      CommandMetadataSchema.parse({
        ...validCommand,
        risk_escalation: { max_batch: 101 },
      }),
    ).toThrow(ZodError);
  });

  it("accepts the current ADR-09 equal-line boundary", () => {
    expect(
      CommandMetadataSchema.parse({
        ...validCommand,
        risk_escalation: { max_batch: 100 },
      }).risk_escalation,
    ).toEqual({ max_batch: 100 });
  });
});

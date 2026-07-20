import { describe, expect, it } from "vitest";
import { ZodError } from "zod";

import { PII_QUERY_MAX_RESULT_ROWS, QueryMetadataSchema } from "../src/registry/schemas.js";

const validQuery = {
  kind: "query",
  name: "orders.get",
  version: "1.0.0",
  description: "Read an order",
  description_llm: "Read one order after tenant authorization.",
  risk: "R1",
  invariants: [],
  idempotent: true,
  sideEffects: [],
  offline_mode: "denied",
  data_classification: "internal",
  input_redaction: [],
  result_redaction: [],
  max_result_rows: 1,
} as const;

describe("query fail-closed metadata", () => {
  it("accepts a bounded side-effect-free query", () => {
    expect(QueryMetadataSchema.parse(validQuery)).toEqual(validQuery);
  });

  it.each(["R3", "R4", "R5"])("rejects query risk %s", (risk) => {
    expect(() => QueryMetadataSchema.parse({ ...validQuery, risk })).toThrow(ZodError);
  });

  it.each([
    { idempotent: false },
    { invariants: ["orders.exists"] },
    { sideEffects: ["orders.read"] },
    { offline_mode: "grant" },
    { data_classification: "secret" },
  ])("rejects unsafe query combination %#", (change) => {
    expect(() => QueryMetadataSchema.parse({ ...validQuery, ...change })).toThrow(ZodError);
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects unsafe max_result_rows %s",
    (max_result_rows) => {
      expect(() => QueryMetadataSchema.parse({ ...validQuery, max_result_rows })).toThrow(ZodError);
    },
  );

  it("rejects unknown command-only limit fields", () => {
    expect(() =>
      QueryMetadataSchema.parse({ ...validQuery, hard_limits: { max_batch: 10 } }),
    ).toThrow(ZodError);
  });

  it.each(Object.keys(validQuery))("rejects missing required field %s", (field) => {
    const candidate: Record<string, unknown> = { ...validQuery };
    delete candidate[field];

    expect(() => QueryMetadataSchema.parse(candidate)).toThrow(ZodError);
  });

  it.each([
    ["kind", "command"],
    ["name", "Orders"],
    ["version", "1"],
    ["description", ""],
    ["description_llm", ""],
    ["risk", "R3"],
    ["invariants", ["orders.exists"]],
    ["idempotent", false],
    ["sideEffects", ["orders.read"]],
    ["offline_mode", "grant"],
    ["data_classification", "secret"],
    ["input_redaction", [{ path: "bad", strategy: "remove" }]],
    ["result_redaction", [{ path: "/phone", strategy: "erase" }]],
    ["max_result_rows", 0],
  ] as const)("rejects invalid %s", (field, value) => {
    expect(() => QueryMetadataSchema.parse({ ...validQuery, [field]: value })).toThrow(ZodError);
  });
});

describe("PII query constraints", () => {
  const piiQuery = {
    ...validQuery,
    risk: "R2",
    data_classification: "pii",
    result_redaction: [{ path: "/customer/phone", strategy: "mask" }],
  } as const;

  it("accepts R2 PII with result redaction", () => {
    expect(QueryMetadataSchema.parse(piiQuery).data_classification).toBe("pii");
  });

  it("caps PII result rows while leaving non-PII queries generally bounded", () => {
    expect(
      QueryMetadataSchema.parse({ ...piiQuery, max_result_rows: PII_QUERY_MAX_RESULT_ROWS })
        .max_result_rows,
    ).toBe(PII_QUERY_MAX_RESULT_ROWS);
    expect(() =>
      QueryMetadataSchema.parse({
        ...piiQuery,
        max_result_rows: PII_QUERY_MAX_RESULT_ROWS + 1,
      }),
    ).toThrow(ZodError);
    expect(
      QueryMetadataSchema.parse({
        ...validQuery,
        max_result_rows: PII_QUERY_MAX_RESULT_ROWS + 1,
      }).max_result_rows,
    ).toBe(PII_QUERY_MAX_RESULT_ROWS + 1);
  });

  it.each([{ risk: "R1" }, { result_redaction: [] }])(
    "rejects unsafe PII query combination %#",
    (change) => {
      expect(() => QueryMetadataSchema.parse({ ...piiQuery, ...change })).toThrow(ZodError);
    },
  );
});

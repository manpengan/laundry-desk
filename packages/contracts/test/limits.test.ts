import { describe, expect, it } from "vitest";
import { ZodError } from "zod";

import {
  LimitConfigurationSchema,
  SizeMeasuresSchema,
  ThresholdsSchema,
  type LimitGroups,
  validateStricterLimitOverride,
  validateStricterQueryResultLimitOverride,
} from "../src/registry/limits.js";

const assertDeepReadonlyLimitGroups = (limits: LimitGroups): void => {
  if (limits.hard_limits !== undefined) {
    // @ts-expect-error Public factory/override values are deeply immutable.
    limits.hard_limits.max_batch = 1;
  }
  if (limits.risk_escalation !== undefined) {
    // @ts-expect-error Validated risk escalation values are deeply immutable.
    limits.risk_escalation.max_amount_cents = 1;
  }
};

void assertDeepReadonlyLimitGroups;

const completeLimits = {
  size_measures: {
    batch: { kind: "numeric_sum", path: "/lines", field: "qty" },
    amount: { kind: "numeric_sum", path: "/lines", field: "amount_cents" },
  },
  hard_limits: { max_batch: 100, max_amount_cents: 50_000 },
  risk_escalation: { max_batch: 20, max_amount_cents: 10_000 },
} as const;

describe("ADR-09 size measures", () => {
  it("accepts both batch and amount measure variants", () => {
    expect(
      SizeMeasuresSchema.parse({
        batch: { kind: "array_length", path: "/garments" },
        amount: { kind: "field", path: "/amount_cents" },
      }),
    ).toEqual({
      batch: { kind: "array_length", path: "/garments" },
      amount: { kind: "field", path: "/amount_cents" },
    });
  });

  it("rejects an empty size measure group", () => {
    expect(() => SizeMeasuresSchema.parse({})).toThrow(ZodError);
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])("rejects unsafe threshold %s", (threshold) => {
    expect(() => ThresholdsSchema.parse({ max_batch: threshold })).toThrow(ZodError);
  });

  it("rejects an empty threshold group", () => {
    expect(() => ThresholdsSchema.parse({})).toThrow(ZodError);
  });
});

describe("ADR-09 limit well-formedness", () => {
  it.each([{ hard_limits: { max_batch: 10 } }, { risk_escalation: { max_batch: 5 } }])(
    "requires a batch measure for batch threshold %#",
    (limits) => {
      expect(() => LimitConfigurationSchema.parse(limits)).toThrow(ZodError);
    },
  );

  it.each([
    { hard_limits: { max_amount_cents: 10_000 } },
    { risk_escalation: { max_amount_cents: 5_000 } },
  ])("requires an amount measure for amount threshold %#", (limits) => {
    expect(() => LimitConfigurationSchema.parse(limits)).toThrow(ZodError);
  });

  it.each([
    ["max_batch", 21, 20],
    ["max_amount_cents", 10_001, 10_000],
  ] as const)("rejects %s escalation above the hard limit", (dimension, escalation, hardLimit) => {
    expect(() =>
      LimitConfigurationSchema.parse({
        ...completeLimits,
        hard_limits: { [dimension]: hardLimit },
        risk_escalation: { [dimension]: escalation },
      }),
    ).toThrow(ZodError);
  });

  it("accepts escalation equal to the hard limit under current ADR-09", () => {
    expect(
      LimitConfigurationSchema.parse({
        size_measures: { batch: { kind: "array_length", path: "/garments" } },
        hard_limits: { max_batch: 20 },
        risk_escalation: { max_batch: 20 },
      }),
    ).toBeDefined();
  });

  it("accepts a complete two-dimensional limit configuration", () => {
    expect(LimitConfigurationSchema.parse(completeLimits)).toEqual(completeLimits);
  });
});

describe("stricter per-org overrides", () => {
  const factory = {
    hard_limits: { max_batch: 100, max_amount_cents: 50_000 },
    risk_escalation: { max_batch: 20, max_amount_cents: 10_000 },
  } as const;

  it("merges stricter values without mutating factory values", () => {
    const merged = validateStricterLimitOverride(factory, {
      hard_limits: { max_batch: 80 },
      risk_escalation: { max_amount_cents: 8_000 },
    });

    expect(merged).toEqual({
      hard_limits: { max_batch: 80, max_amount_cents: 50_000 },
      risk_escalation: { max_batch: 20, max_amount_cents: 8_000 },
    });
    expect(factory.hard_limits.max_batch).toBe(100);
    expect(Object.isFrozen(merged)).toBe(true);
    expect(Object.isFrozen(merged.hard_limits)).toBe(true);
    expect(Object.isFrozen(merged.risk_escalation)).toBe(true);
  });

  it("accepts an override equal to its factory line", () => {
    expect(
      validateStricterLimitOverride(factory, {
        risk_escalation: { max_batch: 20 },
      }),
    ).toEqual(factory);
  });

  it.each([
    { hard_limits: { max_batch: 101 } },
    { risk_escalation: { max_amount_cents: 10_001 } },
    { hard_limits: { unexpected: 1 } },
  ])("rejects a wider or malformed override %#", (override) => {
    expect(() => validateStricterLimitOverride(factory, override)).toThrow(ZodError);
  });

  it("rejects a dimension absent from the matching factory group", () => {
    expect(() =>
      validateStricterLimitOverride(
        { hard_limits: { max_batch: 100 } },
        { hard_limits: { max_amount_cents: 1_000 } },
      ),
    ).toThrow(ZodError);
  });

  it("revalidates escalation ordering after a hard limit is tightened", () => {
    expect(() =>
      validateStricterLimitOverride(factory, {
        hard_limits: { max_batch: 10 },
      }),
    ).toThrow(ZodError);
  });

  it.each(["hard_limits", "risk_escalation"] as const)(
    "rejects explicit undefined that would delete a factory %s line",
    (group) => {
      expect(() =>
        validateStricterLimitOverride(factory, {
          [group]: { max_batch: undefined },
        } as never),
      ).toThrow(ZodError);
    },
  );
});

describe("stricter per-org query result limits", () => {
  it("returns the effective max_result_rows without widening the factory limit", () => {
    expect(validateStricterQueryResultLimitOverride(100, { max_result_rows: 25 })).toEqual({
      max_result_rows: 25,
    });
    expect(validateStricterQueryResultLimitOverride(100, { max_result_rows: 100 })).toEqual({
      max_result_rows: 100,
    });
    expect(validateStricterQueryResultLimitOverride(100, {})).toEqual({ max_result_rows: 100 });
  });

  it.each([
    { max_result_rows: 101 },
    { max_result_rows: 0 },
    { max_result_rows: undefined },
    { unexpected: 1 },
  ])("rejects a wider or malformed query result override %#", (override) => {
    expect(() => validateStricterQueryResultLimitOverride(100, override as never)).toThrow(
      ZodError,
    );
  });
});

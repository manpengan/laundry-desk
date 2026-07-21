import { describe, expect, it } from "vitest";

import {
  measureInput,
  parseJsonPointer,
  resolvePointer,
  type SizeMeasures,
} from "../measure-input.js";

describe("parseJsonPointer", () => {
  it("accepts non-root safe pointers and decodes ~0 / ~1", () => {
    expect(parseJsonPointer("/garments")).toEqual(["garments"]);
    expect(parseJsonPointer("/a~1b/c~0d")).toEqual(["a/b", "c~d"]);
    expect(parseJsonPointer("/0/amount_cents")).toEqual(["0", "amount_cents"]);
  });

  it.each(["", "/", "//x", "garments", "/__proto__/x", "/prototype", "/constructor/x", "/a~~b"])(
    "rejects illegal or unsafe pointer %s",
    (path) => {
      expect(parseJsonPointer(path)).toBeUndefined();
    },
  );
});

describe("resolvePointer own-property walk", () => {
  it("reads only own properties and array indexes", () => {
    const input = { lines: [{ qty: 2 }, { qty: 3 }], nested: { amount_cents: 500 } };
    expect(resolvePointer(input, "/lines/0/qty")).toEqual({ ok: true, value: 2 });
    expect(resolvePointer(input, "/nested/amount_cents")).toEqual({ ok: true, value: 500 });
  });

  it("does not follow prototype chain values", () => {
    const proto = { leaked: 1 };
    const input = Object.create(proto) as Record<string, unknown>;
    input.own = 2;
    expect(resolvePointer(input, "/own")).toEqual({ ok: true, value: 2 });
    const leaked = resolvePointer(input, "/leaked");
    expect(leaked.ok).toBe(false);
    if (!leaked.ok) expect(leaked.code).toBe("path_not_found");
  });

  it("fails closed on missing segments and non-decimal array indexes", () => {
    expect(resolvePointer({ items: [1] }, "/items/1").ok).toBe(false);
    expect(resolvePointer({ items: [1] }, "/items/01").ok).toBe(false);
    expect(resolvePointer({ items: [1] }, "/items/-").ok).toBe(false);
    expect(resolvePointer({ items: [1] }, "/missing").ok).toBe(false);
  });
});

describe("measureInput array_length", () => {
  const measures: SizeMeasures = {
    batch: { kind: "array_length", path: "/garments" },
  };

  it("returns array length as batch", () => {
    const result = measureInput({ garments: ["a", "b", "c"] }, measures);
    expect(result).toEqual({ ok: true, measures: { batch: 3 } });
  });

  it("returns zero for empty arrays", () => {
    expect(measureInput({ garments: [] }, measures)).toEqual({
      ok: true,
      measures: { batch: 0 },
    });
  });

  it("fails when path is not an array", () => {
    const result = measureInput({ garments: { length: 9 } }, measures);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("type_mismatch");
  });
});

describe("measureInput numeric_sum", () => {
  it("sums integer batch quantities", () => {
    const result = measureInput(
      { lines: [{ qty: 2 }, { qty: 5 }, { qty: 1 }] },
      { batch: { kind: "numeric_sum", path: "/lines", field: "qty" } },
    );
    expect(result).toEqual({ ok: true, measures: { batch: 8 } });
  });

  it("sums amount_cents without floating point", () => {
    const result = measureInput(
      {
        lines: [{ amount_cents: 1999 }, { amount_cents: 1 }, { amount_cents: 10_000 }],
      },
      { amount: { kind: "numeric_sum", path: "/lines", field: "amount_cents" } },
    );
    expect(result).toEqual({ ok: true, measures: { amount_cents: 12_000 } });
  });

  it("fails closed on float field values", () => {
    const result = measureInput(
      { lines: [{ amount_cents: 10.5 }] },
      { amount: { kind: "numeric_sum", path: "/lines", field: "amount_cents" } },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("non_integer");
  });

  it("fails closed on sum overflow past MAX_SAFE_INTEGER", () => {
    const result = measureInput(
      {
        lines: [
          { amount_cents: Number.MAX_SAFE_INTEGER },
          { amount_cents: 1 },
        ],
      },
      { amount: { kind: "numeric_sum", path: "/lines", field: "amount_cents" } },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("overflow");
  });

  it("rejects unsafe or prototype field names", () => {
    const result = measureInput(
      { lines: [{ __proto__: 1 }] },
      { batch: { kind: "numeric_sum", path: "/lines", field: "__proto__" } },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("illegal_field");
  });

  it("fails when an element lacks the field", () => {
    const result = measureInput(
      { lines: [{ qty: 1 }, {}] },
      { batch: { kind: "numeric_sum", path: "/lines", field: "qty" } },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("path_not_found");
  });
});

describe("measureInput field amount", () => {
  const measures: SizeMeasures = {
    amount: { kind: "field", path: "/amount_cents" },
  };

  it("reads a single integer cents field", () => {
    expect(measureInput({ amount_cents: 10_000 }, measures)).toEqual({
      ok: true,
      measures: { amount_cents: 10_000 },
    });
  });

  it("accepts zero and negative safe integers (refunds/adjustments)", () => {
    expect(measureInput({ amount_cents: 0 }, measures)).toEqual({
      ok: true,
      measures: { amount_cents: 0 },
    });
    expect(measureInput({ amount_cents: -500 }, measures)).toEqual({
      ok: true,
      measures: { amount_cents: -500 },
    });
  });

  it.each([29.99, Number.NaN, Number.POSITIVE_INFINITY, "100", null])(
    "fails closed on non-integer amount %s",
    (value) => {
      const result = measureInput({ amount_cents: value }, measures);
      expect(result.ok).toBe(false);
    },
  );

  it("fails closed when cents exceed MAX_SAFE_INTEGER", () => {
    const result = measureInput({ amount_cents: Number.MAX_SAFE_INTEGER + 1 }, measures);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(["non_integer", "overflow", "type_mismatch"]).toContain(result.code);
  });
});

describe("measureInput combined measures", () => {
  const measures: SizeMeasures = {
    batch: { kind: "array_length", path: "/recipients" },
    amount: { kind: "field", path: "/total_cents" },
  };

  it("returns both batch and amount_cents", () => {
    expect(
      measureInput({ recipients: [1, 2, 3, 4], total_cents: 2500 }, measures),
    ).toEqual({ ok: true, measures: { batch: 4, amount_cents: 2500 } });
  });

  it("fails closed on empty measure declarations", () => {
    const result = measureInput({}, {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("empty_measures");
  });

  it("fails closed on illegal pointer before any arithmetic", () => {
    const result = measureInput(
      { garments: [] },
      { batch: { kind: "array_length", path: "/__proto__" } },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("illegal_path");
  });
});

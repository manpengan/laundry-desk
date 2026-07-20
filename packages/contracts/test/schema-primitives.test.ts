import { describe, expect, it } from "vitest";
import { ZodError } from "zod";

import {
  JsonPointerSchema,
  RedactionRulesSchema,
  SafePropertyKeySchema,
  SemVerSchema,
  StableBindingIdSchema,
} from "../src/registry/primitives.js";

describe("primitive contract schemas", () => {
  it.each(["0.0.0", "1.2.3", "1.0.0-rc.1+build.7"])("accepts SemVer %s", (version) => {
    expect(SemVerSchema.parse(version)).toBe(version);
  });

  it.each(["1", "01.0.0", "1.0.0-01", "1.0.0+build..1"])(
    "rejects non-canonical SemVer %s",
    (version) => {
      expect(() => SemVerSchema.parse(version)).toThrow(ZodError);
    },
  );

  it.each(["orders.exists", "inventory.stock_held"])("accepts stable binding id %s", (binding) => {
    expect(StableBindingIdSchema.parse(binding)).toBe(binding);
  });

  it.each(["Orders.exists", "orders..exists", "orders-exists"])(
    "rejects unsafe binding id %s",
    (binding) => {
      expect(() => StableBindingIdSchema.parse(binding)).toThrow(ZodError);
    },
  );
});

describe("safe RFC 6901 paths", () => {
  it.each(["/customer/phone", "/customer/~0tag", "/customer/a~1b"])(
    "accepts a non-root pointer %s",
    (path) => {
      expect(JsonPointerSchema.parse(path)).toBe(path);
    },
  );

  it.each([
    "",
    "/",
    "//",
    "customer/phone",
    "/customer/~phone",
    "/__proto__/token",
    "/customer/prototype",
    "/customer/constructor/value",
  ])("rejects unsafe pointer %#", (path) => {
    expect(() => JsonPointerSchema.parse(path)).toThrow(ZodError);
  });

  it("rejects duplicate redaction paths", () => {
    expect(() =>
      RedactionRulesSchema.parse([
        { path: "/customer/phone", strategy: "mask" },
        { path: "/customer/phone", strategy: "remove" },
      ]),
    ).toThrow(ZodError);
  });

  it.each([
    ["/customer", "/customer/phone"],
    ["/items/0", "/items/0/secret"],
  ])("rejects ancestor overlap between %s and %s", (ancestor, descendant) => {
    expect(() =>
      RedactionRulesSchema.parse([
        { path: descendant, strategy: "remove" },
        { path: ancestor, strategy: "mask" },
      ]),
    ).toThrow(ZodError);
  });

  it("accepts independent redaction paths and all frozen strategies", () => {
    const rules = [
      { path: "/customer/phone", strategy: "mask" },
      { path: "/customer/card_no", strategy: "last4" },
      { path: "/payment/token", strategy: "remove" },
    ];

    expect(RedactionRulesSchema.parse(rules)).toEqual(rules);
  });
});

describe("safe numeric_sum field", () => {
  it.each(["qty", "amount_cents", "line_2_qty"])("accepts own-property key %s", (field) => {
    expect(SafePropertyKeySchema.parse(field)).toBe(field);
  });

  it.each([
    "line.qty",
    "LineQty",
    "line-qty",
    "line__qty",
    "line_qty_",
    "__proto__",
    "prototype",
    "constructor",
  ])("rejects unsafe own-property key %s", (field) => {
    expect(() => SafePropertyKeySchema.parse(field)).toThrow(ZodError);
  });
});

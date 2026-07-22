import { describe, expect, it } from "vitest";

import { filterCatalog, findByCode, lookupByMnemonic } from "../lookup.js";
import { resolveLinePrice } from "../pricing.js";
import type { CatalogItem } from "../types.js";

const DEMO: readonly CatalogItem[] = Object.freeze([
  Object.freeze({
    code: "wash_shirt",
    name: "水洗衬衫",
    service_code: "wash",
    category_code: "shirt",
    unit_price_cents: 1500,
    mnemonic: "xs",
  }),
  Object.freeze({
    code: "dry_coat",
    name: "干洗大衣",
    service_code: "dry",
    category_code: "coat",
    unit_price_cents: 4500,
    mnemonic: "DY",
  }),
  Object.freeze({
    code: "iron_pants",
    name: "熨烫西裤",
    service_code: "iron",
    category_code: "pants",
    unit_price_cents: 800,
  }),
]);

describe("resolveLinePrice", () => {
  it("multiplies unit × qty in integer cents", () => {
    expect(resolveLinePrice(DEMO[0]!, 3)).toBe(4500);
    expect(resolveLinePrice({ unit_price_cents: 0 }, 5)).toBe(0);
  });

  it("rejects float unit price", () => {
    expect(() => resolveLinePrice({ unit_price_cents: 12.5 }, 1)).toThrow(TypeError);
  });

  it("rejects non-positive qty", () => {
    expect(() => resolveLinePrice(DEMO[0]!, 0)).toThrow(TypeError);
    expect(() => resolveLinePrice(DEMO[0]!, 1.5)).toThrow(TypeError);
  });

  it("rejects negative unit price", () => {
    expect(() => resolveLinePrice({ unit_price_cents: -100 }, 1)).toThrow(TypeError);
  });
});

describe("lookupByMnemonic", () => {
  it("matches case-insensitively", () => {
    expect(lookupByMnemonic(DEMO, "xs")?.code).toBe("wash_shirt");
    expect(lookupByMnemonic(DEMO, "XS")?.code).toBe("wash_shirt");
    expect(lookupByMnemonic(DEMO, "  dy  ")?.code).toBe("dry_coat");
  });

  it("returns undefined for empty or missing", () => {
    expect(lookupByMnemonic(DEMO, "")).toBeUndefined();
    expect(lookupByMnemonic(DEMO, "   ")).toBeUndefined();
    expect(lookupByMnemonic(DEMO, "nope")).toBeUndefined();
  });
});

describe("filterCatalog", () => {
  it("returns all items for empty query", () => {
    expect(filterCatalog(DEMO, "")).toHaveLength(3);
    expect(filterCatalog(DEMO, "  ")).toHaveLength(3);
  });

  it("filters by name / code / service / mnemonic", () => {
    expect(filterCatalog(DEMO, "衬衫").map((i) => i.code)).toEqual(["wash_shirt"]);
    expect(filterCatalog(DEMO, "dry").map((i) => i.code)).toEqual(["dry_coat"]);
    expect(filterCatalog(DEMO, "xs").map((i) => i.code)).toEqual(["wash_shirt"]);
    expect(filterCatalog(DEMO, "coat").map((i) => i.code)).toEqual(["dry_coat"]);
  });
});

describe("findByCode", () => {
  it("matches exact code", () => {
    expect(findByCode(DEMO, "iron_pants")?.name).toBe("熨烫西裤");
    expect(findByCode(DEMO, "")).toBeUndefined();
    expect(findByCode(DEMO, "missing")).toBeUndefined();
  });
});

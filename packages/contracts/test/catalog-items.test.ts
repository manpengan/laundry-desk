import { describe, expect, it } from "vitest";

import {
  CATALOG_SKELETON_DEFINITIONS,
  CATALOG_SKELETON_QUERY_NAMES,
  M1_FIRST_WAVE_DEFINITIONS,
  M2_CATALOG_DEFINITIONS,
  M2_CATALOG_QUERY_NAMES,
  catalogItemsGetQuery,
  catalogItemsListQuery,
  isContractDefinition,
  parseContractInput,
} from "../src/index.js";

describe("M2 catalog items skeleton queries", () => {
  it("registers definitions through A1 factories", () => {
    for (const definition of CATALOG_SKELETON_DEFINITIONS) {
      expect(isContractDefinition(definition)).toBe(true);
      expect(definition.kind).toBe("query");
      expect(definition.offline_mode).toBe("denied");
      expect(definition.data_classification).toBe("internal");
    }
  });

  it("exports stable names and M2 catalog alias", () => {
    expect([...CATALOG_SKELETON_QUERY_NAMES]).toEqual(["catalog.items.list", "catalog.items.get"]);
    expect([...M2_CATALOG_QUERY_NAMES]).toEqual([...CATALOG_SKELETON_QUERY_NAMES]);
    expect(M2_CATALOG_DEFINITIONS).toHaveLength(2);
  });

  it("keeps OpenAPI M1 first-wave free of catalog queries", () => {
    const names = M1_FIRST_WAVE_DEFINITIONS.map((d) => d.name);
    expect(names).not.toContain("catalog.items.list");
    expect(names).not.toContain("catalog.items.get");
  });

  it("parses list input with optional query", async () => {
    await expect(parseContractInput(catalogItemsListQuery, { limit: 50 })).resolves.toEqual({
      limit: 50,
    });
    await expect(
      parseContractInput(catalogItemsListQuery, { query: "衬衫", limit: 20 }),
    ).resolves.toEqual({ query: "衬衫", limit: 20 });
  });

  it("rejects list limit over max", async () => {
    await expect(parseContractInput(catalogItemsListQuery, { limit: 201 })).rejects.toBeTruthy();
  });

  it("parses get by code", async () => {
    await expect(parseContractInput(catalogItemsGetQuery, { code: "wash_shirt" })).resolves.toEqual(
      { code: "wash_shirt" },
    );
    await expect(parseContractInput(catalogItemsGetQuery, { code: "" })).rejects.toBeTruthy();
  });

  it("declares R0 and max_result_rows", () => {
    expect(catalogItemsListQuery.risk).toBe("R0");
    expect(catalogItemsListQuery.max_result_rows).toBe(200);
    expect(catalogItemsGetQuery.risk).toBe("R0");
    expect(catalogItemsGetQuery.max_result_rows).toBe(1);
  });
});

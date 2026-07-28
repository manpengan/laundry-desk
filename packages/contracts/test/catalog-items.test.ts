import { describe, expect, it } from "vitest";

import {
  CATALOG_COMMAND_NAMES,
  CATALOG_SKELETON_DEFINITIONS,
  CATALOG_SKELETON_QUERY_NAMES,
  M2_READ_ONLY_AI_DEFINITIONS,
  catalogItemUpsertCommand,
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

describe("ADR-15 catalog maintenance command", () => {
  it("exposes exactly one idempotent upsert command guarded by settings_admin", () => {
    expect([...CATALOG_COMMAND_NAMES]).toEqual(["catalog.item.upsert"]);
    expect(catalogItemUpsertCommand.kind).toBe("command");
    expect(catalogItemUpsertCommand.risk).toBe("R2");
    expect(catalogItemUpsertCommand.idempotent).toBe(true);
    expect(catalogItemUpsertCommand.offline_mode).toBe("denied");
    expect(catalogItemUpsertCommand.invariants).toContain("rbac.settings_admin");
  });

  // ADR-15 §2: the AI projection spreads CATALOG_SKELETON_DEFINITIONS and must
  // stay read-only, so the write command must never land in that set.
  it("keeps the write command out of the read-only skeleton", () => {
    for (const definition of CATALOG_SKELETON_DEFINITIONS) {
      expect(definition.kind).toBe("query");
    }
    expect(CATALOG_SKELETON_DEFINITIONS).not.toContain(catalogItemUpsertCommand);
    expect(M2_READ_ONLY_AI_DEFINITIONS).not.toContain(catalogItemUpsertCommand);
  });

  it("accepts a valid item and rejects float or negative prices", async () => {
    const valid = {
      code: "wash_shirt",
      name: "水洗衬衫",
      service_code: "wash",
      category_code: "shirt",
      unit_price_cents: 1500,
      is_active: true,
    };
    await expect(parseContractInput(catalogItemUpsertCommand, valid)).resolves.toMatchObject({
      code: "wash_shirt",
    });
    for (const badPrice of [15.5, -1]) {
      await expect(
        parseContractInput(catalogItemUpsertCommand, { ...valid, unit_price_cents: badPrice }),
      ).rejects.toThrow();
    }
    await expect(
      parseContractInput(catalogItemUpsertCommand, { ...valid, code: "bad code!" }),
    ).rejects.toThrow();
  });
});

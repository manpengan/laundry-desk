import { describe, expect, it } from "vitest";

import {
  M1_FIRST_WAVE_DEFINITIONS,
  M2_ORDER_QUERY_DEFINITIONS,
  M2_ORDER_QUERY_NAMES,
  ORDER_QUERY_NAMES,
  ORDER_QUERIES,
  isContractDefinition,
  orderGetQuery,
  parseContractInput,
} from "../src/index.js";

describe("M2 order.get query", () => {
  it("registers definition through A1 factory", () => {
    for (const definition of ORDER_QUERIES) {
      expect(isContractDefinition(definition)).toBe(true);
      expect(definition.kind).toBe("query");
      expect(definition.offline_mode).toBe("denied");
      expect(definition.data_classification).toBe("pii");
    }
  });

  it("exports stable names and M2 order query alias", () => {
    expect([...ORDER_QUERY_NAMES]).toEqual(["order.get", "order.list"]);
    expect([...M2_ORDER_QUERY_NAMES]).toEqual([...ORDER_QUERY_NAMES]);
    expect(M2_ORDER_QUERY_DEFINITIONS).toHaveLength(2);
    expect(ORDER_QUERIES.map((q) => q.name)).toContain("order.get");
  });

  it("keeps OpenAPI M1 first-wave free of order.get", () => {
    const names = M1_FIRST_WAVE_DEFINITIONS.map((d) => d.name);
    expect(names).not.toContain("order.get");
  });

  it("parses get by order_id uuid", async () => {
    const orderId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    await expect(parseContractInput(orderGetQuery, { order_id: orderId })).resolves.toEqual({
      order_id: orderId,
    });
  });

  it("rejects missing or invalid order_id", async () => {
    await expect(parseContractInput(orderGetQuery, {})).rejects.toBeTruthy();
    await expect(
      parseContractInput(orderGetQuery, { order_id: "not-a-uuid" }),
    ).rejects.toBeTruthy();
  });

  it("declares R2 (pii floor), offline denied, pii, max_result_rows 1", () => {
    expect(orderGetQuery.name).toBe("order.get");
    // Schema: PII queries must be R2 (not R1).
    expect(orderGetQuery.risk).toBe("R2");
    expect(orderGetQuery.offline_mode).toBe("denied");
    expect(orderGetQuery.data_classification).toBe("pii");
    expect(orderGetQuery.max_result_rows).toBe(1);
  });
});

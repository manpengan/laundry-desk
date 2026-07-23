import { describe, expect, it } from "vitest";

import {
  M1_FIRST_WAVE_DEFINITIONS,
  M2_ORDER_QUERY_DEFINITIONS,
  M2_ORDER_QUERY_NAMES,
  ORDER_QUERY_NAMES,
  ORDER_QUERIES,
  isContractDefinition,
  orderListQuery,
  parseContractInput,
} from "../src/index.js";

describe("M2 order.list query", () => {
  it("registers definition through A1 factory", () => {
    for (const definition of ORDER_QUERIES) {
      expect(isContractDefinition(definition)).toBe(true);
      expect(definition.kind).toBe("query");
    }
    expect(orderListQuery.offline_mode).toBe("denied");
    expect(orderListQuery.data_classification).toBe("pii");
  });

  it("exports stable names and M2 order query alias", () => {
    expect([...ORDER_QUERY_NAMES]).toEqual(["order.get", "order.list"]);
    expect([...M2_ORDER_QUERY_NAMES]).toEqual([...ORDER_QUERY_NAMES]);
    expect(M2_ORDER_QUERY_DEFINITIONS).toHaveLength(2);
  });

  it("keeps OpenAPI M1 first-wave free of order.list", () => {
    const names = M1_FIRST_WAVE_DEFINITIONS.map((d) => d.name);
    expect(names).not.toContain("order.list");
    expect(names).not.toContain("order.get");
  });

  it("parses empty input with defaults applied by handler", async () => {
    await expect(parseContractInput(orderListQuery, {})).resolves.toEqual({});
  });

  it("parses optional business_date, status, customer_phone, min_balance_cents, limit", async () => {
    await expect(
      parseContractInput(orderListQuery, {
        business_date: "2026-07-22",
        status: "open",
        customer_phone: "13800000111",
        min_balance_cents: 1,
        limit: 10,
      }),
    ).resolves.toEqual({
      business_date: "2026-07-22",
      status: "open",
      customer_phone: "13800000111",
      min_balance_cents: 1,
      limit: 10,
    });
  });

  it("parses customer_phone filter alone (customer detail history)", async () => {
    await expect(
      parseContractInput(orderListQuery, { customer_phone: "13800000222", limit: 20 }),
    ).resolves.toEqual({ customer_phone: "13800000222", limit: 20 });
  });

  it("parses min_balance_cents for debt / receivables list", async () => {
    await expect(
      parseContractInput(orderListQuery, { min_balance_cents: 1, limit: 50 }),
    ).resolves.toEqual({ min_balance_cents: 1, limit: 50 });
    await expect(parseContractInput(orderListQuery, { min_balance_cents: 0 })).resolves.toEqual({
      min_balance_cents: 0,
    });
  });

  it("rejects invalid business_date / status / phone / min_balance / limit", async () => {
    await expect(
      parseContractInput(orderListQuery, { business_date: "20260722" }),
    ).rejects.toBeTruthy();
    await expect(parseContractInput(orderListQuery, { status: "pending" })).rejects.toBeTruthy();
    await expect(
      parseContractInput(orderListQuery, { customer_phone: "12345" }),
    ).rejects.toBeTruthy();
    await expect(
      parseContractInput(orderListQuery, { customer_phone: "23800000111" }),
    ).rejects.toBeTruthy();
    await expect(
      parseContractInput(orderListQuery, { min_balance_cents: -1 }),
    ).rejects.toBeTruthy();
    await expect(
      parseContractInput(orderListQuery, { min_balance_cents: 1.5 }),
    ).rejects.toBeTruthy();
    await expect(parseContractInput(orderListQuery, { limit: 0 })).rejects.toBeTruthy();
    await expect(parseContractInput(orderListQuery, { limit: 51 })).rejects.toBeTruthy();
  });

  it("declares R2 (pii floor), offline denied, max_result_rows 50, phone redaction", () => {
    expect(orderListQuery.name).toBe("order.list");
    expect(orderListQuery.risk).toBe("R2");
    expect(orderListQuery.offline_mode).toBe("denied");
    expect(orderListQuery.data_classification).toBe("pii");
    expect(orderListQuery.max_result_rows).toBe(50);
    expect(orderListQuery.input_redaction).toEqual([{ path: "/customer_phone", strategy: "mask" }]);
    expect(orderListQuery.result_redaction).toEqual([
      { path: "/orders/*/customer_phone", strategy: "mask" },
    ]);
  });
});

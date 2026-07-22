import { describe, expect, it } from "vitest";

import {
  M1_FIRST_WAVE_DEFINITIONS,
  M2_STATS_QUERY_DEFINITIONS,
  M2_STATS_QUERY_NAMES,
  STATS_QUERY_NAMES,
  STATS_QUERIES,
  isContractDefinition,
  parseContractInput,
  statsDaySummaryQuery,
} from "../src/index.js";

describe("M2 stats.day.summary skeleton", () => {
  it("registers definition through A1 factory", () => {
    for (const definition of STATS_QUERIES) {
      expect(isContractDefinition(definition)).toBe(true);
      expect(definition.kind).toBe("query");
      expect(definition.risk).toBe("R1");
      expect(definition.offline_mode).toBe("denied");
      expect(definition.data_classification).toBe("internal");
      expect(definition.max_result_rows).toBe(1);
    }
  });

  it("exports stable names and M2 stats aliases", () => {
    expect([...STATS_QUERY_NAMES]).toEqual(["stats.day.summary"]);
    expect([...M2_STATS_QUERY_NAMES]).toEqual([...STATS_QUERY_NAMES]);
    expect(M2_STATS_QUERY_DEFINITIONS).toHaveLength(1);
    expect(M2_STATS_QUERY_DEFINITIONS[0]?.name).toBe("stats.day.summary");
  });

  it("keeps OpenAPI M1 first-wave free of stats contracts", () => {
    const names = M1_FIRST_WAVE_DEFINITIONS.map((d) => d.name);
    expect(names).not.toContain("stats.day.summary");
  });

  it("parses business_date YYYY-MM-DD", async () => {
    await expect(
      parseContractInput(statsDaySummaryQuery, { business_date: "2026-07-22" }),
    ).resolves.toEqual({ business_date: "2026-07-22" });
  });

  it("rejects invalid business_date", async () => {
    await expect(parseContractInput(statsDaySummaryQuery, {})).rejects.toBeTruthy();
    await expect(
      parseContractInput(statsDaySummaryQuery, { business_date: "20260722" }),
    ).rejects.toBeTruthy();
    await expect(
      parseContractInput(statsDaySummaryQuery, { business_date: "26-07-22" }),
    ).rejects.toBeTruthy();
    await expect(
      parseContractInput(statsDaySummaryQuery, { business_date: "2026/07/22" }),
    ).rejects.toBeTruthy();
  });

  it("declares metadata floors", () => {
    expect(statsDaySummaryQuery.name).toBe("stats.day.summary");
    expect(statsDaySummaryQuery.risk).toBe("R1");
    expect(statsDaySummaryQuery.offline_mode).toBe("denied");
    expect(statsDaySummaryQuery.data_classification).toBe("internal");
    expect(statsDaySummaryQuery.max_result_rows).toBe(1);
    expect(statsDaySummaryQuery.idempotent).toBe(true);
  });

  it("documents result shape fields for day summary", () => {
    // Result is produced by server/domain; contracts document the field set for clients.
    const documented = Object.freeze({
      business_date: "2026-07-22",
      order_count: 0,
      garment_count: 0,
      payable_cents: 0,
      paid_cents: 0,
      balance_cents: 0,
      payment_cents: 0,
      picked_garment_count: 0,
    });
    expect(Object.keys(documented).sort()).toEqual(
      [
        "balance_cents",
        "business_date",
        "garment_count",
        "order_count",
        "paid_cents",
        "payable_cents",
        "payment_cents",
        "picked_garment_count",
      ].sort(),
    );
  });
});

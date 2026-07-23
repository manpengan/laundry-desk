import { describe, expect, it } from "vitest";

import {
  CUSTOMER_COMMAND_NAMES,
  CUSTOMER_COMMANDS,
  CUSTOMER_QUERY_NAMES,
  CUSTOMER_QUERIES,
  M1_FIRST_WAVE_DEFINITIONS,
  M2_CUSTOMER_COMMAND_DEFINITIONS,
  M2_CUSTOMER_COMMAND_NAMES,
  M2_CUSTOMER_QUERY_DEFINITIONS,
  M2_CUSTOMER_QUERY_NAMES,
  M2_SKELETON_COMMAND_NAMES,
  M2_SKELETON_DEFINITIONS,
  customerSearchQuery,
  customerUpsertCommand,
  isContractDefinition,
  parseContractInput,
} from "../src/index.js";

describe("M2 customer archive skeleton", () => {
  it("registers definitions through A1 factory", () => {
    for (const definition of CUSTOMER_QUERIES) {
      expect(isContractDefinition(definition)).toBe(true);
      expect(definition.kind).toBe("query");
      expect(definition.risk).toBe("R2");
      expect(definition.offline_mode).toBe("denied");
      expect(definition.data_classification).toBe("pii");
      expect(definition.max_result_rows).toBe(50);
      expect(definition.result_redaction.length).toBeGreaterThan(0);
    }
    for (const definition of CUSTOMER_COMMANDS) {
      expect(isContractDefinition(definition)).toBe(true);
      expect(definition.kind).toBe("command");
      expect(definition.risk).toBe("R2");
      expect(definition.offline_mode).toBe("grant");
      expect(definition.data_classification).toBe("pii");
      expect(definition.idempotent).toBe(true);
    }
  });

  it("exports stable names and M2 customer aliases", () => {
    expect([...CUSTOMER_QUERY_NAMES]).toEqual(["customer.search"]);
    expect([...CUSTOMER_COMMAND_NAMES]).toEqual(["customer.upsert"]);
    expect([...M2_CUSTOMER_QUERY_NAMES]).toEqual([...CUSTOMER_QUERY_NAMES]);
    expect([...M2_CUSTOMER_COMMAND_NAMES]).toEqual([...CUSTOMER_COMMAND_NAMES]);
    expect(M2_CUSTOMER_QUERY_DEFINITIONS).toHaveLength(1);
    expect(M2_CUSTOMER_COMMAND_DEFINITIONS).toHaveLength(1);
    expect(M2_CUSTOMER_QUERY_DEFINITIONS[0]?.name).toBe("customer.search");
    expect(M2_CUSTOMER_COMMAND_DEFINITIONS[0]?.name).toBe("customer.upsert");
  });

  it("wires customer.upsert into M2 skeleton command catalog", () => {
    const names = M2_SKELETON_DEFINITIONS.map((d) => d.name);
    expect(names).toContain("customer.upsert");
    expect([...M2_SKELETON_COMMAND_NAMES]).toContain("customer.upsert");
  });

  it("keeps OpenAPI M1 first-wave free of customer contracts", () => {
    const names = M1_FIRST_WAVE_DEFINITIONS.map((d) => d.name);
    expect(names).not.toContain("customer.search");
    expect(names).not.toContain("customer.upsert");
  });

  it("parses search input with optional query and limit", async () => {
    await expect(parseContractInput(customerSearchQuery, {})).resolves.toEqual({});
    await expect(
      parseContractInput(customerSearchQuery, { query: "138", limit: 10 }),
    ).resolves.toEqual({ query: "138", limit: 10 });
  });

  it("rejects search limit above 50", async () => {
    await expect(parseContractInput(customerSearchQuery, { limit: 51 })).rejects.toBeTruthy();
  });

  it("parses upsert phone and optional name/note", async () => {
    await expect(
      parseContractInput(customerUpsertCommand, { phone: "13800000111" }),
    ).resolves.toEqual({ phone: "13800000111" });
    await expect(
      parseContractInput(customerUpsertCommand, {
        phone: "13800000111",
        name: "张三",
        note: "常客",
      }),
    ).resolves.toEqual({ phone: "13800000111", name: "张三", note: "常客" });
  });

  it("rejects invalid phone", async () => {
    await expect(
      parseContractInput(customerUpsertCommand, { phone: "12345" }),
    ).rejects.toBeTruthy();
    await expect(
      parseContractInput(customerUpsertCommand, { phone: "23800000111" }),
    ).rejects.toBeTruthy();
  });

  it("declares metadata floors for search and upsert", () => {
    expect(customerSearchQuery.name).toBe("customer.search");
    expect(customerSearchQuery.risk).toBe("R2");
    expect(customerSearchQuery.offline_mode).toBe("denied");
    expect(customerSearchQuery.data_classification).toBe("pii");
    expect(customerSearchQuery.max_result_rows).toBe(50);
    expect(customerSearchQuery.result_redaction).toEqual([
      { path: "/customers", strategy: "mask" },
    ]);

    expect(customerUpsertCommand.name).toBe("customer.upsert");
    expect(customerUpsertCommand.risk).toBe("R2");
    expect(customerUpsertCommand.offline_mode).toBe("grant");
    expect(customerUpsertCommand.invariants).toContain("rbac.order_write");
    expect(customerUpsertCommand.input_redaction).toEqual([{ path: "/phone", strategy: "mask" }]);
  });
});

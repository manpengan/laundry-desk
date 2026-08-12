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
  customerDuplicatesQuery,
  customerGetQuery,
  customerAnonymizeCommand,
  customerMergeCommand,
  customerPrivacyEventsQuery,
  customerPrivacyExportCommand,
  customerPrivacyStatusQuery,
  customerSearchQuery,
  customerUpsertCommand,
  customerUpdateCommand,
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
      expect(definition.max_result_rows).toBeGreaterThan(0);
    }
    for (const definition of CUSTOMER_COMMANDS) {
      expect(isContractDefinition(definition)).toBe(true);
      expect(definition.kind).toBe("command");
      expect(["R2", "R3", "R4", "R5"]).toContain(definition.risk);
      expect(definition.data_classification).toBe("pii");
    }
  });

  it("exports stable names and M2 customer aliases", () => {
    expect([...CUSTOMER_QUERY_NAMES]).toEqual([
      "customer.search",
      "customer.get",
      "customer.duplicates",
      "customer.privacy.status",
      "customer.privacy.events",
    ]);
    expect([...CUSTOMER_COMMAND_NAMES]).toEqual([
      "customer.upsert",
      "customer.update",
      "customer.merge",
      "customer.privacy.export",
      "customer.anonymize",
    ]);
    expect([...M2_CUSTOMER_QUERY_NAMES]).toEqual([...CUSTOMER_QUERY_NAMES]);
    expect([...M2_CUSTOMER_COMMAND_NAMES]).toEqual([...CUSTOMER_COMMAND_NAMES]);
    expect(M2_CUSTOMER_QUERY_DEFINITIONS).toHaveLength(5);
    expect(M2_CUSTOMER_COMMAND_DEFINITIONS).toHaveLength(5);
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
      { path: "/customers/*/phone_masked", strategy: "mask" },
    ]);

    expect(customerUpsertCommand.name).toBe("customer.upsert");
    expect(customerUpsertCommand.risk).toBe("R2");
    expect(customerUpsertCommand.offline_mode).toBe("grant");
    expect(customerUpsertCommand.invariants).toContain("rbac.customer_write");
    expect(customerUpsertCommand.input_redaction).toEqual([{ path: "/phone", strategy: "mask" }]);
    expect(customerGetQuery.max_result_rows).toBe(1);
    expect(customerDuplicatesQuery.max_result_rows).toBe(20);
    expect(customerUpdateCommand.risk).toBe("R3");
    expect(customerUpdateCommand.invariants).toEqual(["rbac.customer_write", "customer.version"]);
    expect(customerMergeCommand.risk).toBe("R4");
    expect(customerMergeCommand.offline_mode).toBe("denied");
    expect(customerPrivacyStatusQuery.data_classification).toBe("internal");
    expect(customerPrivacyStatusQuery.max_result_rows).toBe(1);
    expect(customerPrivacyStatusQuery.invariants).toEqual(["rbac.privacy_admin"]);
    expect(customerPrivacyEventsQuery.data_classification).toBe("internal");
    expect(customerPrivacyEventsQuery.max_result_rows).toBe(50);
    expect(customerPrivacyExportCommand.risk).toBe("R4");
    expect(customerPrivacyExportCommand.version).toBe("0.2.0");
    expect(customerPrivacyExportCommand.idempotent).toBe(false);
    expect(customerPrivacyExportCommand.invariants).toContain("rbac.privacy_admin");
    expect(customerPrivacyExportCommand.result_redaction).toContainEqual({
      path: "/profiles/*/service_note",
      strategy: "mask",
    });
    expect(customerAnonymizeCommand.risk).toBe("R5");
    expect(customerAnonymizeCommand.version).toBe("0.2.0");
    expect(customerAnonymizeCommand.idempotent).toBe(false);
    expect(customerAnonymizeCommand.invariants).toContain("rbac.privacy_admin");
  });

  it("requires optimistic versioning for direct customer edits", async () => {
    const input = {
      customer_id: "11111111-1111-4111-8111-111111111111",
      expected_version: 2,
      name: "新名称",
    };
    await expect(parseContractInput(customerUpdateCommand, input)).resolves.toEqual(input);
    await expect(
      parseContractInput(customerUpdateCommand, {
        customer_id: input.customer_id,
        name: input.name,
      }),
    ).rejects.toBeTruthy();
  });

  it("requires an explicit exact phrase before anonymization", async () => {
    const base = {
      customer_id: "11111111-1111-4111-8111-111111111111",
      reason: "customer_request",
    };
    await expect(
      parseContractInput(customerAnonymizeCommand, { ...base, confirmation: "ANONYMIZE" }),
    ).resolves.toEqual({ ...base, confirmation: "ANONYMIZE" });
    await expect(
      parseContractInput(customerAnonymizeCommand, { ...base, confirmation: "anonymize" }),
    ).rejects.toBeTruthy();
    await expect(
      parseContractInput(customerPrivacyExportCommand, {
        customer_id: base.customer_id,
        reason: "张三申请导出 13800000111",
      }),
    ).rejects.toBeTruthy();
  });
});

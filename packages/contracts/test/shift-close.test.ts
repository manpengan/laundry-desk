import { describe, expect, it } from "vitest";

import {
  M1_FIRST_WAVE_DEFINITIONS,
  M2_SHIFT_COMMAND_DEFINITIONS,
  M2_SHIFT_COMMAND_NAMES,
  M2_SHIFT_QUERY_DEFINITIONS,
  M2_SHIFT_QUERY_NAMES,
  M2_SKELETON_COMMAND_NAMES,
  M2_SKELETON_DEFINITIONS,
  SHIFT_COMMAND_NAMES,
  SHIFT_COMMANDS,
  SHIFT_QUERY_NAMES,
  SHIFT_QUERIES,
  isContractDefinition,
  parseContractInput,
  shiftCloseCommand,
  shiftGetQuery,
} from "../src/index.js";

describe("M2 shift.close / shift.get skeleton", () => {
  it("registers definitions through A1 factory", () => {
    for (const definition of SHIFT_COMMANDS) {
      expect(isContractDefinition(definition)).toBe(true);
      expect(definition.kind).toBe("command");
      expect(definition.risk).toBe("R3");
      expect(definition.offline_mode).toBe("grant");
      expect(definition.data_classification).toBe("internal");
    }
    for (const definition of SHIFT_QUERIES) {
      expect(isContractDefinition(definition)).toBe(true);
      expect(definition.kind).toBe("query");
      expect(definition.risk).toBe("R1");
      expect(definition.offline_mode).toBe("denied");
      expect(definition.max_result_rows).toBe(1);
    }
  });

  it("exports stable names and M2 shift aliases", () => {
    expect([...SHIFT_COMMAND_NAMES]).toEqual(["shift.close"]);
    expect([...SHIFT_QUERY_NAMES]).toEqual(["shift.get"]);
    expect([...M2_SHIFT_COMMAND_NAMES]).toEqual([...SHIFT_COMMAND_NAMES]);
    expect([...M2_SHIFT_QUERY_NAMES]).toEqual([...SHIFT_QUERY_NAMES]);
    expect(M2_SHIFT_COMMAND_DEFINITIONS).toHaveLength(1);
    expect(M2_SHIFT_QUERY_DEFINITIONS).toHaveLength(1);
  });

  it("wires into M2 skeleton command catalog", () => {
    expect(M2_SKELETON_COMMAND_NAMES).toContain("shift.close");
    expect(M2_SKELETON_DEFINITIONS.map((d) => d.name)).toContain("shift.close");
  });

  it("keeps OpenAPI M1 first-wave free of shift contracts", () => {
    const names = M1_FIRST_WAVE_DEFINITIONS.map((d) => d.name);
    expect(names).not.toContain("shift.close");
    expect(names).not.toContain("shift.get");
  });

  it("parses shift.close input", async () => {
    await expect(
      parseContractInput(shiftCloseCommand, {
        business_date: "2026-07-22",
        signature_name: "店员甲",
      }),
    ).resolves.toEqual({
      business_date: "2026-07-22",
      signature_name: "店员甲",
    });

    await expect(
      parseContractInput(shiftCloseCommand, {
        business_date: "2026-07-22",
        signature_name: "店员甲",
        note: "晚班",
      }),
    ).resolves.toMatchObject({ note: "晚班" });
  });

  it("rejects invalid shift.close input", async () => {
    await expect(parseContractInput(shiftCloseCommand, {})).rejects.toBeTruthy();
    await expect(
      parseContractInput(shiftCloseCommand, {
        business_date: "20260722",
        signature_name: "甲",
      }),
    ).rejects.toBeTruthy();
    await expect(
      parseContractInput(shiftCloseCommand, {
        business_date: "2026-07-22",
        signature_name: "",
      }),
    ).rejects.toBeTruthy();
    await expect(
      parseContractInput(shiftCloseCommand, {
        business_date: "2026-07-22",
        signature_name: "x".repeat(65),
      }),
    ).rejects.toBeTruthy();
  });

  it("parses shift.get input", async () => {
    await expect(
      parseContractInput(shiftGetQuery, { business_date: "2026-07-22" }),
    ).resolves.toEqual({ business_date: "2026-07-22" });
  });

  it("declares metadata floors", () => {
    expect(shiftCloseCommand.name).toBe("shift.close");
    expect(shiftCloseCommand.risk).toBe("R3");
    expect(shiftCloseCommand.invariants).toContain("rbac.order_write");
    expect(shiftCloseCommand.offline_mode).toBe("grant");
    expect(shiftCloseCommand.idempotent).toBe(true);
    expect(shiftGetQuery.name).toBe("shift.get");
    expect(shiftGetQuery.risk).toBe("R1");
    expect(shiftGetQuery.idempotent).toBe(true);
  });
});

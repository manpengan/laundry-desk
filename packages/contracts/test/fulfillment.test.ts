import { describe, expect, it } from "vitest";

import {
  FULFILLMENT_COMMANDS,
  FULFILLMENT_QUERIES,
  M2_CONTRACT_COMMAND_NAMES,
  M2_CONTRACT_QUERY_NAMES,
  fulfillmentWorkbenchQuery,
  garmentBulkTransitionCommand,
  garmentMarkLostCommand,
  garmentReworkCommand,
  garmentTransitionCommand,
  isContractDefinition,
  parseContractInput,
} from "../src/index.js";

const GARMENT_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_ID = "22222222-2222-4222-8222-222222222222";

describe("M3 fulfillment contracts", () => {
  it("registers the five commands and bounded workbench query", () => {
    expect(FULFILLMENT_COMMANDS.every(isContractDefinition)).toBe(true);
    expect(FULFILLMENT_QUERIES.every(isContractDefinition)).toBe(true);
    expect(FULFILLMENT_COMMANDS.map((definition) => definition.name)).toEqual([
      "garment.transition",
      "garment.bulk_transition",
      "garment.rework",
      "garment.incident.record",
      "garment.mark_lost",
    ]);
    expect(fulfillmentWorkbenchQuery.max_result_rows).toBe(100);
    expect(M2_CONTRACT_COMMAND_NAMES).toContain("garment.mark_lost");
    expect(M2_CONTRACT_QUERY_NAMES).toContain("fulfillment.workbench");
  });

  it("keeps normal, batch and loss risk boundaries distinct", () => {
    expect(garmentTransitionCommand.risk).toBe("R2");
    expect(garmentBulkTransitionCommand.risk).toBe("R3");
    expect(garmentReworkCommand.risk).toBe("R3");
    expect(garmentMarkLostCommand.risk).toBe("R4");
    expect(garmentMarkLostCommand.offline_mode).toBe("denied");
  });

  it("parses a normal transition and rejects terminal targets", async () => {
    await expect(
      parseContractInput(garmentTransitionCommand, {
        garment_id: GARMENT_ID,
        target_status: "washing",
      }),
    ).resolves.toEqual({ garment_id: GARMENT_ID, target_status: "washing" });
    await expect(
      parseContractInput(garmentTransitionCommand, {
        garment_id: GARMENT_ID,
        target_status: "picked_up",
      }),
    ).rejects.toBeTruthy();
  });

  it("enforces batch bounds and mandatory rework/loss reasons", async () => {
    await expect(
      parseContractInput(garmentBulkTransitionCommand, {
        garment_ids: [GARMENT_ID, SECOND_ID],
        target_status: "ready",
      }),
    ).resolves.toBeTruthy();
    await expect(
      parseContractInput(garmentBulkTransitionCommand, {
        garment_ids: [GARMENT_ID],
        target_status: "ready",
      }),
    ).rejects.toBeTruthy();
    await expect(
      parseContractInput(garmentReworkCommand, {
        garment_ids: [GARMENT_ID],
        reason: "",
      }),
    ).rejects.toBeTruthy();
    await expect(
      parseContractInput(garmentMarkLostCommand, {
        garment_id: GARMENT_ID,
        reason: "柜台清点确认缺失",
        compensation_cents: 1200,
      }),
    ).resolves.toBeTruthy();
  });

  it("bounds workbench filters and search input", async () => {
    await expect(
      parseContractInput(fulfillmentWorkbenchQuery, {
        statuses: ["washing", "ready"],
        key: "20260730",
        limit: 100,
      }),
    ).resolves.toBeTruthy();
    await expect(
      parseContractInput(fulfillmentWorkbenchQuery, { limit: 101 }),
    ).rejects.toBeTruthy();
  });
});

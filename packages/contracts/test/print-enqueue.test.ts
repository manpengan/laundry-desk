import { describe, expect, it } from "vitest";

import {
  M1_FIRST_WAVE_DEFINITIONS,
  M2_PRINT_COMMAND_DEFINITIONS,
  M2_PRINT_COMMAND_NAMES,
  M2_PRINT_QUERY_DEFINITIONS,
  M2_PRINT_QUERY_NAMES,
  M2_SKELETON_COMMAND_NAMES,
  M2_SKELETON_DEFINITIONS,
  PRINT_COMMAND_NAMES,
  PRINT_COMMANDS,
  PRINT_QUERY_NAMES,
  PRINT_QUERIES,
  isContractDefinition,
  parseContractInput,
  printJobsListQuery,
  printTicketEnqueueCommand,
  printTicketProcessCommand,
} from "../src/index.js";

describe("M2 print.ticket.enqueue / process / print.jobs.list", () => {
  it("registers definitions through A1 factories", () => {
    for (const definition of PRINT_COMMANDS) {
      expect(isContractDefinition(definition)).toBe(true);
      expect(definition.kind).toBe("command");
      expect(definition.risk).toBe("R1");
      expect(definition.data_classification).toBe("internal");
    }
    for (const definition of PRINT_QUERIES) {
      expect(isContractDefinition(definition)).toBe(true);
      expect(definition.kind).toBe("query");
      expect(definition.offline_mode).toBe("denied");
      expect(definition.data_classification).toBe("internal");
    }
  });

  it("exports stable names and M2 print aliases", () => {
    expect([...PRINT_COMMAND_NAMES]).toEqual(["print.ticket.enqueue", "print.ticket.process"]);
    expect([...PRINT_QUERY_NAMES]).toEqual(["print.jobs.list"]);
    expect([...M2_PRINT_COMMAND_NAMES]).toEqual([...PRINT_COMMAND_NAMES]);
    expect([...M2_PRINT_QUERY_NAMES]).toEqual([...PRINT_QUERY_NAMES]);
    expect(M2_PRINT_COMMAND_DEFINITIONS).toHaveLength(2);
    expect(M2_PRINT_QUERY_DEFINITIONS).toHaveLength(1);
  });

  it("folds print commands into M2 skeleton definitions", () => {
    const names = M2_SKELETON_DEFINITIONS.map((d) => d.name);
    expect(names).toContain("print.ticket.enqueue");
    expect(names).toContain("print.ticket.process");
    expect(names).toContain("order.receive");
    expect([...M2_SKELETON_COMMAND_NAMES]).toContain("print.ticket.enqueue");
    expect([...M2_SKELETON_COMMAND_NAMES]).toContain("print.ticket.process");
  });

  it("keeps OpenAPI M1 first-wave free of print contracts", () => {
    const names = M1_FIRST_WAVE_DEFINITIONS.map((d) => d.name);
    expect(names).not.toContain("print.ticket.enqueue");
    expect(names).not.toContain("print.ticket.process");
    expect(names).not.toContain("print.jobs.list");
  });

  it("parses enqueue input without kind (handler defaults to xp58)", async () => {
    const orderId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    await expect(
      parseContractInput(printTicketEnqueueCommand, {
        order_id: orderId,
        ticket_no: "20260722-0001",
      }),
    ).resolves.toEqual({
      order_id: orderId,
      ticket_no: "20260722-0001",
    });
  });

  it("parses enqueue with explicit kind", async () => {
    const orderId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    await expect(
      parseContractInput(printTicketEnqueueCommand, {
        order_id: orderId,
        ticket_no: "T-1",
        kind: "dl206",
      }),
    ).resolves.toEqual({
      order_id: orderId,
      ticket_no: "T-1",
      kind: "dl206",
    });
  });

  it("rejects invalid enqueue input", async () => {
    await expect(parseContractInput(printTicketEnqueueCommand, {})).rejects.toBeTruthy();
    await expect(
      parseContractInput(printTicketEnqueueCommand, {
        order_id: "not-a-uuid",
        ticket_no: "x",
      }),
    ).rejects.toBeTruthy();
    await expect(
      parseContractInput(printTicketEnqueueCommand, {
        order_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        ticket_no: "",
      }),
    ).rejects.toBeTruthy();
    await expect(
      parseContractInput(printTicketEnqueueCommand, {
        order_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        ticket_no: "ok",
        kind: "unknown",
      }),
    ).rejects.toBeTruthy();
  });

  it("parses list input with optional limit (handler default 20)", async () => {
    await expect(parseContractInput(printJobsListQuery, {})).resolves.toEqual({});
    await expect(parseContractInput(printJobsListQuery, { limit: 5 })).resolves.toEqual({
      limit: 5,
    });
  });

  it("rejects list limit over max", async () => {
    await expect(parseContractInput(printJobsListQuery, { limit: 51 })).rejects.toBeTruthy();
    await expect(parseContractInput(printJobsListQuery, { limit: 0 })).rejects.toBeTruthy();
  });

  it("parses process input with job_id uuid", async () => {
    const jobId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    await expect(parseContractInput(printTicketProcessCommand, { job_id: jobId })).resolves.toEqual(
      { job_id: jobId },
    );
  });

  it("rejects invalid process input", async () => {
    await expect(parseContractInput(printTicketProcessCommand, {})).rejects.toBeTruthy();
    await expect(
      parseContractInput(printTicketProcessCommand, { job_id: "not-a-uuid" }),
    ).rejects.toBeTruthy();
  });

  it("declares metadata floors for enqueue, process, and list", () => {
    expect(printTicketEnqueueCommand.name).toBe("print.ticket.enqueue");
    expect(printTicketEnqueueCommand.risk).toBe("R1");
    expect(printTicketEnqueueCommand.offline_mode).toBe("grant");
    expect(printTicketEnqueueCommand.idempotent).toBe(true);
    expect(printTicketEnqueueCommand.sideEffects).toContain("audit.print_job");

    expect(printTicketProcessCommand.name).toBe("print.ticket.process");
    expect(printTicketProcessCommand.risk).toBe("R1");
    expect(printTicketProcessCommand.idempotent).toBe(false);
    expect(printTicketProcessCommand.offline_mode).toBe("denied");
    expect(printTicketProcessCommand.sideEffects).toContain("print.job_processed");

    expect(printJobsListQuery.name).toBe("print.jobs.list");
    expect(printJobsListQuery.risk).toBe("R1");
    expect(printJobsListQuery.max_result_rows).toBe(50);
    expect(printJobsListQuery.offline_mode).toBe("denied");
  });
});

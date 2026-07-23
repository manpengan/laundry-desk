import { describe, expect, it } from "vitest";

import {
  M2_CONTRACT_COMMAND_NAMES,
  M2_CONTRACT_DEFINITIONS,
  M2_CONTRACT_QUERY_NAMES,
  M2_READ_ONLY_AI_DEFINITIONS,
} from "../src/commands/catalog.js";
import {
  buildLaundryOpenApiDocument,
  serializeOpenApiDocument,
} from "../src/openapi/build-document.js";

describe("M2 contract v0.2 freeze", () => {
  it("freezes the counter command and query surface", () => {
    expect(M2_CONTRACT_COMMAND_NAMES).toEqual([
      "customer.upsert",
      "order.receive",
      "order.hold",
      "order.cancel",
      "order.pickup",
      "payment.collect",
      "payment.repay",
      "payment.refund",
      "print.ticket.enqueue",
      "print.ticket.process",
      "print.ticket.retry",
      "print.ticket.reprint",
      "shift.close",
      "photo.register",
    ]);
    expect(M2_CONTRACT_QUERY_NAMES).toContain("catalog.items.list");
    expect(M2_CONTRACT_QUERY_NAMES).toContain("stats.day.summary");
    expect(M2_CONTRACT_QUERY_NAMES).toContain("photo.list_by_order");
    expect(M2_CONTRACT_DEFINITIONS).toHaveLength(
      M2_CONTRACT_COMMAND_NAMES.length + M2_CONTRACT_QUERY_NAMES.length,
    );
    expect(M2_CONTRACT_DEFINITIONS.every((definition) => definition.version === "0.2.0")).toBe(
      true,
    );
  });

  it("enforces the M2 offline and AI risk matrix", () => {
    const byName = new Map(
      M2_CONTRACT_DEFINITIONS.map((definition) => [definition.name, definition]),
    );
    expect(byName.get("order.receive")?.offline_mode).toBe("grant");
    expect(byName.get("order.pickup")?.offline_mode).toBe("primary_lease");
    expect(byName.get("payment.collect")?.offline_mode).toBe("primary_lease");
    expect(byName.get("payment.refund")).toMatchObject({ risk: "R4", offline_mode: "denied" });
    expect(M2_READ_ONLY_AI_DEFINITIONS.every((definition) => definition.kind === "query")).toBe(
      true,
    );
    expect(M2_READ_ONLY_AI_DEFINITIONS.every((definition) => definition.risk !== "R5")).toBe(true);
  });

  it("projects the frozen M2 surface into deterministic OpenAPI", () => {
    const first = serializeOpenApiDocument(buildLaundryOpenApiDocument());
    const second = serializeOpenApiDocument(buildLaundryOpenApiDocument());
    expect(first).toBe(second);
    const document = buildLaundryOpenApiDocument();
    for (const definition of M2_CONTRACT_DEFINITIONS) {
      const path = `/v1/${definition.kind === "command" ? "commands" : "queries"}/${definition.name}`;
      expect(document.paths[path], path).toBeDefined();
    }
  });
});

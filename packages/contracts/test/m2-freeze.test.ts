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

describe("M2 contract surface", () => {
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
      // ADR-15: deliberate unfreeze so a fresh install can maintain its price
      // list. Further additions still require their own ADR.
      "catalog.item.upsert",
    ]);
    expect(M2_CONTRACT_QUERY_NAMES).toContain("catalog.items.list");
    expect(M2_CONTRACT_QUERY_NAMES).toContain("stats.day.summary");
    expect(M2_CONTRACT_QUERY_NAMES).toContain("photo.list_by_order");
    expect(M2_CONTRACT_DEFINITIONS).toHaveLength(
      M2_CONTRACT_COMMAND_NAMES.length + M2_CONTRACT_QUERY_NAMES.length,
    );
    expect(
      M2_CONTRACT_DEFINITIONS.find((definition) => definition.name === "order.receive")?.version,
    ).toBe("0.3.0");
    expect(
      M2_CONTRACT_DEFINITIONS.find((definition) => definition.name === "order.hold")?.version,
    ).toBe("0.3.0");
    expect(
      M2_CONTRACT_DEFINITIONS.find((definition) => definition.name === "order.cancel")?.version,
    ).toBe("0.3.0");
    expect(
      M2_CONTRACT_DEFINITIONS.find((definition) => definition.name === "shift.close")?.version,
    ).toBe("0.3.0");
    expect(
      M2_CONTRACT_DEFINITIONS.find((definition) => definition.name === "stats.day.summary")
        ?.version,
    ).toBe("0.3.0");
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
    expect(new Set(M2_READ_ONLY_AI_DEFINITIONS.map((definition) => definition.risk))).toEqual(
      new Set(["R0", "R1", "R2"]),
    );
  });

  it("projects the frozen M2 surface into deterministic OpenAPI", () => {
    const first = serializeOpenApiDocument(buildLaundryOpenApiDocument());
    const second = serializeOpenApiDocument(buildLaundryOpenApiDocument());
    expect(first).toBe(second);
    const document = buildLaundryOpenApiDocument();
    for (const definition of M2_CONTRACT_DEFINITIONS) {
      const path = `/v1/${definition.kind === "command" ? "commands" : "queries"}/${definition.name}`;
      if (definition.name === "photo.register") {
        expect(document.paths[path], `${path} is internal-only`).toBeUndefined();
      } else {
        expect(document.paths[path], path).toBeDefined();
      }
    }
  });
});

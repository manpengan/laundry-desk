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
      "customer.update",
      "customer.merge",
      "customer.privacy.export",
      "customer.anonymize",
      "order.receive",
      "order.hold",
      "order.cancel",
      "order.pickup",
      "payment.collect",
      "payment.repay",
      "payment.refund",
      // ADR-24: audited dual-basis report export. The paired read query remains
      // outside the current AI projection until a later accounting/AI ADR.
      "accounting.report.export",
      "reconciliation.export",
      "edge.conflict.discard",
      "print.ticket.enqueue",
      "print.ticket.process",
      "print.ticket.retry",
      "print.ticket.reprint",
      "shift.close",
      "photo.register",
      "photo.delete",
      // ADR-15: deliberate unfreeze so a fresh install can maintain its price
      // list. Further additions still require their own ADR.
      "catalog.item.upsert",
      "garment.transition",
      "garment.bulk_transition",
      "garment.rack.assign",
      "garment.rework",
      "garment.incident.record",
      "garment.mark_lost",
      // M1.5: store-scoped staff access administration with R5 step-up.
      "staff.access.set",
      // ADR-17: member stored value. Top-up is R3 because real money enters an
      // append-only ledger; the balance is SUM(delta), never a stored column.
      "member.account.open",
      "member.topup",
      "member.balance.pay",
      // ADR-22 §2: top-up bonus tiers. R3 because it changes how much money the
      // shop gives away on every later top-up; the amount itself is always
      // computed server-side and never accepted from a client.
      "member.bonus_rule.upsert",
      // ADR-22 §5: R4 because money leaves the business and cannot be undone.
      // Only principal is refundable; the DB CHECK enforces bonus_delta = 0.
      "member.refund",
      // ADR-23: manual fallback only. The R3 command creates an audited CSV;
      // it does not send a message and is hard-capped below the R4 threshold.
      "notification.manual_list.create",
    ]);
    expect(M2_CONTRACT_QUERY_NAMES).toContain("catalog.items.list");
    expect(M2_CONTRACT_QUERY_NAMES).toContain("stats.day.summary");
    expect(M2_CONTRACT_QUERY_NAMES).toContain("photo.list_by_order");
    expect(M2_CONTRACT_QUERY_NAMES).toContain("fulfillment.workbench");
    expect(M2_CONTRACT_QUERY_NAMES).toContain("customer.get");
    expect(M2_CONTRACT_QUERY_NAMES).toContain("customer.duplicates");
    expect(M2_CONTRACT_QUERY_NAMES).toContain("staff.access.list");
    expect(M2_CONTRACT_QUERY_NAMES).toContain("member.account.get");
    expect(M2_CONTRACT_QUERY_NAMES).toContain("member.bonus_rules.list");
    // ADR-23: PII-bearing manual counter worklist, deliberately not in AI tools.
    expect(M2_CONTRACT_QUERY_NAMES).toContain("notification.pickup_reminders.list");
    expect(M2_CONTRACT_QUERY_NAMES).toContain("accounting.report.get");
    expect(M2_CONTRACT_COMMAND_NAMES).toHaveLength(36);
    expect(M2_CONTRACT_QUERY_NAMES).toHaveLength(22);
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
    expect(M2_READ_ONLY_AI_DEFINITIONS.map((definition) => definition.name)).not.toContain(
      "notification.pickup_reminders.list",
    );
    expect(M2_READ_ONLY_AI_DEFINITIONS.map((definition) => definition.name)).not.toContain(
      "accounting.report.get",
    );
  });

  it("projects the frozen M2 surface into deterministic OpenAPI", { timeout: 10_000 }, () => {
    const document = buildLaundryOpenApiDocument();
    const first = serializeOpenApiDocument(document);
    const second = serializeOpenApiDocument(buildLaundryOpenApiDocument());
    expect(first).toBe(second);
    for (const definition of M2_CONTRACT_DEFINITIONS) {
      const path = `/v1/${definition.kind === "command" ? "commands" : "queries"}/${definition.name}`;
      if (definition.name === "photo.register" || definition.name === "photo.delete") {
        expect(document.paths[path], `${path} is internal-only`).toBeUndefined();
      } else {
        expect(document.paths[path], path).toBeDefined();
      }
    }
  });
});

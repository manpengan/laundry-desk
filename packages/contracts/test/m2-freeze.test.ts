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
      // ADR-42: bounded customer profile and separate high-risk discount policy.
      "customer.profile.set",
      "customer.discount_policy.set",
      "order.receive",
      "order.hold",
      "order.cancel",
      "order.pickup",
      "payment.collect",
      "payment.repay",
      "payment.refund",
      // ADR-38: store-scoped server-authoritative urgent/freight/add-on policy.
      "pricing.policy.set",
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
      // ADR-39: full active-snapshot reorder with optimistic row versions.
      "catalog.items.reorder",
      "garment.transition",
      "garment.bulk_transition",
      "garment.rack.assign",
      "garment.rework",
      "garment.incident.record",
      "garment.mark_lost",
      // ADR-45: store-scoped online custody, discrepancy and QC evidence.
      "fulfillment.batch.create",
      "fulfillment.batch.cancel",
      "fulfillment.handoff.checkpoint.record",
      "fulfillment.handoff.discrepancy.resolve",
      "fulfillment.quality_check.record",
      // M1.5: store-scoped staff access administration with R5 step-up.
      "staff.access.set",
      // ADR-31: non-secret staff lifecycle commands. Password and PIN only
      // cross the dedicated authenticated completion boundary.
      "staff.create",
      "staff.credentials.reset",
      // ADR-40: current authenticated store only; R5 step-up + optimistic profile version.
      "store.profile.set",
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
      // ADR-25: account lifecycle is an explicit three-command state machine.
      // Close is atomic: full remaining principal out, full bonus forfeited,
      // and the account becomes terminally closed in the same transaction.
      "member.account.freeze",
      "member.account.unfreeze",
      "member.account.close",
      // ADR-41: virtual tier, points, punch-card and coupon surfaces. The
      // browser never submits computed point awards or coupon discounts.
      "member.benefit_definition.upsert",
      "member.membership.set",
      "member.points.earn",
      "member.points.redeem",
      "member.asset.grant",
      "member.asset.consume",
      // ADR-23: manual fallback only. The R3 command creates an audited CSV;
      // it does not send a message and is hard-capped below the R4 threshold.
      "notification.manual_list.create",
      // ADR-44: explicit admin enqueue; 11-50 recipients escalate R3 to R4.
      "notification.delivery_batch.enqueue",
      // ADR-46: current-store policy only; does not enable delivery or create bookings.
      "delivery.policy.set",
      // ADR-47: customer/address references, real slot capacity and optimistic lifecycle.
      "delivery.appointment.create",
      "delivery.appointment.reschedule",
      "delivery.appointment.cancel",
      // ADR-48: authoritative route linkage and DB-enforced optimistic logistics lifecycle.
      "delivery.order.create",
      "delivery.order.transition",
      // ADR-49: current-store assignment custody, successor chain and R4 takeover.
      "delivery.task.assign",
      "delivery.task.respond",
      "delivery.task.transfer",
      "delivery.task.takeover",
      // ADR-51: accepted-assignee evidence, with optional atomic leg completion.
      "delivery.evidence.record",
      "marketing.campaign.set",
      "marketing.campaign.audience.freeze",
      "marketing.campaign.coupons.issue",
      "marketing.coupon.redemption.reverse",
      "marketing.referral.reward.issue",
      "marketing.group_buy.voucher.register",
      "marketing.group_buy.voucher.redeem",
      // ADR-63: only allowlisted R3-or-lower automations with explicit approval,
      // schedule windows and lock-checked daily count/integer-fen quotas.
      "automation.policy.create",
      "automation.policy.update",
      "automation.policy.approve",
      "automation.policy.pause",
      "automation.policy.resume",
      "automation.policy.archive",
    ]);
    expect(M2_CONTRACT_QUERY_NAMES).toContain("catalog.items.list");
    expect(M2_CONTRACT_QUERY_NAMES).toContain("catalog.items.manage.list");
    expect(M2_CONTRACT_QUERY_NAMES).toContain("catalog.audit.list");
    expect(M2_CONTRACT_QUERY_NAMES).toContain("stats.day.summary");
    expect(M2_CONTRACT_QUERY_NAMES).toContain("photo.list_by_order");
    expect(M2_CONTRACT_QUERY_NAMES).toContain("fulfillment.workbench");
    expect(M2_CONTRACT_QUERY_NAMES).toContain("fulfillment.batches.list");
    expect(M2_CONTRACT_QUERY_NAMES).toContain("fulfillment.batch.get");
    expect(M2_CONTRACT_QUERY_NAMES).toContain("customer.get");
    expect(M2_CONTRACT_QUERY_NAMES).toContain("customer.duplicates");
    expect(M2_CONTRACT_QUERY_NAMES).toContain("customer.profile.get");
    expect(M2_CONTRACT_QUERY_NAMES).toContain("staff.access.list");
    expect(M2_CONTRACT_QUERY_NAMES).toContain("store.authorized.list");
    expect(M2_CONTRACT_QUERY_NAMES).toContain("member.account.get");
    expect(M2_CONTRACT_QUERY_NAMES).toContain("member.bonus_rules.list");
    expect(M2_CONTRACT_QUERY_NAMES).toContain("member.benefit_catalog.get");
    expect(M2_CONTRACT_QUERY_NAMES).toContain("member.benefits.get");
    // ADR-23: PII-bearing manual counter worklist, deliberately not in AI tools.
    expect(M2_CONTRACT_QUERY_NAMES).toContain("notification.pickup_reminders.list");
    expect(M2_CONTRACT_QUERY_NAMES).toContain("notification.delivery.capability.get");
    expect(M2_CONTRACT_QUERY_NAMES).toContain("notification.delivery_batches.list");
    expect(M2_CONTRACT_QUERY_NAMES).toContain("notification.delivery_batch.get");
    expect(M2_CONTRACT_QUERY_NAMES).toContain("marketing.campaigns.list");
    expect(M2_CONTRACT_QUERY_NAMES).toContain("marketing.campaign.get");
    expect(M2_CONTRACT_QUERY_NAMES).toContain("marketing.campaign.audience.preview");
    expect(M2_CONTRACT_QUERY_NAMES).toContain("marketing.campaign.coupons.preview");
    expect(M2_CONTRACT_QUERY_NAMES).toContain("marketing.campaign.coupon_batch.get");
    expect(M2_CONTRACT_QUERY_NAMES).toContain("customer.self_service.orders.list");
    expect(M2_CONTRACT_QUERY_NAMES).toContain("customer.self_service.order.get");
    expect(M2_CONTRACT_QUERY_NAMES).toContain("customer.self_service.receipt.get");
    expect(M2_CONTRACT_QUERY_NAMES).toContain("customer.self_service.garments.list");
    expect(M2_CONTRACT_QUERY_NAMES).toContain("customer.self_service.garment.progress");
    expect(M2_CONTRACT_QUERY_NAMES).toContain("customer.self_service.wallet.get");
    expect(M2_CONTRACT_QUERY_NAMES).toContain("customer.self_service.benefits.get");
    expect(M2_CONTRACT_QUERY_NAMES).toContain("customer.self_service.profile.get");
    expect(M2_CONTRACT_QUERY_NAMES).toContain("automation.policies.list");
    expect(M2_CONTRACT_QUERY_NAMES).toContain("automation.policy.get");
    expect(M2_CONTRACT_QUERY_NAMES).toContain("automation.runs.list");
    expect(M2_CONTRACT_QUERY_NAMES).toContain("accounting.report.get");
    expect(M2_CONTRACT_QUERY_NAMES).toContain("reporting.owner_dashboard.get");
    expect(M2_CONTRACT_QUERY_NAMES).toContain("reporting.owner_dashboard.drilldown");
    expect(M2_CONTRACT_QUERY_NAMES).toContain("reporting.owner_portfolio.get");
    // ADR-38: trusted policy read and immutable payment-ledger refund source.
    expect(M2_CONTRACT_QUERY_NAMES).toContain("pricing.policy.get");
    expect(M2_CONTRACT_QUERY_NAMES).toContain("payment.ledger.list");
    // ADR-46: store delivery policy plus a feature-gated, policy-only quote.
    expect(M2_CONTRACT_COMMAND_NAMES).toContain("delivery.policy.set");
    expect(M2_CONTRACT_QUERY_NAMES).toContain("delivery.policy.get");
    expect(M2_CONTRACT_QUERY_NAMES).toContain("delivery.availability.quote");
    expect(M2_CONTRACT_QUERY_NAMES).toContain("delivery.appointment.get");
    expect(M2_CONTRACT_QUERY_NAMES).toContain("delivery.appointment.addresses.list");
    expect(M2_CONTRACT_QUERY_NAMES).toContain("delivery.appointments.list");
    expect(M2_CONTRACT_QUERY_NAMES).toContain("delivery.order.get");
    expect(M2_CONTRACT_QUERY_NAMES).toContain("delivery.orders.list");
    expect(M2_CONTRACT_QUERY_NAMES).toContain("delivery.task.get");
    expect(M2_CONTRACT_QUERY_NAMES).toContain("delivery.tasks.list");
    expect(M2_CONTRACT_QUERY_NAMES).toContain("delivery.evidence.list");
    expect(M2_CONTRACT_COMMAND_NAMES).toHaveLength(82);
    expect(M2_CONTRACT_QUERY_NAMES).toHaveLength(64);
    expect(M2_CONTRACT_DEFINITIONS).toHaveLength(
      M2_CONTRACT_COMMAND_NAMES.length + M2_CONTRACT_QUERY_NAMES.length,
    );
    expect(
      M2_CONTRACT_DEFINITIONS.find((definition) => definition.name === "order.receive")?.version,
    ).toBe("0.4.0");
    expect(
      M2_CONTRACT_DEFINITIONS.find((definition) => definition.name === "order.hold")?.version,
    ).toBe("0.4.0");
    expect(
      M2_CONTRACT_DEFINITIONS.find((definition) => definition.name === "order.get")?.version,
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
      "notification.delivery.capability.get",
    );
    expect(M2_READ_ONLY_AI_DEFINITIONS.map((definition) => definition.name)).not.toContain(
      "notification.delivery_batches.list",
    );
    expect(M2_READ_ONLY_AI_DEFINITIONS.map((definition) => definition.name)).not.toContain(
      "notification.delivery_batch.get",
    );
    expect(M2_READ_ONLY_AI_DEFINITIONS.map((definition) => definition.name)).not.toContain(
      "catalog.items.manage.list",
    );
    expect(M2_READ_ONLY_AI_DEFINITIONS.map((definition) => definition.name)).not.toContain(
      "catalog.audit.list",
    );
    expect(M2_READ_ONLY_AI_DEFINITIONS.map((definition) => definition.name)).not.toContain(
      "accounting.report.get",
    );
    expect(M2_READ_ONLY_AI_DEFINITIONS.map((definition) => definition.name)).not.toContain(
      "reporting.owner_dashboard.get",
    );
    expect(M2_READ_ONLY_AI_DEFINITIONS.map((definition) => definition.name)).not.toContain(
      "reporting.owner_dashboard.drilldown",
    );
    expect(M2_READ_ONLY_AI_DEFINITIONS.map((definition) => definition.name)).not.toContain(
      "reporting.owner_portfolio.get",
    );
    expect(M2_READ_ONLY_AI_DEFINITIONS.map((definition) => definition.name)).not.toContain(
      "store.authorized.list",
    );
    expect(M2_READ_ONLY_AI_DEFINITIONS.map((definition) => definition.name)).not.toContain(
      "member.benefit_catalog.get",
    );
    expect(M2_READ_ONLY_AI_DEFINITIONS.map((definition) => definition.name)).not.toContain(
      "member.benefits.get",
    );
    expect(M2_READ_ONLY_AI_DEFINITIONS.map((definition) => definition.name)).not.toContain(
      "customer.get",
    );
    expect(M2_READ_ONLY_AI_DEFINITIONS.map((definition) => definition.name)).not.toContain(
      "customer.privacy.status",
    );
    expect(M2_READ_ONLY_AI_DEFINITIONS.map((definition) => definition.name)).not.toContain(
      "customer.privacy.events",
    );
    expect(M2_READ_ONLY_AI_DEFINITIONS.map((definition) => definition.name)).not.toContain(
      "customer.profile.get",
    );
    expect(M2_READ_ONLY_AI_DEFINITIONS.map((definition) => definition.name)).not.toContain(
      "fulfillment.batches.list",
    );
    expect(M2_READ_ONLY_AI_DEFINITIONS.map((definition) => definition.name)).not.toContain(
      "fulfillment.batch.get",
    );
    expect(M2_READ_ONLY_AI_DEFINITIONS.map((definition) => definition.name)).not.toContain(
      "delivery.availability.quote",
    );
    expect(M2_READ_ONLY_AI_DEFINITIONS.map((definition) => definition.name)).not.toContain(
      "delivery.appointment.get",
    );
    expect(M2_READ_ONLY_AI_DEFINITIONS.map((definition) => definition.name)).not.toContain(
      "delivery.appointment.addresses.list",
    );
    expect(M2_READ_ONLY_AI_DEFINITIONS.map((definition) => definition.name)).not.toContain(
      "delivery.appointments.list",
    );
    expect(M2_READ_ONLY_AI_DEFINITIONS.map((definition) => definition.name)).not.toContain(
      "delivery.order.get",
    );
    expect(M2_READ_ONLY_AI_DEFINITIONS.map((definition) => definition.name)).not.toContain(
      "delivery.orders.list",
    );
    expect(M2_READ_ONLY_AI_DEFINITIONS.map((definition) => definition.name)).not.toContain(
      "delivery.evidence.list",
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

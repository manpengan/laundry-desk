import { describe, expect, it } from "vitest";

import {
  AI_APPROVAL_OPERATION_MATRIX,
  AiApprovalDecisionSchema,
  AiApprovalDenialSchema,
  AiApprovalViewSchema,
} from "../src/index.js";

const UUID = "11111111-1111-4111-8111-111111111111";

describe("AI asynchronous approval contracts", () => {
  it("freezes five dedicated operations without a generic execution endpoint", () => {
    expect(AI_APPROVAL_OPERATION_MATRIX.map((row) => row.operation)).toEqual([
      "submit",
      "list",
      "detail",
      "approve",
      "deny",
    ]);
    expect(AI_APPROVAL_OPERATION_MATRIX.filter((row) => row.risk === "R4")).toHaveLength(3);
    expect(AI_APPROVAL_OPERATION_MATRIX.map((row) => String(row.risk)).includes("R5")).toBe(false);
    expect(
      AI_APPROVAL_OPERATION_MATRIX.filter((row) => row.method === "POST").every((row) => row.csrf),
    ).toBe(true);
  });

  it("accepts a complete WYSIWYS view and rejects omitted authority bindings", () => {
    const view = {
      approval_ref: UUID,
      confirm_ref: "22222222-2222-4222-8222-222222222222",
      command: "payment.refund",
      command_version: "1.0.0",
      args: { payment_id: UUID, amount_cents: 100 },
      args_hash: "a".repeat(64),
      entity_versions: [{ entity_type: "payment", entity_id: UUID, version: 2 }],
      idempotency_key: "33333333-3333-4333-8333-333333333333",
      requester_staff_id: "44444444-4444-4444-8444-444444444444",
      status: "pending",
      row_version: 1,
      created_at_epoch: 1,
      expires_at_epoch: 2,
      decided_by_staff_id: null,
      decided_by_permission_version: null,
      decided_at_epoch: null,
      decision_reason: null,
      consumed_at_epoch: null,
    };
    expect(AiApprovalViewSchema.safeParse(view).success).toBe(true);
    const withoutHash: Readonly<Record<string, unknown>> = { ...view };
    Reflect.deleteProperty(withoutHash, "args_hash");
    expect(AiApprovalViewSchema.safeParse(withoutHash).success).toBe(false);
    expect(AiApprovalViewSchema.safeParse({ ...view, hidden_args: {} }).success).toBe(false);
  });

  it("requires CAS versions and a bounded non-empty denial reason", () => {
    expect(AiApprovalDecisionSchema.safeParse({ expected_version: 1 }).success).toBe(true);
    expect(AiApprovalDecisionSchema.safeParse({ expected_version: 0 }).success).toBe(false);
    expect(
      AiApprovalDenialSchema.safeParse({ expected_version: 1, reason: "不同意退款" }).success,
    ).toBe(true);
    expect(AiApprovalDenialSchema.safeParse({ expected_version: 1, reason: " " }).success).toBe(
      false,
    );
  });
});

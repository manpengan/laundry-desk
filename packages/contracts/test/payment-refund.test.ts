import { describe, expect, it } from "vitest";

import {
  PaymentRefundInputSchema,
  parseContractInput,
  paymentRefundCommand,
} from "../src/index.js";

const input = Object.freeze({
  order_id: "10000000-0000-4000-8000-000000000001",
  amount_cents: 400,
  method: "cash" as const,
  note: "legacy client note",
  ref_payment_id: "10000000-0000-4000-8000-000000000002",
  reason: "customer changed service",
});

describe("payment.refund contract", () => {
  it("preserves the frozen v0.2 input while documenting server verification", async () => {
    await expect(parseContractInput(paymentRefundCommand, input)).resolves.toEqual(input);
    const { method, ...withoutMethod } = input;
    expect(method).toBe("cash");
    expect(PaymentRefundInputSchema.safeParse(withoutMethod).success).toBe(false);
    expect(PaymentRefundInputSchema.safeParse({ ...input, unexpected: true }).success).toBe(false);
  });

  it("stays append-only, online-only and step-up protected", () => {
    expect(paymentRefundCommand.risk).toBe("R4");
    expect(paymentRefundCommand.offline_mode).toBe("denied");
    expect(paymentRefundCommand.invariants).toContain("payment.append_only");
    expect(paymentRefundCommand.invariants).toContain("rbac.payment_refund");
  });
});

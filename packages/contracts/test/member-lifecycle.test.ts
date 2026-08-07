import { describe, expect, it } from "vitest";

import {
  MEMBER_LIFECYCLE_COMMAND_NAMES,
  MemberAccountCloseInputSchema,
  MemberAccountFreezeInputSchema,
  MemberAccountGetResultSchema,
  MemberAccountUnfreezeInputSchema,
  memberAccountCloseCommand,
  memberAccountFreezeCommand,
  memberAccountGetQuery,
  memberAccountUnfreezeCommand,
} from "../src/index.js";

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const CUSTOMER_ID = "22222222-2222-4222-8222-222222222222";
const LEDGER_ID = "33333333-3333-4333-8333-333333333333";
const STORE_ID = "44444444-4444-4444-8444-444444444444";

const lifecycleInput = {
  account_id: ACCOUNT_ID,
  expected_customer_id: CUSTOMER_ID,
  expected_status_version: 3,
  reason: "  顾客挂失  ",
};

describe("member account lifecycle contracts (ADR-25)", () => {
  it("shares a strict, trimmed and version-guarded transition input", () => {
    expect(MemberAccountFreezeInputSchema.parse(lifecycleInput)).toEqual({
      ...lifecycleInput,
      reason: "顾客挂失",
    });
    expect(MemberAccountUnfreezeInputSchema.parse(lifecycleInput)).toEqual({
      ...lifecycleInput,
      reason: "顾客挂失",
    });

    for (const input of [
      { ...lifecycleInput, expected_status_version: 0 },
      { ...lifecycleInput, expected_status_version: Number.MAX_SAFE_INTEGER + 1 },
      { ...lifecycleInput, reason: "   " },
      { ...lifecycleInput, tenant_id: STORE_ID },
    ]) {
      expect(MemberAccountFreezeInputSchema.safeParse(input).success).toBe(false);
    }
  });

  it("requires a refund tender exactly when closure returns principal", () => {
    const base = {
      ...lifecycleInput,
      expected_status: "frozen" as const,
      expected_bonus_cents: 2_000,
    };

    expect(
      MemberAccountCloseInputSchema.parse({
        ...base,
        expected_principal_cents: 5_000_000,
        refund_tender: "wechat",
      }),
    ).toMatchObject({ reason: "顾客挂失", refund_tender: "wechat" });
    expect(
      MemberAccountCloseInputSchema.parse({
        ...base,
        expected_principal_cents: 0,
        refund_tender: null,
      }),
    ).toMatchObject({ expected_principal_cents: 0, refund_tender: null });

    for (const input of [
      { ...base, expected_principal_cents: 1, refund_tender: null },
      { ...base, expected_principal_cents: 0, refund_tender: "cash" },
      { ...base, expected_principal_cents: 5_000_001, refund_tender: "cash" },
      {
        ...base,
        expected_status: "closed",
        expected_principal_cents: 1,
        refund_tender: "cash",
      },
    ]) {
      expect(MemberAccountCloseInputSchema.safeParse(input).success).toBe(false);
    }
  });

  it("freezes the risk, permissions, redaction and offline boundary", () => {
    expect(MEMBER_LIFECYCLE_COMMAND_NAMES).toEqual([
      "member.account.freeze",
      "member.account.unfreeze",
      "member.account.close",
    ]);
    expect(memberAccountFreezeCommand).toMatchObject({
      risk: "R3",
      offline_mode: "denied",
      input_redaction: [{ path: "/reason", strategy: "mask" }],
    });
    expect(memberAccountFreezeCommand.invariants).toContain("rbac.member_freeze");
    expect(memberAccountUnfreezeCommand).toMatchObject({ risk: "R3", offline_mode: "denied" });
    expect(memberAccountUnfreezeCommand.invariants).toContain("rbac.member_lifecycle_manage");
    expect(memberAccountCloseCommand).toMatchObject({
      risk: "R4",
      offline_mode: "denied",
      size_measures: {
        amount: { kind: "field", path: "/expected_principal_cents" },
      },
      hard_limits: { max_amount_cents: 5_000_000 },
    });
    expect(memberAccountCloseCommand.invariants).toEqual(
      expect.arrayContaining(["rbac.member_lifecycle_manage", "rbac.member_refund"]),
    );
    expect(memberAccountGetQuery.version).toBe("1.1.0");
  });

  it("validates the exact lifecycle-aware account and ledger projection", () => {
    const result = {
      account: {
        account_id: ACCOUNT_ID,
        customer_id: CUSTOMER_ID,
        status: "closed",
        status_version: 4,
        status_changed_at: 1_786_080_000,
        status_reason: "顾客主动退卡",
        principal_cents: 0,
        bonus_cents: 0,
        balance_cents: 0,
      },
      recent: [
        {
          ledger_id: LEDGER_ID,
          kind: "bonus_forfeit",
          principal_delta_cents: 0,
          bonus_delta_cents: -2_000,
          order_id: null,
          store_id: STORE_ID,
          tender: null,
          bonus_rule_id: null,
          at: 1_786_080_000,
          business_date: "2026-08-07",
          note: "关户赠款清零",
        },
      ],
    };

    expect(MemberAccountGetResultSchema.parse(result)).toEqual(result);
    expect(
      MemberAccountGetResultSchema.safeParse({
        ...result,
        account: { ...result.account, status: "disabled" },
      }).success,
    ).toBe(false);
    expect(
      MemberAccountGetResultSchema.safeParse({
        ...result,
        account: { ...result.account, balance_cents: 1 },
      }).success,
    ).toBe(false);
    expect(
      MemberAccountGetResultSchema.safeParse({
        ...result,
        recent: [{ ...result.recent[0], tender: "cash" }],
      }).success,
    ).toBe(false);
    expect(
      MemberAccountGetResultSchema.safeParse({
        ...result,
        recent: [...result.recent, result.recent[0]],
      }).success,
    ).toBe(false);
    expect(
      MemberAccountGetResultSchema.safeParse({
        ...result,
        account: { ...result.account, unexpected: true },
      }).success,
    ).toBe(false);
  });

  it("allows untouched legacy lifecycle evidence only as explicit nulls", () => {
    const legacyAccount = {
      account_id: ACCOUNT_ID,
      customer_id: CUSTOMER_ID,
      status: "active",
      status_version: 1,
      status_changed_at: null,
      status_reason: null,
      principal_cents: 0,
      bonus_cents: 0,
      balance_cents: 0,
    };
    expect(
      MemberAccountGetResultSchema.safeParse({
        account: legacyAccount,
        recent: [],
      }).success,
    ).toBe(true);
    expect(
      MemberAccountGetResultSchema.safeParse({
        account: { ...legacyAccount, status_changed_at: 1 },
        recent: [],
      }).success,
    ).toBe(false);
    expect(
      MemberAccountGetResultSchema.safeParse({
        account: { ...legacyAccount, status_reason: "挂失" },
        recent: [],
      }).success,
    ).toBe(false);
    expect(MemberAccountGetResultSchema.safeParse({ account: null, recent: [] }).success).toBe(
      true,
    );
    expect(
      MemberAccountGetResultSchema.safeParse({
        account: null,
        recent: [
          {
            ledger_id: LEDGER_ID,
            kind: "refund",
            principal_delta_cents: -1,
            bonus_delta_cents: 0,
            order_id: null,
            store_id: STORE_ID,
            tender: "cash",
            bonus_rule_id: null,
            at: 1,
            business_date: "2026-08-07",
            note: null,
          },
        ],
      }).success,
    ).toBe(false);
  });
});

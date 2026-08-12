import { describe, expect, it } from "vitest";

import {
  MEMBER_BENEFIT_COMMAND_NAMES,
  MEMBER_BENEFIT_QUERY_NAMES,
  MemberAssetConsumeInputSchema,
  MemberBenefitCatalogResultSchema,
  MemberBenefitDefinitionUpsertInputSchema,
  MemberBenefitsGetInputSchema,
  MemberBenefitsResultSchema,
  MemberMembershipSetInputSchema,
  MemberPointsEarnInputSchema,
  memberAssetConsumeCommand,
  memberBenefitCatalogGetQuery,
  memberBenefitsGetQuery,
  memberPointsEarnCommand,
} from "../src/index.js";

const IDS = Object.freeze({
  account: "11111111-1111-4111-8111-111111111111",
  customer: "22222222-2222-4222-8222-222222222222",
  definition: "33333333-3333-4333-8333-333333333333",
  asset: "44444444-4444-4444-8444-444444444444",
  order: "55555555-5555-4555-8555-555555555555",
  ledger: "66666666-6666-4666-8666-666666666666",
});

describe("ADR-41 member benefit contracts", () => {
  it("keeps definition variants strict and version guarded", () => {
    const tier = {
      definition: {
        kind: "tier" as const,
        expected_version: 0,
        code: "gold",
        name: " 金卡 ",
        level: 3,
        discount_bps: 0,
        status: "active" as const,
      },
    };
    expect(MemberBenefitDefinitionUpsertInputSchema.parse(tier)).toMatchObject({
      definition: { code: "gold", name: "金卡" },
    });

    for (const invalid of [
      { ...tier, org_id: IDS.customer },
      { ...tier, points: 999 },
      { definition: { ...tier.definition, expected_version: 1 } },
      {
        definition: {
          ...tier.definition,
          definition_id: IDS.definition,
          expected_version: 0,
        },
      },
      { definition: { ...tier.definition, kind: "coupon_type", discount_cents: 1 } },
    ]) {
      expect(MemberBenefitDefinitionUpsertInputSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("rejects client-computed points, discounts and malformed asset variants", () => {
    expect(
      MemberPointsEarnInputSchema.parse({ account_id: IDS.account, order_id: IDS.order }),
    ).toEqual({ account_id: IDS.account, order_id: IDS.order });
    expect(
      MemberPointsEarnInputSchema.safeParse({
        account_id: IDS.account,
        order_id: IDS.order,
        points: 10_000,
      }).success,
    ).toBe(false);

    expect(
      MemberAssetConsumeInputSchema.parse({
        asset: { asset_kind: "punch", asset_id: IDS.asset, uses: 2 },
        reason: " 衣物清洗 ",
      }),
    ).toEqual({
      asset: { asset_kind: "punch", asset_id: IDS.asset, uses: 2 },
      reason: "衣物清洗",
    });
    expect(
      MemberAssetConsumeInputSchema.parse({
        asset: { asset_kind: "coupon", asset_id: IDS.asset, order_id: IDS.order },
      }),
    ).toEqual({
      asset: { asset_kind: "coupon", asset_id: IDS.asset, order_id: IDS.order },
    });

    for (const invalid of [
      { asset: { asset_kind: "punch", asset_id: IDS.asset, uses: 1 } },
      {
        asset: { asset_kind: "coupon", asset_id: IDS.asset, order_id: IDS.order },
        reason: "not allowed",
      },
      {
        asset: {
          asset_kind: "coupon",
          asset_id: IDS.asset,
          order_id: IDS.order,
          discount_cents: 50_000,
        },
      },
      {
        asset: { asset_kind: "punch", asset_id: IDS.asset, uses: 1, order_id: IDS.order },
        reason: "洗衣",
      },
    ]) {
      expect(MemberAssetConsumeInputSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("pairs tier assignment with validity and keeps reads tenant-free", () => {
    const assignment = {
      account_id: IDS.account,
      expected_version: 0,
      tier_id: IDS.definition,
      valid_until: "2027-08-11",
      reason: "首次升级",
    };
    expect(MemberMembershipSetInputSchema.parse(assignment)).toEqual(assignment);
    expect(
      MemberMembershipSetInputSchema.safeParse({ ...assignment, valid_until: null }).success,
    ).toBe(false);
    expect(
      MemberMembershipSetInputSchema.safeParse({
        ...assignment,
        tier_id: null,
        valid_until: null,
      }).success,
    ).toBe(true);
    expect(MemberBenefitsGetInputSchema.parse({ customer_id: IDS.customer })).toEqual({
      customer_id: IDS.customer,
    });
    expect(
      MemberBenefitsGetInputSchema.safeParse({
        customer_id: IDS.customer,
        store_id: IDS.definition,
      }).success,
    ).toBe(false);
  });

  it("validates exact catalog and member projections", () => {
    const tier = {
      definition_id: IDS.definition,
      code: "gold",
      name: "金卡",
      level: 3,
      discount_bps: 0,
      status: "active" as const,
      version: 1,
      note: null,
    };
    expect(
      MemberBenefitCatalogResultSchema.parse({
        tiers: [tier],
        points_policy: {
          policy_id: IDS.asset,
          unit_cents: 100,
          points_per_unit: 1,
          valid_days: 365,
          status: "active",
          version: 1,
          note: null,
        },
        punch_types: [],
        coupon_types: [],
      }),
    ).toBeDefined();

    const result = {
      account_id: IDS.account,
      customer_id: IDS.customer,
      account_status: "active" as const,
      membership: {
        version: 1,
        tier: {
          definition_id: IDS.definition,
          code: "gold",
          name: "金卡",
          level: 3,
          discount_bps: 0,
        },
        valid_until: "2027-08-11",
        status: "active" as const,
      },
      points: {
        available_points: 8,
        lifetime_earned_points: 10,
        recent: [
          {
            ledger_id: IDS.ledger,
            kind: "earn" as const,
            points_delta: 10,
            order_id: IDS.order,
            expires_on: "2027-08-11",
            at: 1_786_080_000,
            note: null,
          },
        ],
      },
      punch_cards: [],
      coupons: [
        {
          asset_id: IDS.asset,
          definition_id: IDS.definition,
          code: "welcome",
          name: "迎新券",
          discount_cents: 500,
          min_order_cents: 1_000,
          granted_on: "2026-08-11",
          expires_on: "2026-09-10",
          status: "active" as const,
          redeemed_order_id: null,
        },
      ],
    };
    expect(MemberBenefitsResultSchema.parse(result)).toEqual(result);
    expect(
      MemberBenefitsResultSchema.safeParse({
        ...result,
        points: { ...result.points, available_points: 11 },
      }).success,
    ).toBe(false);
    expect(
      MemberBenefitsResultSchema.safeParse({
        ...result,
        coupons: [{ ...result.coupons[0], status: "redeemed" }],
      }).success,
    ).toBe(false);
  });

  it("freezes the online-only, non-AI surface", () => {
    expect(MEMBER_BENEFIT_COMMAND_NAMES).toEqual([
      "member.benefit_definition.upsert",
      "member.membership.set",
      "member.points.earn",
      "member.points.redeem",
      "member.asset.grant",
      "member.asset.consume",
    ]);
    expect(MEMBER_BENEFIT_QUERY_NAMES).toEqual([
      "member.benefit_catalog.get",
      "member.benefits.get",
    ]);
    expect(memberPointsEarnCommand).toMatchObject({ risk: "R2", offline_mode: "denied" });
    expect(memberAssetConsumeCommand).toMatchObject({
      risk: "R2",
      offline_mode: "denied",
      input_redaction: [{ path: "/reason", strategy: "mask" }],
    });
    expect(memberBenefitCatalogGetQuery).toMatchObject({ risk: "R1", max_result_rows: 151 });
    expect(memberBenefitsGetQuery).toMatchObject({ risk: "R1", max_result_rows: 151 });
  });
});

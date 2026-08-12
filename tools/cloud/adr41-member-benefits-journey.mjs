import { asRecord, requireInteger, requireThat, requireUuid } from "./adr36-web-core.mjs";
import { orderArgs, writeMutation } from "./adr36-web-journey-support.mjs";
import {
  MEMBER_BENEFIT_TEST_POLICY as POLICY,
  findMemberBenefitByCode as findByCode,
  memberBenefitJourneyContext as journeyContext,
  memberBenefitMutation as mutationBenefits,
  readMemberBenefitCatalog as readCatalog,
  restoredPolicy as policyUpdate,
  retiredDefinition,
} from "./adr41-member-benefits-support.mjs";

export function createMemberBenefitsJourney(options) {
  const context = journeyContext(options);
  const codes = Object.freeze({
    tier: `${context.codeBase}_tier`,
    punch: `${context.codeBase}_punch`,
    coupon: `${context.codeBase}_coupon`,
  });
  const definitions = Object.freeze({
    tier: Object.freeze({
      kind: "tier",
      expected_version: 0,
      code: codes.tier,
      name: "ADR41 UAT 等级",
      level: 9,
      discount_bps: 0,
      status: "active",
      note: context.note,
    }),
    punch: Object.freeze({
      kind: "punch_type",
      expected_version: 0,
      code: codes.punch,
      name: "ADR41 UAT 次卡",
      total_uses: 3,
      valid_days: 30,
      status: "active",
      note: context.note,
    }),
    coupon: Object.freeze({
      kind: "coupon_type",
      expected_version: 0,
      code: codes.coupon,
      name: "ADR41 UAT 优惠券",
      discount_cents: 500,
      min_order_cents: 1_000,
      valid_days: 30,
      status: "active",
      note: context.note,
    }),
  });
  let state = Object.freeze({
    phase: "ready",
    definitionsStarted: false,
    originalPolicy: null,
    policyApplied: false,
    benefitOrderId: null,
    orderCancelled: false,
  });
  const updateState = (patch) => {
    state = Object.freeze({ ...state, ...patch });
  };
  const upsert = async (definition) => {
    const result = asRecord(
      await context.api.confirm(context.session, "member.benefit_definition.upsert", {
        definition,
      }),
      "MEMBER_BENEFIT_DEFINITION_INVALID",
    );
    return readCatalog(result.catalog);
  };

  const execute = async () => {
    requireThat(state.phase === "ready", "MEMBER_BENEFIT_JOURNEY_ALREADY_STARTED");
    updateState({ phase: "running" });
    const initial = readCatalog(
      await context.api.query(context.session, "member.benefit_catalog.get", {
        include_retired: true,
      }),
    );
    for (const [kind, code] of Object.entries(codes)) {
      const rows = kind === "tier" ? initial.tiers : initial[`${kind}_types`];
      requireThat(!rows.some((value) => asRecord(value).code === code), "MEMBER_BENEFIT_COLLISION");
    }
    updateState({
      definitionsStarted: true,
      originalPolicy:
        initial.points_policy === null
          ? null
          : Object.freeze({ ...asRecord(initial.points_policy) }),
    });
    const tierCatalog = await upsert(definitions.tier);
    const tier = findByCode(tierCatalog.tiers, codes.tier, "MEMBER_TIER_INVALID");
    updateState({ policyApplied: true });
    const policyCatalog = await upsert({
      ...POLICY,
      expected_version:
        state.originalPolicy === null
          ? 0
          : requireInteger(state.originalPolicy.version, "MEMBER_POINTS_POLICY_INVALID"),
      note: context.note,
    });
    requireThat(
      asRecord(policyCatalog.points_policy).status === "active",
      "MEMBER_POINTS_POLICY_INVALID",
    );
    const punchCatalog = await upsert(definitions.punch);
    const punchType = findByCode(
      punchCatalog.punch_types,
      codes.punch,
      "MEMBER_PUNCH_TYPE_INVALID",
    );
    const couponCatalog = await upsert(definitions.coupon);
    const couponType = findByCode(
      couponCatalog.coupon_types,
      codes.coupon,
      "MEMBER_COUPON_TYPE_INVALID",
    );

    const opened = asRecord(
      await writeMutation(
        context.update,
        { memberAccountLocator: { customerId: context.customerId, note: context.note } },
        () =>
          context.api.command(context.session, "member.account.open", {
            customer_id: context.customerId,
            note: context.note,
          }),
        (value) => {
          const record = asRecord(value);
          context.update({
            memberAccountId: requireUuid(record.account_id, "MEMBER_OPEN_INVALID"),
          });
          return record;
        },
      ),
    );
    const accountId = requireUuid(opened.account_id, "MEMBER_OPEN_INVALID");
    requireThat(opened.status === "active", "MEMBER_OPEN_INVALID");
    let benefits = mutationBenefits(
      await context.api.confirm(context.session, "member.membership.set", {
        account_id: accountId,
        expected_version: 0,
        tier_id: requireUuid(tier.definition_id, "MEMBER_TIER_INVALID"),
        valid_until: "2099-12-31",
        reason: context.note,
      }),
    );
    requireThat(asRecord(benefits.membership).status === "active", "MEMBER_MEMBERSHIP_INVALID");

    const earnBody = Object.freeze({ account_id: accountId, order_id: context.cashOrderId });
    await context.api.expectCommandFailure(
      context.session,
      "member.points.earn",
      { ...earnBody, points: 999_999 },
      "VALIDATION_FAILED",
    );
    benefits = mutationBenefits(
      await context.api.command(context.session, "member.points.earn", earnBody),
    );
    requireThat(asRecord(benefits.points).available_points === 26, "MEMBER_POINTS_EARN_INVALID");
    benefits = mutationBenefits(
      await context.api.command(context.session, "member.points.earn", earnBody),
    );
    requireThat(
      asRecord(benefits.points).available_points === 26,
      "MEMBER_POINTS_IDEMPOTENCY_INVALID",
    );
    benefits = mutationBenefits(
      await context.api.confirm(context.session, "member.points.redeem", {
        account_id: accountId,
        points: 1,
        reason: context.note,
      }),
    );
    requireThat(asRecord(benefits.points).available_points === 25, "MEMBER_POINTS_REDEEM_INVALID");

    benefits = mutationBenefits(
      await context.api.confirm(context.session, "member.asset.grant", {
        asset_kind: "punch",
        account_id: accountId,
        definition_id: requireUuid(punchType.definition_id, "MEMBER_PUNCH_TYPE_INVALID"),
        reason: context.note,
      }),
    );
    const punch = findByCode(benefits.punch_cards, codes.punch, "MEMBER_PUNCH_GRANT_INVALID");
    benefits = mutationBenefits(
      await context.api.command(context.session, "member.asset.consume", {
        asset: { asset_kind: "punch", asset_id: punch.asset_id, uses: 1 },
        reason: context.note,
      }),
    );
    requireThat(
      findByCode(benefits.punch_cards, codes.punch, "MEMBER_PUNCH_CONSUME_INVALID")
        .remaining_uses === 2,
      "MEMBER_PUNCH_CONSUME_INVALID",
    );

    benefits = mutationBenefits(
      await context.api.confirm(context.session, "member.asset.grant", {
        asset_kind: "coupon",
        account_id: accountId,
        definition_id: requireUuid(couponType.definition_id, "MEMBER_COUPON_TYPE_INVALID"),
        reason: context.note,
      }),
    );
    const coupon = findByCode(benefits.coupons, codes.coupon, "MEMBER_COUPON_GRANT_INVALID");
    const received = asRecord(
      await writeMutation(
        context.update,
        {
          benefitOrderLocator: {
            customerPhone: context.artifacts.customerPhone,
            note: context.note,
          },
        },
        () =>
          context.api.command(
            context.session,
            "order.receive",
            orderArgs(context.artifacts, context.run),
          ),
        (value) => {
          const record = asRecord(value);
          const orderId = requireUuid(record.order_id, "MEMBER_COUPON_ORDER_INVALID");
          updateState({ benefitOrderId: orderId });
          context.update({ benefitOrderId: orderId });
          return record;
        },
      ),
    );
    const benefitOrderId = requireUuid(received.order_id, "MEMBER_COUPON_ORDER_INVALID");
    const couponBody = Object.freeze({
      asset: { asset_kind: "coupon", asset_id: coupon.asset_id, order_id: benefitOrderId },
    });
    await context.api.expectCommandFailure(
      context.session,
      "member.asset.consume",
      { ...couponBody, discount_cents: 500 },
      "VALIDATION_FAILED",
    );
    benefits = mutationBenefits(
      await context.api.command(context.session, "member.asset.consume", couponBody),
    );
    requireThat(
      findByCode(benefits.coupons, codes.coupon, "MEMBER_COUPON_CONSUME_INVALID").status ===
        "redeemed",
      "MEMBER_COUPON_CONSUME_INVALID",
    );
    const discounted = asRecord(
      await context.api.query(context.session, "order.get", { order_id: benefitOrderId }),
    );
    requireThat(
      discounted.discount_cents === 500 &&
        discounted.payable_cents === 2_100 &&
        discounted.balance_cents === 2_100 &&
        discounted.paid_cents === 0,
      "MEMBER_COUPON_ORDER_INVALID",
    );
    await context.api.confirm(context.session, "order.cancel", {
      order_id: benefitOrderId,
      reason: context.note,
    });
    updateState({ orderCancelled: true, phase: "executed" });
  };

  const cleanup = async () => {
    if (!state.definitionsStarted) return true;
    try {
      if (state.benefitOrderId !== null && !state.orderCancelled) {
        const order = asRecord(
          await context.api.query(context.session, "order.get", { order_id: state.benefitOrderId }),
        );
        if (order.status === "open") {
          await context.api.confirm(context.session, "order.cancel", {
            order_id: state.benefitOrderId,
            reason: context.note,
          });
        }
      }
      let catalog = readCatalog(
        await context.api.query(context.session, "member.benefit_catalog.get", {
          include_retired: true,
        }),
      );
      for (const [kind, code, key] of [
        ["tier", codes.tier, "tiers"],
        ["punch_type", codes.punch, "punch_types"],
        ["coupon_type", codes.coupon, "coupon_types"],
      ]) {
        const row = findByCode(catalog[key], code, "MEMBER_BENEFIT_CLEANUP_INVALID");
        if (row.status === "active") catalog = await upsert(retiredDefinition(kind, row));
      }
      if (state.policyApplied) {
        const current = asRecord(catalog.points_policy, "MEMBER_BENEFIT_CLEANUP_INVALID");
        requireThat(
          current.unit_cents === POLICY.unit_cents &&
            current.points_per_unit === POLICY.points_per_unit &&
            current.valid_days === POLICY.valid_days &&
            current.note === context.note,
          "MEMBER_BENEFIT_POLICY_CHANGED",
        );
        const source = state.originalPolicy ?? { ...POLICY, status: "retired", note: context.note };
        await upsert(policyUpdate(current, source));
      }
      updateState({ phase: "cleaned" });
      return true;
    } catch {
      return false;
    }
  };

  return Object.freeze({ execute, cleanup });
}

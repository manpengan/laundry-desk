import {
  asRecord,
  requireInteger,
  requireString,
  requireThat,
  requireUuid,
} from "./adr36-web-core.mjs";
import { orderArgs } from "./adr36-web-journey-support.mjs";
import {
  findMemberBenefitByCode,
  readMemberBenefitCatalog,
} from "./adr41-member-benefits-support.mjs";
import {
  CUSTOMER_DISCOUNT_BPS,
  TIER_DISCOUNT_BPS,
  assertCustomerWaiverRejections,
  cancelCustomerProfileOrders,
  customerProfileJourneyContext,
  customerProfileSetBody,
  freezeCustomerProfileState,
  readCustomerProfile,
  readCustomerProfileMutationVersion,
  readPolicyOrder,
} from "./adr42-customer-profile-support.mjs";

export function createCustomerProfileJourney(options) {
  const context = customerProfileJourneyContext(options);
  let state = Object.freeze({
    phase: "ready",
    profileTouched: false,
    tierOrderId: null,
    customerOrderId: null,
  });
  const updateState = (patch) => {
    state = freezeCustomerProfileState(state, patch);
  };
  const commandWithCleanupIntent = async (locator, operation, register) => {
    context.update({ cleanupUncertain: true, ...locator });
    const value = await operation();
    const registered = register(value);
    context.update({ cleanupUncertain: false });
    return registered;
  };
  const receive = async (kind) =>
    asRecord(
      await commandWithCleanupIntent(
        { [`customerProfile${kind}OrderLocator`]: { note: context.note, phone: context.phone } },
        () =>
          context.api.command(
            context.session,
            "order.receive",
            orderArgs(context.orderArtifacts, context.orderRun),
          ),
        (value) => {
          const order = asRecord(value, "CUSTOMER_POLICY_ORDER_INVALID");
          const orderId = requireUuid(order.order_id, "CUSTOMER_POLICY_ORDER_INVALID");
          updateState({ [`${kind}OrderId`]: orderId });
          return order;
        },
      ),
      "CUSTOMER_POLICY_ORDER_INVALID",
    );

  const execute = async () => {
    requireThat(state.phase === "ready", "CUSTOMER_PROFILE_JOURNEY_ALREADY_STARTED");
    updateState({ phase: "running" });
    const initial = readCustomerProfile(
      await context.api.query(context.session, "customer.profile.get", {
        customer_id: context.customerId,
      }),
    );
    requireThat(
      initial.version === 0 &&
        initial.addresses.length === 0 &&
        initial.identifiers.length === 0 &&
        initial.discount_bps === null,
      "CUSTOMER_PROFILE_COLLISION",
    );
    await context.api.expectCommandFailure(
      context.session,
      "customer.profile.set",
      {
        ...customerProfileSetBody(context.customerId, 0, context, true),
        org_id: context.session.orgId,
      },
      "VALIDATION_FAILED",
    );
    updateState({ profileTouched: true });
    const profileVersion = readCustomerProfileMutationVersion(
      await commandWithCleanupIntent(
        {},
        () =>
          context.api.confirm(
            context.session,
            "customer.profile.set",
            customerProfileSetBody(context.customerId, 0, context, true),
          ),
        (value) => value,
      ),
    );
    requireThat(profileVersion === 1, "CUSTOMER_PROFILE_MUTATION_INVALID");
    const saved = readCustomerProfile(
      await context.api.query(context.session, "customer.profile.get", {
        customer_id: context.customerId,
      }),
    );
    requireThat(
      saved.version === 1 &&
        saved.addresses.length === 1 &&
        saved.identifiers.length === 1 &&
        asRecord(saved.addresses[0]).address === `ADR42 Synthetic Road ${context.suffix}` &&
        asRecord(saved.identifiers[0]).value === `UAT-${context.suffix.toUpperCase()}`,
      "CUSTOMER_PROFILE_READBACK_INVALID",
    );
    const search = asRecord(
      await context.api.query(context.session, "customer.search", {
        query: `uat ${context.suffix}`,
        limit: 10,
      }),
      "CUSTOMER_IDENTIFIER_SEARCH_INVALID",
    );
    requireThat(
      Array.isArray(search.customers) &&
        search.customers.some((value) => asRecord(value).customer_id === context.customerId) &&
        !JSON.stringify(search.customers).includes("identifier"),
      "CUSTOMER_IDENTIFIER_SEARCH_INVALID",
    );

    const benefits = asRecord(
      await context.api.query(context.session, "member.benefits.get", {
        customer_id: context.customerId,
      }),
      "CUSTOMER_TIER_INVALID",
    );
    const membership = asRecord(benefits.membership, "CUSTOMER_TIER_INVALID");
    const assignedTier = asRecord(membership.tier, "CUSTOMER_TIER_INVALID");
    const catalog = readMemberBenefitCatalog(
      await context.api.query(context.session, "member.benefit_catalog.get", {
        include_retired: true,
      }),
    );
    const tier = findMemberBenefitByCode(catalog.tiers, assignedTier.code, "CUSTOMER_TIER_INVALID");
    const updatedCatalog = asRecord(
      await context.api.confirm(context.session, "member.benefit_definition.upsert", {
        definition: {
          kind: "tier",
          definition_id: requireUuid(tier.definition_id, "CUSTOMER_TIER_INVALID"),
          expected_version: requireInteger(tier.version, "CUSTOMER_TIER_INVALID"),
          code: requireString(tier.code, "CUSTOMER_TIER_INVALID"),
          name: requireString(tier.name, "CUSTOMER_TIER_INVALID"),
          level: requireInteger(tier.level, "CUSTOMER_TIER_INVALID"),
          discount_bps: TIER_DISCOUNT_BPS,
          status: "active",
          note: context.note,
        },
      }),
      "CUSTOMER_TIER_INVALID",
    );
    requireThat(asRecord(updatedCatalog.catalog).tiers.length > 0, "CUSTOMER_TIER_INVALID");
    const membershipResult = asRecord(
      await context.api.confirm(context.session, "member.membership.set", {
        account_id: context.accountId,
        expected_version: requireInteger(membership.version, "CUSTOMER_TIER_INVALID"),
        tier_id: requireUuid(tier.definition_id, "CUSTOMER_TIER_INVALID"),
        valid_until: requireString(membership.valid_until, "CUSTOMER_TIER_INVALID"),
        reason: context.note,
      }),
      "CUSTOMER_TIER_INVALID",
    );
    const refreshedMembership = asRecord(
      asRecord(membershipResult.benefits, "CUSTOMER_TIER_INVALID").membership,
      "CUSTOMER_TIER_INVALID",
    );
    requireThat(
      asRecord(refreshedMembership.tier).discount_bps === TIER_DISCOUNT_BPS,
      "CUSTOMER_TIER_INVALID",
    );

    const tierReceive = await receive("tier");
    const tierOrderId = requireUuid(tierReceive.order_id, "CUSTOMER_POLICY_ORDER_INVALID");
    const tierOrder = readPolicyOrder(
      await context.api.query(context.session, "order.get", { order_id: tierOrderId }),
      {
        source: "tier",
        discountBps: TIER_DISCOUNT_BPS,
        profileVersion: 1,
      },
    );
    await assertCustomerWaiverRejections(context, tierOrder);
    await context.api.confirm(context.session, "order.cancel", {
      order_id: tierOrder.order_id,
      reason: context.note,
    });

    const discountVersion = readCustomerProfileMutationVersion(
      await commandWithCleanupIntent(
        {},
        () =>
          context.api.stepUp(
            context.session,
            "customer.discount_policy.set",
            {
              customer_id: context.customerId,
              expected_version: 1,
              discount_bps: CUSTOMER_DISCOUNT_BPS,
              reason: context.note,
            },
            context.approver.staffId,
            context.approverPin,
          ),
        (value) => value,
      ),
    );
    requireThat(discountVersion === 2, "CUSTOMER_DISCOUNT_MUTATION_INVALID");
    await context.api.expectCommandFailure(
      context.session,
      "order.receive",
      {
        ...orderArgs(context.orderArtifacts, context.orderRun),
        discount_bps: 1,
      },
      "VALIDATION_FAILED",
    );
    const customerReceive = await receive("customer");
    const customerOrderId = requireUuid(customerReceive.order_id, "CUSTOMER_POLICY_ORDER_INVALID");
    const customerOrder = readPolicyOrder(
      await context.api.query(context.session, "order.get", { order_id: customerOrderId }),
      {
        source: "customer",
        discountBps: CUSTOMER_DISCOUNT_BPS,
        profileVersion: 2,
      },
    );
    await assertCustomerWaiverRejections(context, customerOrder);
    const currentBenefits = asRecord(
      await context.api.query(context.session, "member.benefits.get", {
        customer_id: context.customerId,
      }),
      "CUSTOMER_COUPON_INVALID",
    );
    const coupons = currentBenefits.coupons;
    requireThat(Array.isArray(coupons), "CUSTOMER_COUPON_INVALID");
    const activeCoupon = coupons.find((value) => asRecord(value).status === "active");
    requireThat(activeCoupon !== undefined, "CUSTOMER_COUPON_INVALID");
    await context.api.expectCommandFailure(
      context.session,
      "member.asset.consume",
      {
        asset: {
          asset_kind: "coupon",
          asset_id: requireUuid(asRecord(activeCoupon).asset_id, "CUSTOMER_COUPON_INVALID"),
          order_id: requireUuid(customerOrder.order_id, "CUSTOMER_POLICY_ORDER_INVALID"),
        },
      },
      "INVARIANT_FAILED",
    );
    await context.api.confirm(context.session, "order.cancel", {
      order_id: customerOrder.order_id,
      reason: context.note,
    });
    updateState({ phase: "executed" });
  };

  const cleanup = async () => {
    if (!state.profileTouched) return true;
    try {
      await cancelCustomerProfileOrders(context, state);
      let current = readCustomerProfile(
        await context.api.query(context.session, "customer.profile.get", {
          customer_id: context.customerId,
        }),
      );
      const currentWaivers = asRecord(current.waivers, "CUSTOMER_PROFILE_CLEANUP_INVALID");
      const profileNeedsReset =
        current.addresses.length > 0 ||
        current.identifiers.length > 0 ||
        current.gender !== "unspecified" ||
        current.preferred_contact !== "none" ||
        current.service_note !== null ||
        currentWaivers.skip_ticket_print !== false ||
        currentWaivers.skip_label_print !== false ||
        currentWaivers.skip_rack_assignment !== false;
      if (profileNeedsReset) {
        readCustomerProfileMutationVersion(
          await context.api.confirm(
            context.session,
            "customer.profile.set",
            customerProfileSetBody(context.customerId, current.version, context, false),
          ),
        );
        current = readCustomerProfile(
          await context.api.query(context.session, "customer.profile.get", {
            customer_id: context.customerId,
          }),
        );
      }
      if (current.discount_bps !== null) {
        await context.api.stepUp(
          context.session,
          "customer.discount_policy.set",
          {
            customer_id: context.customerId,
            expected_version: current.version,
            discount_bps: null,
            reason: context.note,
          },
          context.approver.staffId,
          context.approverPin,
        );
      }
      const cleaned = readCustomerProfile(
        await context.api.query(context.session, "customer.profile.get", {
          customer_id: context.customerId,
        }),
      );
      const waivers = asRecord(cleaned.waivers, "CUSTOMER_PROFILE_CLEANUP_INVALID");
      requireThat(
        cleaned.addresses.length === 0 &&
          cleaned.identifiers.length === 0 &&
          cleaned.gender === "unspecified" &&
          cleaned.preferred_contact === "none" &&
          cleaned.service_note === null &&
          cleaned.discount_bps === null &&
          waivers.skip_ticket_print === false &&
          waivers.skip_label_print === false &&
          waivers.skip_rack_assignment === false,
        "CUSTOMER_PROFILE_CLEANUP_INVALID",
      );
      context.update({ cleanupUncertain: false });
      updateState({ phase: "cleaned" });
      return true;
    } catch {
      return false;
    }
  };

  return Object.freeze({ execute, cleanup });
}

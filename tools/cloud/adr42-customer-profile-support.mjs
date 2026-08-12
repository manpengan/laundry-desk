import {
  asRecord,
  requireInteger,
  requireString,
  requireThat,
  requireUuid,
} from "./adr36-web-core.mjs";

export const TIER_DISCOUNT_BPS = 800;
export const CUSTOMER_DISCOUNT_BPS = 1_250;
const ORIGINAL_CENTS = 2_600;

export function freezeCustomerProfileState(state, patch) {
  return Object.freeze({ ...state, ...patch });
}

export function readCustomerProfile(value) {
  const profile = asRecord(value, "CUSTOMER_PROFILE_INVALID");
  requireUuid(profile.customer_id, "CUSTOMER_PROFILE_INVALID");
  requireInteger(profile.version, "CUSTOMER_PROFILE_INVALID");
  requireThat(
    Array.isArray(profile.addresses) &&
      Array.isArray(profile.identifiers) &&
      typeof profile.waivers === "object" &&
      profile.waivers !== null,
    "CUSTOMER_PROFILE_INVALID",
  );
  return profile;
}

export function readCustomerProfileMutationVersion(value) {
  const result = asRecord(value, "CUSTOMER_PROFILE_MUTATION_INVALID");
  return requireInteger(result.version, "CUSTOMER_PROFILE_MUTATION_INVALID");
}

export function readPolicyOrder(value, expected) {
  const order = asRecord(value, "CUSTOMER_POLICY_ORDER_INVALID");
  const expectedDiscount = Math.floor((ORIGINAL_CENTS * expected.discountBps) / 10_000);
  const waivers = asRecord(order.waivers, "CUSTOMER_POLICY_ORDER_INVALID");
  requireThat(
    order.original_cents === ORIGINAL_CENTS &&
      order.discount_cents === expectedDiscount &&
      order.payable_cents === ORIGINAL_CENTS - expectedDiscount &&
      order.balance_cents === ORIGINAL_CENTS - expectedDiscount &&
      order.paid_cents === 0 &&
      order.discount_source === expected.source &&
      order.discount_bps === expected.discountBps &&
      order.customer_profile_version === expected.profileVersion &&
      waivers.skip_ticket_print === true &&
      waivers.skip_label_print === true &&
      waivers.skip_rack_assignment === true,
    "CUSTOMER_POLICY_ORDER_INVALID",
  );
  return order;
}

export function customerProfileSetBody(customerId, expectedVersion, context, populated) {
  return Object.freeze({
    customer_id: customerId,
    expected_version: expectedVersion,
    gender: populated ? "other" : "unspecified",
    preferred_contact: populated ? "wechat" : "none",
    service_note: populated ? context.note : null,
    waivers: Object.freeze({
      skip_ticket_print: populated,
      skip_label_print: populated,
      skip_rack_assignment: populated,
    }),
    addresses: populated
      ? Object.freeze([
          Object.freeze({
            label: "ADR42 合成地址",
            recipient: context.label,
            contact_phone: context.phone,
            address: `ADR42 Synthetic Road ${context.suffix}`,
            is_default: true,
          }),
        ])
      : Object.freeze([]),
    identifiers: populated
      ? Object.freeze([
          Object.freeze({ kind: "vehicle_plate", value: `UAT-${context.suffix.toUpperCase()}` }),
        ])
      : Object.freeze([]),
    reason: context.note,
  });
}

export function customerProfileJourneyContext(options) {
  const input = asRecord(options, "CUSTOMER_PROFILE_OPTIONS_INVALID");
  const api = asRecord(input.api, "CUSTOMER_PROFILE_API_INVALID");
  requireThat(
    ["command", "confirm", "expectCommandFailure", "query", "stepUp"].every(
      (method) => typeof api[method] === "function",
    ),
    "CUSTOMER_PROFILE_API_INVALID",
  );
  requireThat(typeof input.update === "function", "CUSTOMER_PROFILE_UPDATE_INVALID");
  const artifacts = asRecord(input.artifacts, "CUSTOMER_PROFILE_ARTIFACTS_INVALID");
  const run = asRecord(input.run, "CUSTOMER_PROFILE_RUN_INVALID");
  const label = requireString(run.label, "CUSTOMER_PROFILE_RUN_INVALID");
  const note = requireString(run.note, "CUSTOMER_PROFILE_RUN_INVALID");
  return Object.freeze({
    api,
    session: asRecord(input.adminSession, "CUSTOMER_PROFILE_SESSION_INVALID"),
    approver: asRecord(input.approverSession, "CUSTOMER_PROFILE_SESSION_INVALID"),
    approverPin: requireString(input.approverPin, "CUSTOMER_PROFILE_APPROVER_INVALID"),
    update: input.update,
    customerId: requireUuid(artifacts.customerId, "CUSTOMER_PROFILE_ARTIFACTS_INVALID"),
    phone: requireString(artifacts.customerPhone, "CUSTOMER_PROFILE_ARTIFACTS_INVALID"),
    accountId: requireUuid(artifacts.memberAccountId, "CUSTOMER_PROFILE_ARTIFACTS_INVALID"),
    label,
    note,
    suffix: requireString(run.catalogCode, "CUSTOMER_PROFILE_RUN_INVALID").slice(-12),
    orderArtifacts: artifacts,
    orderRun: Object.freeze({
      label,
      note,
      serviceCode: requireString(run.serviceCode, "CUSTOMER_PROFILE_RUN_INVALID"),
      categoryCode: requireString(run.categoryCode, "CUSTOMER_PROFILE_RUN_INVALID"),
    }),
  });
}

export async function assertCustomerWaiverRejections(context, order) {
  const orderId = requireUuid(order.order_id, "CUSTOMER_POLICY_ORDER_INVALID");
  for (const kind of ["xp58", "dl206"]) {
    await context.api.expectCommandFailure(
      context.session,
      "print.ticket.enqueue",
      { order_id: orderId, kind },
      "INVARIANT_FAILED",
    );
  }
  const garments = order.garments;
  requireThat(Array.isArray(garments) && garments.length === 1, "CUSTOMER_POLICY_ORDER_INVALID");
  await context.api.expectCommandFailure(
    context.session,
    "garment.rack.assign",
    {
      barcode: requireString(asRecord(garments[0]).barcode, "CUSTOMER_POLICY_ORDER_INVALID"),
      rack_zone: "UAT",
      rack_slot: context.suffix.slice(0, 8).toUpperCase(),
    },
    "INVARIANT_FAILED",
  );
}

export async function cancelCustomerProfileOrders(context, state) {
  for (const orderId of [state.tierOrderId, state.customerOrderId]) {
    if (orderId === null) continue;
    const order = asRecord(
      await context.api.query(context.session, "order.get", { order_id: orderId }),
    );
    if (order.status === "open") {
      await context.api.confirm(context.session, "order.cancel", {
        order_id: orderId,
        reason: context.note,
      });
    }
  }
}

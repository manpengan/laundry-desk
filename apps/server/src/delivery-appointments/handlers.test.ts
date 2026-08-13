import assert from "node:assert/strict";
import test from "node:test";

import { executeCommand } from "../bus/executor.js";
import type { ActorContext, CommandHandler } from "../bus/types.js";
import { HandlerCommandError } from "../bus/types.js";
import { FakeSqlClient } from "../db/fake-client.js";
import type { TenantContext } from "../db/types.js";
import { createMemoryDeliveryPolicyStore } from "../delivery-policy/memory-store.js";
import { createRegisteredM1Bus } from "../handlers/register-m1.js";
import { MemoryPendingActionStore } from "../pending-actions/store.js";
import {
  registerDeliveryAppointmentCommandHandlers,
  registerDeliveryAppointmentQueryHandlers,
  type DeliveryAppointmentHandlerDeps,
} from "./handlers.js";
import { createMemoryDeliveryAppointmentStore } from "./memory-store.js";
import type { DeliveryAddressResolver } from "./address-resolver.js";

const TENANT: TenantContext = Object.freeze({
  orgId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  storeId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  staffId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
});
const CUSTOMER_A = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const CUSTOMER_B = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const CUSTOMER_A_SOURCE = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const ADDRESS_A = "11111111-1111-4111-8111-111111111111";
const ADDRESS_B = "22222222-2222-4222-8222-222222222222";
const ADDRESS_A_SOURCE = "66666666-6666-4666-8666-666666666666";
const APPOINTMENT_A = "33333333-3333-4333-8333-333333333333";
const APPOINTMENT_B = "44444444-4444-4444-8444-444444444444";
const NOW = Math.floor(Date.parse("2026-01-04T00:00:00.000Z") / 1_000);
const MONDAY_SLOT = Math.floor(Date.parse("2026-01-05T01:00:00.000Z") / 1_000);
const MONDAY_LATER = MONDAY_SLOT + 3_600;

function addressResolver(addressAActive: () => boolean = () => true): DeliveryAddressResolver {
  const address = (addressId: string, label: string, isDefault: boolean) =>
    Object.freeze({ address_id: addressId, label, address: "fixture-only", is_default: isDefault });
  const load = (customerId: string) => {
    if (customerId === CUSTOMER_B) {
      return Object.freeze({
        customer_id: CUSTOMER_B,
        addresses: Object.freeze([address(ADDRESS_B, "B", true)]),
      });
    }
    if (customerId !== CUSTOMER_A && customerId !== CUSTOMER_A_SOURCE) return null;
    return Object.freeze({
      customer_id: CUSTOMER_A,
      addresses: Object.freeze([
        ...(addressAActive() ? [address(ADDRESS_A, "A", true)] : []),
        address(ADDRESS_A_SOURCE, "A 来源", false),
      ]),
    });
  };
  return Object.freeze({
    resolve: async (_client, _tenant, customerId, addressId) => {
      const result = load(customerId);
      return result?.addresses.some((candidate) => candidate.address_id === addressId) === true
        ? Object.freeze({ customer_id: result.customer_id, address_id: addressId })
        : null;
    },
    list: async (_client, _tenant, customerId) => load(customerId),
  });
}

function context(parsed: unknown, tenant: TenantContext = TENANT) {
  return Object.freeze({
    client: new FakeSqlClient(),
    tenant,
    actor: Object.freeze({
      staffId: tenant.staffId,
      deviceId: null,
      via: "ui" as const,
      permissions: Object.freeze(["delivery_read", "delivery_write"]),
    }),
    parsed,
  }) as unknown as Parameters<CommandHandler>[0];
}

async function harness(capacity = 1) {
  let featureEnabled = true;
  let addressAActive = true;
  const policy = createMemoryDeliveryPolicyStore();
  await policy.set({
    org_id: TENANT.orgId,
    store_id: TENANT.storeId,
    staff_id: TENANT.staffId,
    expected_version: 0,
    accepting_appointments: true,
    minimum_lead_minutes: 120,
    maximum_advance_days: 14,
    slot_minutes: 60,
    max_appointments_per_slot: capacity,
    service_areas: Object.freeze([
      Object.freeze({ code: "north", name: "北区", fee_cents: 800, is_active: true }),
    ]),
    weekly_windows: Object.freeze([
      Object.freeze({ weekday: 1, start_minute: 540, end_minute: 1_020 }),
    ]),
    updated_at: NOW,
  });
  const ids = [APPOINTMENT_A, APPOINTMENT_B];
  const deps: DeliveryAppointmentHandlerDeps = Object.freeze({
    store: createMemoryDeliveryAppointmentStore(),
    policy,
    addresses: addressResolver(() => addressAActive),
    featureEnabled: async () => featureEnabled,
    timeZone: async () => "Asia/Taipei",
    now: () => NOW,
    newId: () => ids.shift() ?? "55555555-5555-4555-8555-555555555555",
  });
  const byName = new Map<string, CommandHandler>();
  const registry = Object.freeze({
    registerHandler(name: string, handler: CommandHandler) {
      byName.set(name, handler);
    },
  });
  registerDeliveryAppointmentCommandHandlers(registry, deps);
  registerDeliveryAppointmentQueryHandlers(registry, deps);
  return Object.freeze({
    byName,
    deps,
    disable: () => {
      featureEnabled = false;
    },
    retireAddress: () => {
      addressAActive = false;
    },
  });
}

const createInput = (customerId = CUSTOMER_A, addressId = ADDRESS_A, start = MONDAY_SLOT) => ({
  customer_id: customerId,
  address_id: addressId,
  direction: "pickup",
  service_area_code: "north",
  requested_start_at: start,
  expected_policy_version: 1,
});

test("create reserves capacity with immutable fee and privacy-owned audit", async () => {
  const { byName } = await harness();
  const create = byName.get("delivery.appointment.create");
  assert.ok(create);
  const outcome = await create(context(createInput()));
  const appointment = (
    outcome.result as { appointment: { appointment_id: string; fee_cents: number } }
  ).appointment;
  assert.equal(appointment.appointment_id, APPOINTMENT_A);
  assert.equal(appointment.fee_cents, 800);
  assert.equal(outcome.privacySubjectCustomerId, CUSTOMER_A);
  assert.equal(outcome.audit?.entity, "delivery_appointment");
  assert.equal(outcome.events?.[0]?.type, "delivery.appointment.created");
  assert.equal(outcome.audit?.afterJson?.includes("fixture-only"), false);
});

test("canonical address query and create include an active merged-source address", async () => {
  const { byName } = await harness();
  const addresses = byName.get("delivery.appointment.addresses.list");
  const create = byName.get("delivery.appointment.create");
  assert.ok(addresses);
  assert.ok(create);
  const listed = await addresses(context({ customer_id: CUSTOMER_A_SOURCE }));
  assert.deepEqual(
    (listed.result as { customer_id: string; addresses: { address_id: string }[] }).customer_id,
    CUSTOMER_A,
  );
  assert.deepEqual(
    (listed.result as { addresses: { address_id: string }[] }).addresses.map(
      ({ address_id }) => address_id,
    ),
    [ADDRESS_A, ADDRESS_A_SOURCE],
  );
  const outcome = await create(context(createInput(CUSTOMER_A_SOURCE, ADDRESS_A_SOURCE)));
  assert.equal(
    (outcome.result as { appointment: { customer_id: string; address_id: string } }).appointment
      .customer_id,
    CUSTOMER_A,
  );
  assert.equal(
    (outcome.result as { appointment: { address_id: string } }).appointment.address_id,
    ADDRESS_A_SOURCE,
  );
});

test("capacity is authoritative and cancellation frees the slot while feature is off", async () => {
  const { byName, disable } = await harness();
  const create = byName.get("delivery.appointment.create");
  const cancel = byName.get("delivery.appointment.cancel");
  assert.ok(create);
  assert.ok(cancel);
  await create(context(createInput()));
  await assert.rejects(
    () => create(context(createInput(CUSTOMER_B, ADDRESS_B))),
    (error: unknown) =>
      error instanceof HandlerCommandError && error.commandError.code === "INVARIANT_FAILED",
  );
  const cancelled = await cancel(
    context({
      appointment_id: APPOINTMENT_A,
      customer_id: CUSTOMER_A,
      expected_version: 1,
      reason: "customer_request",
    }),
  );
  assert.equal(
    (cancelled.result as { appointment: { status: string } }).appointment.status,
    "cancelled",
  );
  const replacement = await create(context(createInput(CUSTOMER_B, ADDRESS_B)));
  const replacementAppointment = (
    replacement.result as { appointment: { appointment_id: string; customer_id: string } }
  ).appointment;
  assert.equal(replacementAppointment.customer_id, CUSTOMER_B);
  assert.notEqual(replacementAppointment.appointment_id, APPOINTMENT_A);
  disable();
  const disabledCancellation = await cancel(
    context({
      appointment_id: replacementAppointment.appointment_id,
      customer_id: CUSTOMER_B,
      expected_version: 1,
      reason: "store_request",
    }),
  );
  assert.equal(
    (disabledCancellation.result as { appointment: { status: string } }).appointment.status,
    "cancelled",
  );
});

test("reschedule atomically moves the hold and list/get remain current-store scoped", async () => {
  const { byName, deps } = await harness();
  const create = byName.get("delivery.appointment.create");
  const reschedule = byName.get("delivery.appointment.reschedule");
  const get = byName.get("delivery.appointment.get");
  const list = byName.get("delivery.appointments.list");
  assert.ok(create);
  assert.ok(reschedule);
  assert.ok(get);
  assert.ok(list);
  await create(context(createInput()));
  const moved = await reschedule(
    context({
      appointment_id: APPOINTMENT_A,
      customer_id: CUSTOMER_A,
      expected_version: 1,
      expected_policy_version: 1,
      requested_start_at: MONDAY_LATER,
    }),
  );
  assert.equal(
    (moved.result as { appointment: { scheduled_start_at: number; version: number } }).appointment
      .scheduled_start_at,
    MONDAY_LATER,
  );
  assert.equal((moved.result as { appointment: { version: number } }).appointment.version, 2);
  const originalSlot = await create(context(createInput(CUSTOMER_B, ADDRESS_B)));
  assert.equal(
    (originalSlot.result as { appointment: { scheduled_start_at: number } }).appointment
      .scheduled_start_at,
    MONDAY_SLOT,
  );
  const listed = await list(context({ customer_id: CUSTOMER_A, limit: 10 }));
  assert.equal((listed.result as { appointments: unknown[] }).appointments.length, 1);
  await assert.rejects(
    () =>
      get(
        context(
          { appointment_id: APPOINTMENT_A },
          { ...TENANT, storeId: "66666666-6666-4666-8666-666666666666" },
        ),
      ),
    (error: unknown) =>
      error instanceof HandlerCommandError && error.commandError.code === "RESOURCE_UNAVAILABLE",
  );
  assert.equal((await deps.store.list(TENANT.orgId, TENANT.storeId, { limit: 10 })).length, 2);
});

test("reschedule rejects a retired address while cancellation remains available", async () => {
  const { byName, retireAddress } = await harness();
  const create = byName.get("delivery.appointment.create");
  const reschedule = byName.get("delivery.appointment.reschedule");
  const cancel = byName.get("delivery.appointment.cancel");
  assert.ok(create);
  assert.ok(reschedule);
  assert.ok(cancel);
  await create(context(createInput()));
  retireAddress();
  await assert.rejects(
    () =>
      reschedule(
        context({
          appointment_id: APPOINTMENT_A,
          customer_id: CUSTOMER_A,
          expected_version: 1,
          expected_policy_version: 1,
          requested_start_at: MONDAY_LATER,
        }),
      ),
    (error: unknown) =>
      error instanceof HandlerCommandError && error.commandError.code === "INVARIANT_FAILED",
  );
  const cancelled = await cancel(
    context({
      appointment_id: APPOINTMENT_A,
      customer_id: CUSTOMER_A,
      expected_version: 1,
      reason: "store_request",
    }),
  );
  assert.equal(
    (cancelled.result as { appointment: { status: string } }).appointment.status,
    "cancelled",
  );
});

test("create rejects an address that is not active for the selected customer", async () => {
  const { byName } = await harness();
  const create = byName.get("delivery.appointment.create");
  assert.ok(create);
  await assert.rejects(
    () => create(context(createInput(CUSTOMER_A, ADDRESS_B))),
    (error: unknown) =>
      error instanceof HandlerCommandError && error.commandError.code === "INVARIANT_FAILED",
  );
});

test("R3 first-hop retry reuses one frozen pending card and creates no appointment", async () => {
  const { deps } = await harness();
  const pendingStore = new MemoryPendingActionStore();
  const { registry, chainHooks } = createRegisteredM1Bus(
    { deliveryAppointments: deps },
    pendingStore,
  );
  const actor: ActorContext = Object.freeze({
    staffId: TENANT.staffId,
    deviceId: null,
    via: "ui",
    permissions: Object.freeze(["delivery_write"]),
  });
  const options = Object.freeze({
    registry,
    chainHooks,
    pendingStore,
    actor,
    idempotencyKey: "77777777-7777-4777-8777-777777777777",
  });
  const first = await executeCommand(
    new FakeSqlClient(),
    TENANT,
    "delivery.appointment.create",
    createInput(),
    options,
  );
  const replay = await executeCommand(
    new FakeSqlClient(),
    TENANT,
    "delivery.appointment.create",
    createInput(),
    options,
  );
  assert.equal(first.ok, false);
  assert.equal(replay.ok, false);
  if (first.ok || replay.ok) return;
  const firstDetail = "detail" in first.error ? first.error.detail : undefined;
  const replayDetail = "detail" in replay.error ? replay.error.detail : undefined;
  assert.equal(firstDetail?.kind, "confirmation");
  if (firstDetail?.kind !== "confirmation" || replayDetail?.kind !== "confirmation") return;
  assert.equal(firstDetail.confirm_ref, replayDetail.confirm_ref);
  assert.equal(
    (await pendingStore.get(firstDetail.confirm_ref))?.privacySubjectCustomerId,
    CUSTOMER_A,
  );
  assert.equal(pendingStore.size(), 1);
  assert.equal((await deps.store.list(TENANT.orgId, TENANT.storeId, { limit: 10 })).length, 0);
});

import assert from "node:assert/strict";
import test from "node:test";

import type { DeliveryAppointment } from "@laundry/contracts";

import { executeCommand } from "../bus/executor.js";
import type { ActorContext, CommandHandler } from "../bus/types.js";
import { HandlerCommandError } from "../bus/types.js";
import { FakeSqlClient } from "../db/fake-client.js";
import type { TenantContext } from "../db/types.js";
import { createRegisteredM1Bus } from "../handlers/register-m1.js";
import type { GarmentRecord, OrderRecord } from "../order/types.js";
import { createMemoryFeaturesStore, type StoreFeatureFlags } from "../platform/features.js";
import { MemoryPendingActionStore } from "../pending-actions/store.js";
import {
  registerDeliveryOrderCommandHandlers,
  registerDeliveryOrderQueryHandlers,
  type DeliveryOrderHandlerDeps,
} from "./handlers.js";
import { createMemoryDeliveryOrderStore } from "./memory-store.js";

const TENANT: TenantContext = Object.freeze({
  orgId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  storeId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  staffId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
});
const CUSTOMER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const SOURCE_CUSTOMER = "dddddddd-dddd-4ddd-8ddd-ddddddddddde";
const MERGED_ROOT = "dddddddd-dddd-4ddd-8ddd-dddddddddddf";
const ORDER = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const DELIVERY_ORDER = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const PICKUP_APPOINTMENT = "11111111-1111-4111-8111-111111111111";
const RETURN_APPOINTMENT = "22222222-2222-4222-8222-222222222222";
const GARMENT = "33333333-3333-4333-8333-333333333333";
const NOW = 1_800_000_000;

function appointment(
  appointmentId: string,
  direction: "pickup" | "return",
  feeCents: number,
): DeliveryAppointment {
  return Object.freeze({
    appointment_id: appointmentId,
    customer_id: CUSTOMER,
    address_id: "44444444-4444-4444-8444-444444444444",
    direction,
    service_area_code: "north",
    scheduled_start_at: NOW + 3_600,
    scheduled_end_at: NOW + 7_200,
    fee_cents: feeCents,
    status: "scheduled",
    version: 1,
    policy_version: 1,
    created_at: NOW,
    updated_at: NOW,
    cancelled_at: null,
    cancellation_reason: null,
  });
}

function laundryOrder(status: "draft" | "open" | "closed" = "open", balanceCents = 0): OrderRecord {
  return {
    order_id: ORDER,
    org_id: TENANT.orgId,
    store_id: TENANT.storeId,
    ticket_no: status === "draft" ? null : "T-1",
    pickup_code: status === "draft" ? null : "123456",
    status,
    customer_id: CUSTOMER,
    customer_phone: null,
    customer_name: null,
    note: null,
    lines: Object.freeze([]),
    subtotal_cents: 0,
    original_cents: 0,
    discount_cents: 0,
    addon_cents: 0,
    urgent_cents: 0,
    freight_cents: 0,
    payable_cents: balanceCents,
    paid_cents: 0,
    balance_cents: balanceCents,
    created_at: NOW,
    updated_at: NOW,
    business_date: "2027-01-15",
    created_by_staff_id: TENANT.staffId,
  };
}

function garment(status: GarmentRecord["status"]): GarmentRecord {
  return {
    garment_id: GARMENT,
    order_id: ORDER,
    org_id: TENANT.orgId,
    store_id: TENANT.storeId,
    line_index: 0,
    seq: 1,
    barcode: "DELIVERY-1",
    service_code: "wash",
    category_code: "coat",
    unit_price_cents: 0,
    color: null,
    brand: null,
    status,
    custody_state: status === "lost" ? "exception" : "store",
    active_production_batch_id: null,
  };
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

async function harness(
  initialStatus: "draft" | "open" = "open",
  options: Readonly<{ canonical?: boolean; addressActive?: boolean }> = {},
) {
  let features: StoreFeatureFlags = Object.freeze({
    fulfillment: true,
    membership: false,
    shift_closing: false,
    delivery: true,
    marketing: false,
    ai: false,
  });
  let order = laundryOrder(initialStatus);
  let garments: readonly GarmentRecord[] = initialStatus === "open" ? [garment("ready")] : [];
  let canonicalRoot = CUSTOMER;
  const featureStore = createMemoryFeaturesStore({ [TENANT.storeId]: features });
  const appointments = new Map([
    [PICKUP_APPOINTMENT, appointment(PICKUP_APPOINTMENT, "pickup", 800)],
    [RETURN_APPOINTMENT, appointment(RETURN_APPOINTMENT, "return", 900)],
  ]);
  const store = createMemoryDeliveryOrderStore({
    features: featureStore,
    orders: Object.freeze({
      getOrder: async (orgId, storeId, orderId) =>
        orgId === TENANT.orgId && storeId === TENANT.storeId && orderId === ORDER ? order : null,
      listGarments: async (orgId, storeId, orderId) =>
        orgId === TENANT.orgId && storeId === TENANT.storeId && orderId === ORDER
          ? garments
          : Object.freeze([]),
    }),
    appointments: Object.freeze({
      get: async (orgId: string, storeId: string, appointmentId: string) =>
        orgId === TENANT.orgId && storeId === TENANT.storeId
          ? (appointments.get(appointmentId) ?? null)
          : null,
    }),
    ...(options.canonical
      ? {
          canonicalCustomerId: async (customerId: string) =>
            [CUSTOMER, SOURCE_CUSTOMER, MERGED_ROOT].includes(customerId)
              ? canonicalRoot
              : customerId,
        }
      : {}),
    ...(options.addressActive === undefined
      ? {}
      : {
          customerProfile: Object.freeze({
            get: async () =>
              Object.freeze({
                customer_id: canonicalRoot,
                version: 1,
                gender: "unspecified" as const,
                preferred_contact: "none" as const,
                service_note: null,
                waivers: Object.freeze({
                  skip_ticket_print: false,
                  skip_label_print: false,
                  skip_rack_assignment: false,
                }),
                discount_bps: null,
                addresses: options.addressActive
                  ? Object.freeze([
                      Object.freeze({
                        address_id: "44444444-4444-4444-8444-444444444444",
                        label: "测试地址",
                        recipient: null,
                        contact_phone: null,
                        address: "测试路 1 号",
                        is_default: true,
                      }),
                    ])
                  : Object.freeze([]),
                identifiers: Object.freeze([]),
                updated_at: NOW,
              }),
          }),
        }),
  });
  const deps: DeliveryOrderHandlerDeps = Object.freeze({
    store,
    now: () => NOW,
    newId: () => DELIVERY_ORDER,
  });
  const byName = new Map<string, CommandHandler>();
  const registry = Object.freeze({
    registerHandler(name: string, handler: CommandHandler) {
      byName.set(name, handler);
    },
  });
  registerDeliveryOrderCommandHandlers(registry, deps);
  registerDeliveryOrderQueryHandlers(registry, deps);
  return Object.freeze({
    byName,
    deps,
    setOrder: (next: OrderRecord) => {
      order = next;
    },
    setGarments: (next: readonly GarmentRecord[]) => {
      garments = Object.freeze([...next]);
    },
    setCanonicalRoot: (customerId: string) => {
      canonicalRoot = customerId;
    },
    disableDelivery: async () => {
      features = Object.freeze({ ...features, delivery: false });
      await featureStore.put?.(TENANT.storeId, features);
    },
  });
}

const dropoffCreate = (customerId = CUSTOMER) => ({
  laundry_order_id: ORDER,
  customer_id: customerId,
  collection_method: "store_dropoff",
  return_method: "delivery",
  return_appointment_id: RETURN_APPOINTMENT,
});

test("create derives customer, fee and initial state and emits privacy-owned audit/event", async () => {
  const { byName } = await harness();
  const create = byName.get("delivery.order.create");
  assert.ok(create);
  const outcome = await create(context(dropoffCreate()));
  const row = (outcome.result as { delivery_order: { status: string; total_fee_cents: number } })
    .delivery_order;
  assert.equal(row.status, "at_store");
  assert.equal(row.total_fee_cents, 900);
  assert.equal(outcome.privacySubjectCustomerId, CUSTOMER);
  assert.equal(outcome.audit?.entity, "delivery_order");
  assert.equal(outcome.events?.[0]?.type, "delivery.order.created");
});

test("create revalidates the appointment address at the delivery boundary", async () => {
  const { byName } = await harness("open", { addressActive: false });
  const create = byName.get("delivery.order.create");
  assert.ok(create);
  await assert.rejects(
    () => create(context(dropoffCreate())),
    (error: unknown) =>
      error instanceof HandlerCommandError && error.commandError.code === "INVARIANT_FAILED",
  );
});

test("canonical customer merge keeps transition and list authority stable", async () => {
  const { byName, deps, setCanonicalRoot } = await harness("open", { canonical: true });
  const create = byName.get("delivery.order.create");
  const transition = byName.get("delivery.order.transition");
  assert.ok(create);
  assert.ok(transition);
  await create(context(dropoffCreate(SOURCE_CUSTOMER)));
  setCanonicalRoot(MERGED_ROOT);
  await transition(
    context({
      delivery_order_id: DELIVERY_ORDER,
      customer_id: SOURCE_CUSTOMER,
      expected_version: 1,
      target_status: "return_scheduled",
    }),
  );
  const listed = await deps.store.list(TENANT.orgId, TENANT.storeId, {
    customer_id: SOURCE_CUSTOMER,
    limit: 10,
  });
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.status, "return_scheduled");
});

test("feature-off blocks create but does not strand an existing state transition", async () => {
  const { byName, disableDelivery } = await harness();
  const create = byName.get("delivery.order.create");
  const transition = byName.get("delivery.order.transition");
  assert.ok(create);
  assert.ok(transition);
  await create(context(dropoffCreate()));
  await disableDelivery();
  const advanced = await transition(
    context({
      delivery_order_id: DELIVERY_ORDER,
      customer_id: CUSTOMER,
      expected_version: 1,
      target_status: "return_scheduled",
    }),
  );
  assert.equal(
    (advanced.result as { delivery_order: { status: string } }).delivery_order.status,
    "return_scheduled",
  );
});

test("CAS, legal transitions and terminal laundry authority fail closed", async () => {
  const { byName, setGarments, setOrder } = await harness();
  const create = byName.get("delivery.order.create");
  const transition = byName.get("delivery.order.transition");
  assert.ok(create);
  assert.ok(transition);
  await create(context(dropoffCreate()));
  for (const invalid of [
    { expected_version: 2, target_status: "return_scheduled" },
    { expected_version: 1, target_status: "completed" },
  ]) {
    await assert.rejects(
      () =>
        transition(
          context({ delivery_order_id: DELIVERY_ORDER, customer_id: CUSTOMER, ...invalid }),
        ),
      (error: unknown) =>
        error instanceof HandlerCommandError && error.commandError.code === "INVARIANT_FAILED",
    );
  }
  await transition(
    context({
      delivery_order_id: DELIVERY_ORDER,
      customer_id: CUSTOMER,
      expected_version: 1,
      target_status: "return_scheduled",
    }),
  );
  await transition(
    context({
      delivery_order_id: DELIVERY_ORDER,
      customer_id: CUSTOMER,
      expected_version: 2,
      target_status: "return_in_progress",
    }),
  );
  await assert.rejects(
    () =>
      transition(
        context({
          delivery_order_id: DELIVERY_ORDER,
          customer_id: CUSTOMER,
          expected_version: 3,
          target_status: "completed",
        }),
      ),
    (error: unknown) => error instanceof HandlerCommandError,
  );
  setGarments([garment("delivered")]);
  setOrder(laundryOrder("closed"));
  const completed = await transition(
    context({
      delivery_order_id: DELIVERY_ORDER,
      customer_id: CUSTOMER,
      expected_version: 3,
      target_status: "completed",
    }),
  );
  assert.equal(
    (completed.result as { delivery_order: { status: string } }).delivery_order.status,
    "completed",
  );
  await assert.rejects(
    () =>
      transition(
        context({
          delivery_order_id: DELIVERY_ORDER,
          customer_id: CUSTOMER,
          expected_version: 4,
          target_status: "cancelled",
          cancellation_reason: "other",
        }),
      ),
    (error: unknown) => error instanceof HandlerCommandError,
  );
});

test("pickup and self-pickup boundaries require their own authoritative legs", async () => {
  const { byName, setOrder, setGarments } = await harness("draft");
  const create = byName.get("delivery.order.create");
  const transition = byName.get("delivery.order.transition");
  assert.ok(create);
  assert.ok(transition);
  await create(
    context({
      laundry_order_id: ORDER,
      customer_id: CUSTOMER,
      collection_method: "pickup",
      return_method: "self_pickup",
      pickup_appointment_id: PICKUP_APPOINTMENT,
    }),
  );
  await transition(
    context({
      delivery_order_id: DELIVERY_ORDER,
      customer_id: CUSTOMER,
      expected_version: 1,
      target_status: "pickup_in_progress",
    }),
  );
  await transition(
    context({
      delivery_order_id: DELIVERY_ORDER,
      customer_id: CUSTOMER,
      expected_version: 2,
      target_status: "picked_up",
    }),
  );
  await transition(
    context({
      delivery_order_id: DELIVERY_ORDER,
      customer_id: CUSTOMER,
      expected_version: 3,
      target_status: "at_store",
    }),
  );
  setOrder(laundryOrder("open"));
  setGarments([garment("racked")]);
  await transition(
    context({
      delivery_order_id: DELIVERY_ORDER,
      customer_id: CUSTOMER,
      expected_version: 4,
      target_status: "self_pickup_ready",
    }),
  );
  setGarments([garment("picked_up")]);
  setOrder(laundryOrder("closed"));
  const completed = await transition(
    context({
      delivery_order_id: DELIVERY_ORDER,
      customer_id: CUSTOMER,
      expected_version: 5,
      target_status: "completed",
    }),
  );
  assert.equal(
    (completed.result as { delivery_order: { status: string } }).delivery_order.status,
    "completed",
  );
});

test("duplicate create, cross-customer and cross-store reads fail closed", async () => {
  const { byName } = await harness();
  const create = byName.get("delivery.order.create");
  const get = byName.get("delivery.order.get");
  assert.ok(create);
  assert.ok(get);
  await assert.rejects(
    () => create(context(dropoffCreate("77777777-7777-4777-8777-777777777777"))),
    (error: unknown) =>
      error instanceof HandlerCommandError && error.commandError.code === "INVARIANT_FAILED",
  );
  await create(context(dropoffCreate()));
  await assert.rejects(
    () => create(context(dropoffCreate())),
    (error: unknown) => error instanceof HandlerCommandError,
  );
  await assert.rejects(
    () =>
      get(
        context(
          { delivery_order_id: DELIVERY_ORDER },
          { ...TENANT, storeId: "55555555-5555-4555-8555-555555555555" },
        ),
      ),
    (error: unknown) =>
      error instanceof HandlerCommandError && error.commandError.code === "RESOURCE_UNAVAILABLE",
  );
});

test("R3 first-hop retry reuses one customer-bound pending card without creating a row", async () => {
  const { deps } = await harness();
  const pendingStore = new MemoryPendingActionStore();
  const { registry, chainHooks } = createRegisteredM1Bus({ deliveryOrders: deps }, pendingStore);
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
    idempotencyKey: "66666666-6666-4666-8666-666666666666",
  });
  const first = await executeCommand(
    new FakeSqlClient(),
    TENANT,
    "delivery.order.create",
    dropoffCreate(),
    options,
  );
  const replay = await executeCommand(
    new FakeSqlClient(),
    TENANT,
    "delivery.order.create",
    dropoffCreate(),
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
    CUSTOMER,
  );
  assert.equal((await deps.store.list(TENANT.orgId, TENANT.storeId, { limit: 10 })).length, 0);
});

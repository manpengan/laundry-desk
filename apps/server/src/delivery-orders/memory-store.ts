import type { DeliveryAppointment } from "@laundry/contracts";
import {
  DELIVERY_ORDER_TERMINAL_STATUSES,
  canTransitionDeliveryOrder,
  initialDeliveryOrderStatus,
} from "@laundry/domain";

import type { DeliveryAppointmentStore } from "../delivery-appointments/types.js";
import type { CustomerProfileStore } from "../customer-profile/types.js";
import type { OrderRecord, OrderStore } from "../order/types.js";
import type { FeaturesStore, StoreFeatureFlags } from "../platform/features.js";
import {
  createdDeliveryOrder,
  freezeDeliveryOrder,
  type DeliveryOrderCreateRequest,
  type DeliveryOrderListFilter,
  type DeliveryOrderMutationResult,
  type DeliveryOrderStore,
  type DeliveryOrderTransitionRequest,
} from "./types.js";

export type MemoryDeliveryOrderDeps = Readonly<{
  features: FeaturesStore;
  orders: Pick<OrderStore, "getOrder" | "listGarments">;
  appointments: Pick<DeliveryAppointmentStore, "get">;
  customerProfile?: Pick<CustomerProfileStore, "get">;
  canonicalCustomerId?: (customerId: string) => Promise<string | null>;
}>;

const key = (orgId: string, storeId: string, deliveryOrderId: string): string =>
  `${orgId}|${storeId}|${deliveryOrderId}`;

type StoredOrder = Readonly<{
  org_id: string;
  store_id: string;
  delivery_order: ReturnType<typeof freezeDeliveryOrder>;
}>;

function canonicalCustomerId(
  deps: MemoryDeliveryOrderDeps,
  customerId: string,
): Promise<string | null> {
  return deps.canonicalCustomerId?.(customerId) ?? Promise.resolve(customerId);
}

async function appointmentFor(
  deps: MemoryDeliveryOrderDeps,
  request: DeliveryOrderCreateRequest,
  appointmentId: string | null,
  direction: DeliveryAppointment["direction"],
  customerId: string,
): Promise<DeliveryAppointment | null> {
  if (appointmentId === null) return null;
  const appointment = await deps.appointments.get(request.org_id, request.store_id, appointmentId);
  if (appointment?.status !== "scheduled" || appointment.direction !== direction) return null;
  const appointmentCustomer = await canonicalCustomerId(deps, appointment.customer_id);
  if (appointmentCustomer !== customerId) return null;
  if (deps.customerProfile !== undefined) {
    const profile = await deps.customerProfile.get(customerId);
    if (!profile?.addresses.some(({ address_id }) => address_id === appointment.address_id)) {
      return null;
    }
  }
  return appointment;
}

async function deriveCreate(deps: MemoryDeliveryOrderDeps, request: DeliveryOrderCreateRequest) {
  const features = await deps.features.get(request.store_id);
  if (!features.delivery)
    return Object.freeze({ ok: false as const, reason: "feature_disabled" as const });
  const order = await deps.orders.getOrder(
    request.org_id,
    request.store_id,
    request.laundry_order_id,
  );
  if (order === null || order.customer_id === null) {
    return Object.freeze({ ok: false as const, reason: "link_invalid" as const });
  }
  const [orderCustomer, requestedCustomer] = await Promise.all([
    canonicalCustomerId(deps, order.customer_id),
    canonicalCustomerId(deps, request.customer_id),
  ]);
  if (
    orderCustomer === null ||
    requestedCustomer !== orderCustomer ||
    (request.collection_method === "pickup" ? order.status !== "draft" : order.status !== "open")
  ) {
    return Object.freeze({ ok: false as const, reason: "link_invalid" as const });
  }
  const [pickup, deliveryReturn] = await Promise.all([
    appointmentFor(deps, request, request.pickup_appointment_id, "pickup", orderCustomer),
    appointmentFor(deps, request, request.return_appointment_id, "return", orderCustomer),
  ]);
  if (
    (request.collection_method === "pickup") !== (pickup !== null) ||
    (request.return_method === "delivery") !== (deliveryReturn !== null)
  ) {
    return Object.freeze({ ok: false as const, reason: "link_invalid" as const });
  }
  const pickupFee = pickup?.fee_cents ?? 0;
  const returnFee = deliveryReturn?.fee_cents ?? 0;
  if (pickupFee + returnFee > 2_147_483_647) {
    return Object.freeze({ ok: false as const, reason: "link_invalid" as const });
  }
  return Object.freeze({
    ok: true as const,
    derived: Object.freeze({
      customer_id: orderCustomer,
      pickup_fee_cents: pickupFee,
      return_fee_cents: returnFee,
      status: initialDeliveryOrderStatus({
        collectionMethod: request.collection_method,
        returnMethod: request.return_method,
      }),
    }),
  });
}

function scoped(
  rows: Iterable<StoredOrder>,
  orgId: string,
  storeId: string,
): readonly StoredOrder[] {
  return [...rows].filter((row) => row.org_id === orgId && row.store_id === storeId);
}

function createDuplicates(
  rows: readonly StoredOrder[],
  request: DeliveryOrderCreateRequest,
): boolean {
  return rows.some(
    ({ delivery_order: row }) =>
      row.delivery_order_id === request.delivery_order_id ||
      (!DELIVERY_ORDER_TERMINAL_STATUSES.has(row.status) &&
        row.laundry_order_id === request.laundry_order_id) ||
      (request.pickup_appointment_id !== null &&
        row.pickup_appointment_id === request.pickup_appointment_id) ||
      (request.return_appointment_id !== null &&
        row.return_appointment_id === request.return_appointment_id),
  );
}

function readyAtStore(
  order: OrderRecord,
  garments: Awaited<ReturnType<OrderStore["listGarments"]>>,
  target: DeliveryOrderTransitionRequest["target_status"],
  features: StoreFeatureFlags,
): boolean {
  if (order.status !== "open" || garments.length === 0) return false;
  return garments.every((garment) => {
    if (garment.active_production_batch_id != null) return false;
    if (garment.status === "lost") return garment.custody_state === "exception";
    if (garment.custody_state !== undefined && garment.custody_state !== "store") return false;
    if (!features.fulfillment && garment.status === "received") return true;
    return target === "self_pickup_ready"
      ? garment.status === "racked"
      : garment.status === "ready" || garment.status === "racked";
  });
}

function terminalLaundryOrder(
  order: OrderRecord,
  garments: Awaited<ReturnType<OrderStore["listGarments"]>>,
  returnMethod: "delivery" | "self_pickup",
): boolean {
  const terminal = returnMethod === "delivery" ? "delivered" : "picked_up";
  return (
    order.status === "closed" &&
    order.balance_cents === 0 &&
    garments.length > 0 &&
    garments.every((garment) => garment.status === terminal || garment.status === "lost")
  );
}

async function transitionAuthority(
  deps: MemoryDeliveryOrderDeps,
  request: DeliveryOrderTransitionRequest,
  current: StoredOrder["delivery_order"],
): Promise<boolean> {
  if (current.status !== "at_store" && request.target_status !== "completed") return true;
  const order = await deps.orders.getOrder(
    request.org_id,
    request.store_id,
    current.laundry_order_id,
  );
  if (order === null) return false;
  const garments = await deps.orders.listGarments(
    request.org_id,
    request.store_id,
    current.laundry_order_id,
  );
  if (request.target_status === "completed") {
    return terminalLaundryOrder(order, garments, current.return_method);
  }
  const features = await deps.features.get(request.store_id);
  return readyAtStore(order, garments, request.target_status, features);
}

async function matchesFilter(
  deps: MemoryDeliveryOrderDeps,
  row: StoredOrder["delivery_order"],
  filter: DeliveryOrderListFilter,
  canonicalFilterCustomer: string | null | undefined,
): Promise<boolean> {
  const rowCustomer =
    canonicalFilterCustomer === undefined
      ? undefined
      : await canonicalCustomerId(deps, row.customer_id);
  return (
    (canonicalFilterCustomer === undefined || rowCustomer === canonicalFilterCustomer) &&
    (filter.laundry_order_id === undefined || row.laundry_order_id === filter.laundry_order_id) &&
    (filter.status === undefined || row.status === filter.status)
  );
}

export function createMemoryDeliveryOrderStore(deps: MemoryDeliveryOrderDeps): DeliveryOrderStore {
  const rows = new Map<string, StoredOrder>();
  return Object.freeze({
    async create(request): Promise<DeliveryOrderMutationResult> {
      const currentRows = scoped(rows.values(), request.org_id, request.store_id);
      if (createDuplicates(currentRows, request)) {
        return Object.freeze({ ok: false, reason: "duplicate" });
      }
      const decision = await deriveCreate(deps, request);
      if (!decision.ok) return decision;
      const deliveryOrder = createdDeliveryOrder(request, decision.derived);
      rows.set(
        key(request.org_id, request.store_id, request.delivery_order_id),
        Object.freeze({
          org_id: request.org_id,
          store_id: request.store_id,
          delivery_order: deliveryOrder,
        }),
      );
      return Object.freeze({ ok: true, delivery_order: deliveryOrder, before: null });
    },
    async transition(request): Promise<DeliveryOrderMutationResult> {
      const rowKey = key(request.org_id, request.store_id, request.delivery_order_id);
      const stored = rows.get(rowKey);
      if (stored === undefined) return Object.freeze({ ok: false, reason: "not_found" });
      const current = stored.delivery_order;
      const [currentCustomer, requestedCustomer] = await Promise.all([
        canonicalCustomerId(deps, current.customer_id),
        canonicalCustomerId(deps, request.customer_id),
      ]);
      if (
        current.version !== request.expected_version ||
        currentCustomer === null ||
        requestedCustomer !== currentCustomer ||
        request.at < current.updated_at ||
        !canTransitionDeliveryOrder(current.status, request.target_status, {
          collectionMethod: current.collection_method,
          returnMethod: current.return_method,
        }) ||
        !(await transitionAuthority(deps, request, current))
      ) {
        return Object.freeze({ ok: false, reason: "state_conflict" });
      }
      const completed = request.target_status === "completed";
      const cancelled = request.target_status === "cancelled";
      const next = freezeDeliveryOrder({
        ...current,
        status: request.target_status,
        version: current.version + 1,
        updated_at: request.at,
        completed_at: completed ? request.at : null,
        cancelled_at: cancelled ? request.at : null,
        cancellation_reason: cancelled ? request.cancellation_reason : null,
      });
      rows.set(rowKey, Object.freeze({ ...stored, delivery_order: next }));
      return Object.freeze({ ok: true, delivery_order: next, before: current });
    },
    async get(orgId, storeId, deliveryOrderId) {
      return rows.get(key(orgId, storeId, deliveryOrderId))?.delivery_order ?? null;
    },
    async list(orgId, storeId, filter) {
      const canonicalFilterCustomer =
        filter.customer_id === undefined
          ? undefined
          : await canonicalCustomerId(deps, filter.customer_id);
      if (canonicalFilterCustomer === null) return Object.freeze([]);
      const candidates = scoped(rows.values(), orgId, storeId).map(
        ({ delivery_order }) => delivery_order,
      );
      const decisions = await Promise.all(
        candidates.map((row) => matchesFilter(deps, row, filter, canonicalFilterCustomer)),
      );
      return Object.freeze(
        candidates
          .filter((_row, index) => decisions[index] === true)
          .sort(
            (left, right) =>
              right.updated_at - left.updated_at ||
              left.delivery_order_id.localeCompare(right.delivery_order_id),
          )
          .slice(0, filter.limit),
      );
    },
  });
}

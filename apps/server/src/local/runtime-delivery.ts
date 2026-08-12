import type { CustomerProfileStore } from "../customer-profile/types.js";
import type { CustomerStore } from "../customer/types.js";
import {
  createMemoryDeliveryAppointmentRuntime,
  createPgDeliveryAppointmentRuntime,
} from "../delivery-appointments/runtime.js";
import {
  createMemoryDeliveryPolicyRuntime,
  createPgDeliveryPolicyRuntime,
} from "../delivery-policy/runtime.js";
import type { PgPool } from "../db/pg-pool.js";
import type { FeaturesStore } from "../platform/features.js";
import type { OrderStore } from "../order/types.js";
import {
  createMemoryDeliveryOrderRuntime,
  createPgDeliveryOrderRuntime,
} from "../delivery-orders/runtime.js";

export function createMemoryDeliveryRuntimes(
  features: FeaturesStore,
  timeZone: string,
  customerProfile: CustomerProfileStore,
  customers: CustomerStore,
  orders: OrderStore,
) {
  const policy = createMemoryDeliveryPolicyRuntime(features, timeZone);
  const appointments = createMemoryDeliveryAppointmentRuntime(policy, customerProfile);
  return Object.freeze({
    policy,
    appointments,
    orders: createMemoryDeliveryOrderRuntime(
      features,
      orders,
      appointments.store,
      customerProfile,
      customers,
    ),
  });
}

export function createPgDeliveryRuntimes(pool: PgPool) {
  const policy = createPgDeliveryPolicyRuntime(pool);
  return Object.freeze({
    policy,
    appointments: createPgDeliveryAppointmentRuntime(pool, policy),
    orders: createPgDeliveryOrderRuntime(pool),
  });
}

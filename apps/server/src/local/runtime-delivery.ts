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
import { bindMemoryDeliveryTaskOrderAuthority } from "../delivery-tasks/order-authority.js";
import {
  createMemoryDeliveryTaskRuntime,
  createPgDeliveryTaskRuntime,
} from "../delivery-tasks/runtime.js";
import type { LocalStaffDirectoryEntry } from "./staff-directory.js";

export function createMemoryDeliveryRuntimes(
  features: FeaturesStore,
  timeZone: string,
  customerProfile: CustomerProfileStore,
  customers: CustomerStore,
  orders: OrderStore,
  staffDirectory: readonly LocalStaffDirectoryEntry[],
) {
  const policy = createMemoryDeliveryPolicyRuntime(features, timeZone);
  const appointments = createMemoryDeliveryAppointmentRuntime(policy, customerProfile);
  const deliveryOrders = createMemoryDeliveryOrderRuntime(
    features,
    orders,
    appointments.store,
    customerProfile,
    customers,
  );
  const tasks = createMemoryDeliveryTaskRuntime(deliveryOrders, staffDirectory);
  return Object.freeze({
    policy,
    appointments,
    orders: bindMemoryDeliveryTaskOrderAuthority(deliveryOrders, tasks.store),
    tasks,
  });
}

export function createPgDeliveryRuntimes(pool: PgPool) {
  const policy = createPgDeliveryPolicyRuntime(pool);
  const orders = createPgDeliveryOrderRuntime(pool);
  return Object.freeze({
    policy,
    appointments: createPgDeliveryAppointmentRuntime(pool, policy),
    orders,
    tasks: createPgDeliveryTaskRuntime(pool, orders),
  });
}

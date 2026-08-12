import type { PgPool } from "../db/pg-pool.js";
import type { DeliveryAppointmentStore } from "../delivery-appointments/types.js";
import type { CustomerProfileStore } from "../customer-profile/types.js";
import type { CustomerStore } from "../customer/types.js";
import type { OrderStore } from "../order/types.js";
import type { FeaturesStore } from "../platform/features.js";
import type { DeliveryOrderHandlerDeps } from "./handlers.js";
import { createMemoryDeliveryOrderStore } from "./memory-store.js";
import { createPgDeliveryOrderStore } from "./pg-store.js";

export function createMemoryDeliveryOrderRuntime(
  features: FeaturesStore,
  orders: OrderStore,
  appointments: DeliveryAppointmentStore,
  customerProfile: CustomerProfileStore,
  customers: CustomerStore,
): DeliveryOrderHandlerDeps {
  const canonicalCustomerId = customers.resolveCanonicalId?.bind(customers);
  return Object.freeze({
    store: createMemoryDeliveryOrderStore({
      features,
      orders,
      appointments,
      customerProfile,
      ...(canonicalCustomerId === undefined ? {} : { canonicalCustomerId }),
    }),
  });
}

export function createPgDeliveryOrderRuntime(pool: PgPool): DeliveryOrderHandlerDeps {
  return Object.freeze({ store: createPgDeliveryOrderStore(pool) });
}

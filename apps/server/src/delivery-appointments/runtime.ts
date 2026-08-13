import type { CustomerProfileStore } from "../customer-profile/types.js";
import type { PgPool } from "../db/pg-pool.js";
import type { DeliveryPolicyHandlerDeps } from "../delivery-policy/handlers.js";
import {
  createMemoryDeliveryAddressResolver,
  createPgDeliveryAddressResolver,
  type DeliveryAddressResolver,
} from "./address-resolver.js";
import type { DeliveryAppointmentHandlerDeps } from "./handlers.js";
import { createMemoryDeliveryAppointmentStore } from "./memory-store.js";
import { createPgDeliveryAppointmentStore } from "./pg-store.js";

function runtime(
  store: DeliveryAppointmentHandlerDeps["store"],
  deliveryPolicy: DeliveryPolicyHandlerDeps,
  addresses: DeliveryAddressResolver,
): DeliveryAppointmentHandlerDeps {
  return Object.freeze({
    store,
    policy: deliveryPolicy.store,
    addresses,
    featureEnabled: deliveryPolicy.featureEnabled,
    timeZone: deliveryPolicy.timeZone,
  });
}

export function createMemoryDeliveryAppointmentRuntime(
  deliveryPolicy: DeliveryPolicyHandlerDeps,
  customerProfile: CustomerProfileStore,
): DeliveryAppointmentHandlerDeps {
  return runtime(
    createMemoryDeliveryAppointmentStore(),
    deliveryPolicy,
    createMemoryDeliveryAddressResolver(customerProfile),
  );
}

export function createPgDeliveryAppointmentRuntime(
  pool: PgPool,
  deliveryPolicy: DeliveryPolicyHandlerDeps,
): DeliveryAppointmentHandlerDeps {
  return runtime(
    createPgDeliveryAppointmentStore(pool),
    deliveryPolicy,
    createPgDeliveryAddressResolver(),
  );
}

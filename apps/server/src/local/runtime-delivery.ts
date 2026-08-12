import type { CustomerProfileStore } from "../customer-profile/types.js";
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

export function createMemoryDeliveryRuntimes(
  features: FeaturesStore,
  timeZone: string,
  customerProfile: CustomerProfileStore,
) {
  const policy = createMemoryDeliveryPolicyRuntime(features, timeZone);
  return Object.freeze({
    policy,
    appointments: createMemoryDeliveryAppointmentRuntime(policy, customerProfile),
  });
}

export function createPgDeliveryRuntimes(pool: PgPool) {
  const policy = createPgDeliveryPolicyRuntime(pool);
  return Object.freeze({
    policy,
    appointments: createPgDeliveryAppointmentRuntime(pool, policy),
  });
}

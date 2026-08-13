import type { PgPool } from "../db/pg-pool.js";
import { createSqlFeaturesStore, type FeaturesStore } from "../platform/features.js";
import { readPgStoreTimeZone } from "../store-management/time-zone.js";
import type { DeliveryPolicyHandlerDeps } from "./handlers.js";
import { createMemoryDeliveryPolicyStore } from "./memory-store.js";
import { createPgDeliveryPolicyStore } from "./pg-store.js";

export function createMemoryDeliveryPolicyRuntime(
  features: FeaturesStore,
  timeZone: string,
): DeliveryPolicyHandlerDeps {
  return Object.freeze({
    store: createMemoryDeliveryPolicyStore(),
    featureEnabled: async (_client, tenant) => (await features.get(tenant.storeId)).delivery,
    timeZone: async () => timeZone,
  });
}

export function createPgDeliveryPolicyRuntime(pool: PgPool): DeliveryPolicyHandlerDeps {
  return Object.freeze({
    store: createPgDeliveryPolicyStore(pool),
    featureEnabled: async (client, tenant) =>
      (await createSqlFeaturesStore(client, tenant).get(tenant.storeId)).delivery,
    timeZone: readPgStoreTimeZone,
  });
}

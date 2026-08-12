import type { PgPool } from "../db/pg-pool.js";
import type { TenantContext } from "../db/types.js";
import type { OrderStore } from "../order/types.js";
import type { FeaturesStore } from "../platform/features.js";
import { acquirePgBusinessDayLock } from "../workday/business-day-lock.js";
import type { FulfillmentHandlerDeps } from "./handlers.js";
import { createMemoryFulfillmentStore } from "./memory-store.js";
import { createPgFulfillmentStore } from "./pg-store.js";

type RuntimeInput = Readonly<{
  order: Pick<OrderStore, "getOrder" | "lookupOrderSummaries">;
  timeZone: string;
  isBusinessDayClosed: (businessDate: string) => Promise<boolean>;
}>;

export function createMemoryFulfillmentRuntime(
  input: RuntimeInput & Readonly<{ features: FeaturesStore }>,
): FulfillmentHandlerDeps {
  return Object.freeze({
    store: createMemoryFulfillmentStore(),
    order: input.order,
    timeZone: input.timeZone,
    isBusinessDayClosed: input.isBusinessDayClosed,
    featureEnabled: async (_client, tenant: TenantContext) =>
      (await input.features.get(tenant.storeId)).fulfillment,
  });
}

export function createPgFulfillmentRuntime(
  pool: PgPool,
  input: RuntimeInput,
): FulfillmentHandlerDeps {
  return Object.freeze({
    store: createPgFulfillmentStore(pool),
    order: input.order,
    timeZone: input.timeZone,
    lockBusinessDay: acquirePgBusinessDayLock,
    isBusinessDayClosed: input.isBusinessDayClosed,
    featureEnabled: async (client, tenant) => {
      const result = await client.query<Readonly<{ fulfillment: boolean }>>(
        `SELECT fulfillment
           FROM store_features
          WHERE org_id = $1::uuid AND store_id = $2::uuid
          LIMIT 1`,
        [tenant.orgId, tenant.storeId],
      );
      return result.rows[0]?.fulfillment === true;
    },
  });
}

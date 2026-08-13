import type { PgPool } from "../db/pg-pool.js";
import type { DeliveryOrderHandlerDeps } from "../delivery-orders/handlers.js";
import type { DeliveryTaskHandlerDeps } from "../delivery-tasks/handlers.js";
import type { DeliveryEvidenceHandlerDeps } from "./handlers.js";
import { createMemoryDeliveryEvidenceStore } from "./memory-store.js";
import { createPgDeliveryEvidenceStore } from "./pg-store.js";

export function createMemoryDeliveryEvidenceRuntime(
  orders: DeliveryOrderHandlerDeps,
  tasks: DeliveryTaskHandlerDeps,
): DeliveryEvidenceHandlerDeps {
  return Object.freeze({
    store: createMemoryDeliveryEvidenceStore(orders.store, tasks.store),
    orders: orders.store,
  });
}

export function createPgDeliveryEvidenceRuntime(
  pool: PgPool,
  orders: DeliveryOrderHandlerDeps,
): DeliveryEvidenceHandlerDeps {
  return Object.freeze({ store: createPgDeliveryEvidenceStore(pool), orders: orders.store });
}

import type { PgPool } from "../db/pg-pool.js";
import type { DeliveryOrderHandlerDeps } from "../delivery-orders/handlers.js";
import type { LocalStaffDirectoryEntry } from "../local/staff-directory.js";
import type { DeliveryTaskHandlerDeps } from "./handlers.js";
import { createMemoryDeliveryTaskStore } from "./memory-store.js";
import { createPgDeliveryTaskStore } from "./pg-store.js";

export function createMemoryDeliveryTaskRuntime(
  orders: DeliveryOrderHandlerDeps,
  staffDirectory: readonly LocalStaffDirectoryEntry[],
): DeliveryTaskHandlerDeps {
  const store = createMemoryDeliveryTaskStore({
    orders: orders.store,
    isActiveStaff: async (staffId, adminOnly) => {
      const staff = staffDirectory.find(({ staff_id }) => staff_id === staffId);
      return staff !== undefined && (!adminOnly || staff.role === "admin");
    },
  });
  return Object.freeze({ store, orders: orders.store });
}

export function createPgDeliveryTaskRuntime(
  pool: PgPool,
  orders: DeliveryOrderHandlerDeps,
): DeliveryTaskHandlerDeps {
  return Object.freeze({ store: createPgDeliveryTaskStore(pool), orders: orders.store });
}

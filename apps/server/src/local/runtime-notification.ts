import type { PgPool } from "../db/pg-pool.js";
import {
  SOFTWARE_ONLY_NOTIFICATION_CAPABILITY,
  createMemoryNotificationDeliveryStore,
  createMemoryNotificationStore,
  createNotificationWorkerController,
  createPgNotificationDeliveryStore,
  createPgNotificationStore,
  createSoftwareOnlyNotificationProvider,
} from "../notification/index.js";
import type { NotificationHandlerDeps } from "../notification/types.js";
import type { OrderStore } from "../order/types.js";
import type { NotificationProviderMode } from "./config.js";
import { LOCAL_PROFILE } from "./profile.js";

function withSoftwareWorker(
  store: NotificationHandlerDeps["store"],
  deliveryStore: ReturnType<typeof createPgNotificationDeliveryStore>,
): NotificationHandlerDeps {
  const provider = createSoftwareOnlyNotificationProvider();
  return Object.freeze({
    store,
    delivery: Object.freeze({
      store: deliveryStore,
      capability: SOFTWARE_ONLY_NOTIFICATION_CAPABILITY,
    }),
    worker: createNotificationWorkerController({
      store: deliveryStore,
      provider,
      tenant: Object.freeze({
        orgId: LOCAL_PROFILE.orgId,
        storeId: LOCAL_PROFILE.storeId,
        staffId: LOCAL_PROFILE.adminStaffId,
      }),
      workerId: `notification:${process.pid}`,
    }),
  });
}

export function createMemoryNotificationRuntime(
  orderStore: OrderStore,
  mode: NotificationProviderMode = "disabled",
): NotificationHandlerDeps {
  const store = createMemoryNotificationStore({ orderStore });
  if (mode === "disabled") return Object.freeze({ store });
  const deliveryStore = createMemoryNotificationDeliveryStore({
    reminderStore: store,
    orderStore,
  });
  const provider = createSoftwareOnlyNotificationProvider();
  return Object.freeze({
    store,
    delivery: Object.freeze({
      store: deliveryStore,
      capability: SOFTWARE_ONLY_NOTIFICATION_CAPABILITY,
    }),
    worker: createNotificationWorkerController({
      store: deliveryStore,
      provider,
      tenant: Object.freeze({
        orgId: LOCAL_PROFILE.orgId,
        storeId: LOCAL_PROFILE.storeId,
        staffId: LOCAL_PROFILE.adminStaffId,
      }),
      workerId: "notification:memory",
    }),
  });
}

export function createPgNotificationRuntime(
  pool: PgPool,
  mode: NotificationProviderMode,
): NotificationHandlerDeps {
  const store = createPgNotificationStore();
  if (mode === "disabled") return Object.freeze({ store });
  return withSoftwareWorker(store, createPgNotificationDeliveryStore(pool));
}

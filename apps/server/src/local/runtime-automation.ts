import { MemoryAutomationStore } from "../automation/memory-store.js";
import { createPgAutomationStore } from "../automation/pg-store.js";
import type { AutomationHandlerDeps } from "../automation/types.js";
import { createAutomationWorkerController } from "../automation/worker-controller.js";
import { createRuntimeBus } from "../bus/runtime.js";
import { FakeSqlClient } from "../db/fake-client.js";
import type { PgPool } from "../db/pg-pool.js";
import { withPoolClient } from "../db/pg-sql-client.js";
import type { NotificationHandlerDeps } from "../notification/types.js";
import type { PendingActionStore } from "../pending-actions/types.js";
import type { LocalRuntime } from "./runtime-types.js";
import { LOCAL_MEMORY_STAFF_DIRECTORY } from "./staff-directory.js";
import { LOCAL_PROFILE } from "./profile.js";

type CommonOptions = Readonly<{
  notification: NotificationHandlerDeps;
  pendingStore: PendingActionStore;
  runtime: () => LocalRuntime | null;
}>;

function busFrom(runtime: () => LocalRuntime | null) {
  const value = runtime();
  if (value === null) throw new Error("Automation runtime is not initialized");
  return createRuntimeBus(value);
}

export function createMemoryAutomationRuntime(options: CommonOptions): AutomationHandlerDeps {
  const store = new MemoryAutomationStore({
    timeZone: LOCAL_PROFILE.timezone,
    isActiveAdmin: (orgId, storeId, staffId) =>
      orgId === LOCAL_PROFILE.orgId &&
      storeId === LOCAL_PROFILE.storeId &&
      LOCAL_MEMORY_STAFF_DIRECTORY.some(
        (entry) => entry.staff_id === staffId && entry.role === "admin",
      ),
  });
  const client = new FakeSqlClient();
  return Object.freeze({
    store,
    worker: createAutomationWorkerController({
      store,
      notification: options.notification,
      pendingStore: options.pendingStore,
      runWithSql: (operation) => operation(client),
      now: () => new Date(),
      discoveryTenant: Object.freeze({
        orgId: LOCAL_PROFILE.orgId,
        storeId: LOCAL_PROFILE.storeId,
        staffId: LOCAL_PROFILE.adminStaffId,
      }),
      bus: () => busFrom(options.runtime),
    }),
  });
}

export function createPgAutomationRuntime(
  pool: PgPool,
  options: CommonOptions,
): AutomationHandlerDeps {
  const store = createPgAutomationStore();
  return Object.freeze({
    store,
    worker: createAutomationWorkerController({
      store,
      notification: options.notification,
      pendingStore: options.pendingStore,
      runWithSql: (operation) => withPoolClient(pool, operation),
      now: () => new Date(),
      discoveryTenant: Object.freeze({
        orgId: LOCAL_PROFILE.orgId,
        storeId: LOCAL_PROFILE.storeId,
        staffId: LOCAL_PROFILE.adminStaffId,
      }),
      bus: () => busFrom(options.runtime),
    }),
  });
}

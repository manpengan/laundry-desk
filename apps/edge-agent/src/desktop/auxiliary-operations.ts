import { createDesktopAiOperation } from "./ai-operation.js";
import { createDesktopMigrationOperation } from "./migration-operation.js";
import { createDesktopNotificationOperation } from "./notification-operation.js";
import { createDesktopStoreExportOperation } from "./store-export-operation.js";
import type { DesktopHttpTransportDependencies } from "./http-transport-ports.js";
import type { AuthState } from "./http-transport-support.js";
export function createDesktopAuxiliaryOperations(
  dependencies: DesktopHttpTransportDependencies,
  currentState: () => AuthState | null,
  refreshIfNeeded: (state: AuthState) => Promise<void>,
) {
  return Object.freeze({
    ai: createDesktopAiOperation(dependencies, currentState, refreshIfNeeded),
    migration: createDesktopMigrationOperation(dependencies, currentState, refreshIfNeeded),
    notificationSettings: createDesktopNotificationOperation(
      dependencies,
      currentState,
      refreshIfNeeded,
    ),
    storeExport: createDesktopStoreExportOperation(dependencies, currentState, refreshIfNeeded),
  });
}

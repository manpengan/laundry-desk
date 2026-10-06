import { createDesktopPaymentChannelOperation } from "./payment-channel-operation.js";
import { createDesktopMiniappSettingsOperation } from "./miniapp-settings-operation.js";
import { createDesktopMaintenanceOperation } from "./maintenance-operation.js";
import { createDesktopScaleOperation } from "./scale-operation.js";
import { createDesktopRemoteAssistanceOperation } from "./remote-assistance-operation.js";
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
    paymentChannel: createDesktopPaymentChannelOperation(
      dependencies,
      currentState,
      refreshIfNeeded,
    ),
    miniappSettings: createDesktopMiniappSettingsOperation(
      dependencies,
      currentState,
      refreshIfNeeded,
    ),
    remoteAssistance: createDesktopRemoteAssistanceOperation(
      dependencies,
      currentState,
      refreshIfNeeded,
    ),
    maintenance: createDesktopMaintenanceOperation(currentState),
    scale: createDesktopScaleOperation(currentState),
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

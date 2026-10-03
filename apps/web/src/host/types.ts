import type { AuthPort } from "../auth/AuthClient.js";
import type { ApprovalPort } from "../ai/approval-port.js";
import type { CommandPort, QueryPort } from "../commands/types.js";
import type { PhotoPort } from "./photo-port.js";
import type { OfflinePort } from "./offline-port.js";
import type { ResumePort } from "./desktop-resume-port.js";
import type { PrinterPort } from "./printer-port.js";
import type { DeliveryEvidenceMediaPort } from "./delivery-evidence-port.js";
import type { AiPanelPort } from "./ai-port.js";
import type { AiSettingsPort } from "../ai/settings-port.js";
import type { ScalePort } from "./scale-port.js";
import type { PaymentChannelPort } from "./payment-channel-port.js";
import type { MiniappSettingsPort } from "./miniapp-settings-port.js";
import type { RemoteAssistancePort } from "./remote-assistance-port.js";
import type { StoreExportPort } from "./store-export-port.js";
import type { MigrationPort } from "./migration-port.js";
import type { NotificationSettingsPort } from "./notification-settings-port.js";

export type HealthReady = Readonly<{
  status: "ready";
}>;

export type HealthError = Readonly<{
  code: "SERVICE_UNAVAILABLE";
  message: string;
}>;

export type HealthResult =
  Readonly<{ ok: true; data: HealthReady }> | Readonly<{ ok: false; error: HealthError }>;

export type HealthPort = Readonly<{
  get: () => Promise<HealthResult>;
}>;

/** All renderer-visible capabilities. No credential accessor is exposed here. */
export type AppPorts = Readonly<{
  auth: AuthPort;
  command: CommandPort;
  query: QueryPort;
  photo: PhotoPort;
  deliveryEvidence?: DeliveryEvidenceMediaPort;
  offline?: OfflinePort;
  resume?: ResumePort;
  printer?: PrinterPort;
  ai?: AiPanelPort;
  aiSettings?: AiSettingsPort;
  migration?: MigrationPort;
  storeExport?: StoreExportPort;
  scale?: ScalePort;
  paymentChannel?: PaymentChannelPort;
  miniappSettings?: MiniappSettingsPort;
  remoteAssistance?: RemoteAssistancePort;
  notificationSettings?: NotificationSettingsPort;
  approval?: ApprovalPort;
  health: HealthPort;
}>;

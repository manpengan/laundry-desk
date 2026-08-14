import type {
  NotificationDeliveryBatchEnqueueInput,
  NotificationDeliveryBatchEnqueueResult,
  NotificationDeliveryBatchGetResult,
  NotificationDeliveryBatchSummary,
  NotificationDeliveryCapabilityResult,
  PickupReminderCandidate,
} from "@laundry/contracts";

import type { SqlClient, TenantContext } from "../db/types.js";

export type NotificationTemplateSnapshot = Readonly<{
  id: string;
  code: "pickup_reminder_v1";
  version: number;
  channel: "sms";
  body: string;
}>;

export type NotificationDeliverySeed = Readonly<{
  id: string;
  candidate: PickupReminderCandidate & Readonly<{ customer_id: string }>;
  messageSha256: string;
}>;

export type NotificationDeliveryEnqueueRequest = Readonly<{
  client: SqlClient;
  tenant: TenantContext;
  batchId: string;
  input: NotificationDeliveryBatchEnqueueInput;
  template: NotificationTemplateSnapshot;
  providerCode: string;
  assurance: "software_only" | "external";
  estimatedCostCents: number;
  createdByStaffId: string;
  createdAt: Date;
  deliveries: readonly NotificationDeliverySeed[];
}>;

export type NotificationDeliveryStore = Readonly<{
  getActiveTemplate: (
    client: SqlClient,
    tenant: TenantContext,
    code: "pickup_reminder_v1",
  ) => Promise<NotificationTemplateSnapshot | null>;
  assertOrdersAvailable: (
    client: SqlClient,
    tenant: TenantContext,
    orderIds: readonly string[],
  ) => Promise<boolean>;
  enqueueBatch: (
    request: NotificationDeliveryEnqueueRequest,
  ) => Promise<NotificationDeliveryBatchEnqueueResult>;
  listBatches: (
    client: SqlClient,
    tenant: TenantContext,
    limit: number,
  ) => Promise<readonly NotificationDeliveryBatchSummary[]>;
  getBatch: (
    client: SqlClient,
    tenant: TenantContext,
    batchId: string,
  ) => Promise<NotificationDeliveryBatchGetResult | null>;
}>;

export type NotificationDeliveryHandlerDeps = Readonly<{
  store: NotificationDeliveryStore;
  capability: NotificationDeliveryCapabilityResult;
}>;

export type NotificationProviderSendInput = Readonly<{
  deliveryId: string;
  recipient: string;
  message: string;
  timeoutMs: number;
  deadline: Date;
  signal: AbortSignal;
}>;

export type NotificationProviderSendResult = Readonly<{
  outcome: "accepted" | "transient_failure" | "permanent_failure" | "uncertain";
  errorCode: string | null;
  providerRef: string | null;
  costCents: number;
}>;

export type NotificationProvider = Readonly<{
  code: string;
  assurance: "software_only" | "external";
  channel: "sms" | "wechat";
  maxBatchSize: number;
  supportsIdempotency: boolean;
  supportsCancellation: boolean;
  supportsReceipts: boolean;
  unitCostCents: number;
  maxBatchCostCents: number;
  send: (input: NotificationProviderSendInput) => Promise<NotificationProviderSendResult>;
}>;

export type NotificationDeliveryClaim = Readonly<{
  deliveryId: string;
  batchId: string;
  leaseToken: string;
  attemptNo: number;
  providerCode: string;
  assurance: "software_only" | "external";
  template: NotificationTemplateSnapshot;
  candidate: PickupReminderCandidate & Readonly<{ customer_id: string }>;
  expectedMessageSha256: string;
  batchEstimatedCostCents: number;
  batchRecipientCount: number;
  maxCostCents: number;
  spentCostCents: number;
  reservedCostCents: number;
}>;

export type NotificationAttemptSettlement = Readonly<{
  deliveryId: string;
  leaseToken: string;
  attemptNo: number;
  outcome: NotificationProviderSendResult["outcome"];
  errorCode: string | null;
  providerRefSha256: string | null;
  costCents: number;
  startedAt: Date;
  completedAt: Date;
}>;

export type NotificationReceiptInput = Readonly<{
  deliveryId: string;
  providerCode: string;
  receiptId: string;
  status: "delivered" | "failed";
  observedAt: Date;
  recordedAt: Date;
}>;

export type NotificationWorkerStore = Readonly<{
  claimNext: (
    tenant: TenantContext,
    workerId: string,
    now: Date,
  ) => Promise<NotificationDeliveryClaim | null>;
  settleAttempt: (
    tenant: TenantContext,
    settlement: NotificationAttemptSettlement,
  ) => Promise<"accepted" | "retry_wait" | "manual_required" | "stale_lease">;
  renewLease: (
    tenant: TenantContext,
    deliveryId: string,
    leaseToken: string,
    now: Date,
  ) => Promise<boolean>;
  expireAccepted: (tenant: TenantContext, now: Date, limit: number) => Promise<number>;
  applyReceipt: (
    tenant: TenantContext,
    receipt: NotificationReceiptInput,
  ) => Promise<"applied" | "pending" | "duplicate" | "ignored" | "not_found">;
}>;

import type { PickupReminderCandidate } from "@laundry/contracts";

import type { SqlClient, TenantContext } from "../db/types.js";
import type { OrderStore } from "../order/types.js";
import type { NotificationDeliveryHandlerDeps } from "./delivery-types.js";
import type { NotificationWorkerController } from "./delivery-worker-controller.js";

export type PickupReminderFilters = Readonly<{
  minAgeDays: 30 | 90 | 180;
  unpaidOnly: boolean;
  garmentStatuses: readonly ("ready" | "racked")[];
  limit: number;
}>;

export type PickupReminderListRequest = Readonly<{
  client: SqlClient;
  tenant: TenantContext;
  filters: PickupReminderFilters;
  now: Date;
  orderIds?: readonly string[];
}>;

export type NotificationLogWrite = Readonly<{
  id: string;
  batchId: string;
  orderId: string;
  customerId: string | null;
  grouping: "order" | "customer";
  messageSha256: string;
  exportSha256: string;
  staffId: string;
  createdAt: Date;
}>;

export type NotificationStore = Readonly<{
  listPickupReminders: (
    request: PickupReminderListRequest,
  ) => Promise<readonly PickupReminderCandidate[]>;
  lockOrders: (
    client: SqlClient,
    tenant: TenantContext,
    orderIds: readonly string[],
  ) => Promise<number>;
  appendManualList: (
    client: SqlClient,
    tenant: TenantContext,
    rows: readonly NotificationLogWrite[],
  ) => Promise<void>;
}>;

export type NotificationHandlerDeps = Readonly<{
  store: NotificationStore;
  delivery?: NotificationDeliveryHandlerDeps;
  worker?: NotificationWorkerController;
  now?: () => Date;
}>;

export type MemoryNotificationStoreOptions = Readonly<{
  orderStore: OrderStore;
}>;

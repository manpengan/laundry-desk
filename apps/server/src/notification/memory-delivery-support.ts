import { createHash } from "node:crypto";

import type { NotificationDeliveryStatus, PickupReminderCandidate } from "@laundry/contracts";
import {
  DEFAULT_PICKUP_REMINDER_TEMPLATE,
  groupPickupReminders,
  renderPickupReminder,
} from "@laundry/domain";

import type { OrderStore } from "../order/types.js";
import type {
  NotificationAttemptSettlement,
  NotificationDeliveryEnqueueRequest,
  NotificationReceiptInput,
  NotificationTemplateSnapshot,
} from "./delivery-types.js";
import type { NotificationStore, PickupReminderFilters } from "./types.js";

export const MEMORY_DELIVERY_LEASE_MS = 30_000;
export const MEMORY_RECEIPT_TIMEOUT_MS = 72 * 60 * 60 * 1_000;
export const MEMORY_RETRY_DELAYS_MS = Object.freeze([60_000, 300_000, 1_800_000, 7_200_000]);
export const MEMORY_NOTIFICATION_TEMPLATE: NotificationTemplateSnapshot = Object.freeze({
  id: "44444444-4444-4444-8444-444444444444",
  code: "pickup_reminder_v1",
  version: 1,
  channel: "sms",
  body: DEFAULT_PICKUP_REMINDER_TEMPLATE,
});

export type MemoryBatch = Readonly<{
  id: string;
  orgId: string;
  storeId: string;
  providerCode: string;
  assurance: "software_only" | "external";
  template: NotificationTemplateSnapshot;
  filters: PickupReminderFilters;
  recipientCount: number;
  estimatedCostCents: number;
  maxCostCents: number;
  createdAt: Date;
}>;

export type MemoryDelivery = Readonly<{
  id: string;
  orgId: string;
  storeId: string;
  batchId: string;
  orderId: string;
  customerId: string;
  status: NotificationDeliveryStatus;
  recipientHmac: string | null;
  messageSha256: string | null;
  attemptCount: number;
  nextAttemptAt: Date | null;
  claimedAt: Date | null;
  leaseUntil: Date | null;
  leaseToken: string | null;
  workerId: string | null;
  lastErrorCode: string | null;
  providerRefSha256: string | null;
  costCents: number;
  reservedCostCents: number;
  providerOutcomePending: boolean;
  acceptedAt: Date | null;
  deliveredAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}>;

export type MemoryAttempt = Readonly<
  NotificationAttemptSettlement & { orgId: string; storeId: string }
>;
export type MemoryReceipt = Readonly<
  NotificationReceiptInput & { orgId: string; storeId: string; hash: string }
>;
type MemoryState = Readonly<{
  batches: readonly MemoryBatch[];
  deliveries: readonly MemoryDelivery[];
  attempts: readonly MemoryAttempt[];
  receipts: readonly MemoryReceipt[];
}>;

export type MemoryNotificationDeliveryStoreOptions = Readonly<{
  reminderStore: NotificationStore;
  orderStore: OrderStore;
  hmacKey?: Uint8Array;
}>;

export type MemoryNotificationWorkerContext = Readonly<{
  options: MemoryNotificationDeliveryStoreOptions;
  repository: MemoryDeliveryRepository;
  recipientHmac: (phone: string) => string;
}>;

export const memoryDeliverySha256 = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

export function memoryReminderFilters(
  request: NotificationDeliveryEnqueueRequest,
): PickupReminderFilters {
  return Object.freeze({
    minAgeDays: request.input.min_age_days,
    unpaidOnly: request.input.unpaid_only,
    garmentStatuses: Object.freeze([...request.input.garment_statuses]),
    limit: request.input.order_ids.length,
  });
}

export function renderMemoryDeliveryMessage(
  template: string,
  candidate: PickupReminderCandidate,
): string | null {
  const group = groupPickupReminders([candidate], "order")[0];
  return group === undefined ? null : renderPickupReminder(template, group);
}

export function clearMemoryDeliveryFingerprints(delivery: MemoryDelivery): MemoryDelivery {
  return Object.freeze({ ...delivery, recipientHmac: null, messageSha256: null });
}

export type MemoryDeliveryRepository = Readonly<{
  exclusive: <T>(operation: () => Promise<T>) => Promise<T>;
  batches: () => readonly MemoryBatch[];
  deliveries: () => readonly MemoryDelivery[];
  appendBatch: (batch: MemoryBatch, deliveries: readonly MemoryDelivery[]) => void;
  deliveriesFor: (batch: MemoryBatch) => readonly MemoryDelivery[];
  setDelivery: (delivery: MemoryDelivery) => void;
  appendAttempt: (attempt: MemoryAttempt) => void;
  hasAttempt: (deliveryId: string, attemptNo: number) => boolean;
  appendReceipt: (receipt: MemoryReceipt) => void;
  receiptsFor: (deliveryId: string) => readonly MemoryReceipt[];
  hasReceipt: (orgId: string, storeId: string, providerCode: string, hash: string) => boolean;
}>;

export function createMemoryDeliveryRepository(): MemoryDeliveryRepository {
  let state: MemoryState = Object.freeze({
    batches: Object.freeze([]),
    deliveries: Object.freeze([]),
    attempts: Object.freeze([]),
    receipts: Object.freeze([]),
  });
  let serialized: Promise<void> = Promise.resolve();

  return Object.freeze({
    async exclusive<T>(operation: () => Promise<T>): Promise<T> {
      const previous = serialized;
      let release = (): void => undefined;
      serialized = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await operation();
      } finally {
        release();
      }
    },
    batches: () => state.batches,
    deliveries: () => state.deliveries,
    appendBatch(batch, deliveries): void {
      state = Object.freeze({
        ...state,
        batches: Object.freeze([...state.batches, batch]),
        deliveries: Object.freeze([...state.deliveries, ...deliveries]),
      });
    },
    deliveriesFor: (batch) =>
      state.deliveries.filter(
        (delivery) =>
          delivery.orgId === batch.orgId &&
          delivery.storeId === batch.storeId &&
          delivery.batchId === batch.id,
      ),
    setDelivery(replacement): void {
      state = Object.freeze({
        ...state,
        deliveries: Object.freeze(
          state.deliveries.map((delivery) =>
            delivery.id === replacement.id ? replacement : delivery,
          ),
        ),
      });
    },
    appendAttempt(attempt): void {
      state = Object.freeze({
        ...state,
        attempts: Object.freeze([...state.attempts, attempt]),
      });
    },
    hasAttempt: (deliveryId, attemptNo) =>
      state.attempts.some(
        (attempt) => attempt.deliveryId === deliveryId && attempt.attemptNo === attemptNo,
      ),
    appendReceipt(receipt): void {
      state = Object.freeze({
        ...state,
        receipts: Object.freeze([...state.receipts, receipt]),
      });
    },
    receiptsFor: (deliveryId) =>
      state.receipts.filter((receipt) => receipt.deliveryId === deliveryId),
    hasReceipt: (orgId, storeId, providerCode, hash) =>
      state.receipts.some(
        (receipt) =>
          receipt.orgId === orgId &&
          receipt.storeId === storeId &&
          receipt.providerCode === providerCode &&
          receipt.hash === hash,
      ),
  });
}

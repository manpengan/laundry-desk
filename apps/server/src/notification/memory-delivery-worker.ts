import { randomUUID } from "node:crypto";

import type { PickupReminderCandidate } from "@laundry/contracts";

import type { TenantContext } from "../db/types.js";
import type { NotificationDeliveryClaim, NotificationWorkerStore } from "./delivery-types.js";
import {
  applyMemoryReceipt,
  expireMemoryAccepted,
  renewMemoryLease,
  settleMemoryAttempt,
} from "./memory-delivery-evidence.js";
import {
  clearMemoryDeliveryFingerprints,
  type MemoryBatch,
  type MemoryDelivery,
  type MemoryDeliveryRepository,
  MEMORY_DELIVERY_LEASE_MS,
  memoryDeliverySha256,
  type MemoryNotificationWorkerContext,
  renderMemoryDeliveryMessage,
} from "./memory-delivery-support.js";

const EXHAUSTED_SWEEP_LIMIT = 50;

function findBatch(repository: MemoryDeliveryRepository, delivery: MemoryDelivery) {
  return repository.batches().find((batch) => batch.id === delivery.batchId);
}

function nextClaimable(
  repository: MemoryDeliveryRepository,
  tenant: TenantContext,
  now: Date,
): MemoryDelivery | undefined {
  return repository
    .deliveries()
    .filter(
      (delivery) =>
        delivery.orgId === tenant.orgId &&
        delivery.storeId === tenant.storeId &&
        delivery.attemptCount < 5 &&
        (delivery.status === "queued" || delivery.status === "retry_wait"
          ? delivery.nextAttemptAt !== null && delivery.nextAttemptAt <= now
          : delivery.status === "sending" &&
            delivery.leaseUntil !== null &&
            delivery.leaseUntil <= now),
    )
    .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())[0];
}

async function currentReminder(
  context: MemoryNotificationWorkerContext,
  tenant: TenantContext,
  batch: MemoryBatch,
  delivery: MemoryDelivery,
  now: Date,
) {
  const reminders = await context.options.reminderStore.listPickupReminders({
    client: { query: async () => ({ rows: [], rowCount: 0 }) },
    tenant,
    filters: Object.freeze({ ...batch.filters, limit: 1 }),
    orderIds: [delivery.orderId],
    now,
  });
  return reminders[0];
}

function targetMatches(
  context: MemoryNotificationWorkerContext,
  batch: MemoryBatch,
  delivery: MemoryDelivery,
  reminder: PickupReminderCandidate | undefined,
): reminder is PickupReminderCandidate & Readonly<{ customer_id: string }> {
  const message =
    reminder === undefined ? null : renderMemoryDeliveryMessage(batch.template.body, reminder);
  return (
    reminder?.customer_id === delivery.customerId &&
    message !== null &&
    delivery.recipientHmac === context.recipientHmac(reminder.customer_phone) &&
    delivery.messageSha256 === memoryDeliverySha256(message)
  );
}

function markSnapshotChanged(
  repository: MemoryDeliveryRepository,
  delivery: MemoryDelivery,
  now: Date,
): void {
  repository.setDelivery(
    clearMemoryDeliveryFingerprints(
      Object.freeze({
        ...delivery,
        status: "manual_required",
        nextAttemptAt: null,
        claimedAt: null,
        leaseUntil: null,
        leaseToken: null,
        workerId: null,
        providerOutcomePending: false,
        lastErrorCode: "TARGET_SNAPSHOT_CHANGED",
        updatedAt: now,
      }),
    ),
  );
}

function expireExhaustedLeases(
  context: MemoryNotificationWorkerContext,
  tenant: TenantContext,
  now: Date,
): void {
  const expired = context.repository
    .deliveries()
    .filter(
      (delivery) =>
        delivery.orgId === tenant.orgId &&
        delivery.storeId === tenant.storeId &&
        delivery.status === "sending" &&
        delivery.attemptCount >= 5 &&
        delivery.claimedAt !== null &&
        delivery.leaseUntil !== null &&
        delivery.leaseUntil <= now,
    )
    .sort((left, right) => {
      const leaseOrder = (left.leaseUntil?.getTime() ?? 0) - (right.leaseUntil?.getTime() ?? 0);
      return leaseOrder === 0 ? left.id.localeCompare(right.id) : leaseOrder;
    })
    .slice(0, EXHAUSTED_SWEEP_LIMIT);
  for (const delivery of expired) {
    const startedAt = delivery.claimedAt;
    const leaseToken = delivery.leaseToken;
    if (startedAt === null || leaseToken === null) continue;
    context.repository.appendAttempt(
      Object.freeze({
        deliveryId: delivery.id,
        leaseToken,
        attemptNo: delivery.attemptCount,
        outcome: "uncertain" as const,
        errorCode: "PROVIDER_LEASE_EXPIRED",
        providerRefSha256: null,
        costCents: 0,
        startedAt,
        completedAt: now,
        orgId: tenant.orgId,
        storeId: tenant.storeId,
      }),
    );
    context.repository.setDelivery(
      clearMemoryDeliveryFingerprints(
        Object.freeze({
          ...delivery,
          status: "manual_required",
          nextAttemptAt: null,
          claimedAt: null,
          leaseUntil: null,
          leaseToken: null,
          workerId: null,
          providerOutcomePending: false,
          lastErrorCode: "PROVIDER_RETRY_EXHAUSTED",
          updatedAt: now,
        }),
      ),
    );
  }
}

async function claimNext(
  context: MemoryNotificationWorkerContext,
  tenant: TenantContext,
  workerId: string,
  now: Date,
): Promise<NotificationDeliveryClaim | null> {
  return context.repository.exclusive(async () => {
    expireExhaustedLeases(context, tenant, now);
    const candidate = nextClaimable(context.repository, tenant, now);
    if (candidate === undefined) return null;
    if (
      candidate.status === "sending" &&
      candidate.claimedAt !== null &&
      candidate.leaseToken !== null &&
      !context.repository.hasAttempt(candidate.id, candidate.attemptCount)
    ) {
      context.repository.appendAttempt(
        Object.freeze({
          deliveryId: candidate.id,
          leaseToken: candidate.leaseToken,
          attemptNo: candidate.attemptCount,
          outcome: "uncertain" as const,
          errorCode: "PROVIDER_LEASE_EXPIRED",
          providerRefSha256: null,
          costCents: 0,
          startedAt: candidate.claimedAt,
          completedAt: now,
          orgId: tenant.orgId,
          storeId: tenant.storeId,
        }),
      );
    }
    const batch = findBatch(context.repository, candidate);
    if (batch === undefined) return null;
    const reminder = await currentReminder(context, tenant, batch, candidate, now);
    if (!targetMatches(context, batch, candidate, reminder)) {
      markSnapshotChanged(context.repository, candidate, now);
      return null;
    }
    if (batch.estimatedCostCents % batch.recipientCount !== 0) {
      throw new TypeError("Invalid notification batch unit cost");
    }
    const unitCost = batch.estimatedCostCents / batch.recipientCount;
    const reservedCost = candidate.reservedCostCents === 0 ? unitCost : candidate.reservedCostCents;
    const allocated = context.repository
      .deliveriesFor(batch)
      .reduce((total, row) => total + row.costCents + row.reservedCostCents, 0);
    const increment = candidate.reservedCostCents === 0 ? reservedCost : 0;
    if (allocated + increment > batch.maxCostCents) {
      context.repository.setDelivery(
        clearMemoryDeliveryFingerprints(
          Object.freeze({
            ...candidate,
            status: "manual_required" as const,
            nextAttemptAt: null,
            reservedCostCents: 0,
            providerOutcomePending: false,
            lastErrorCode: "COST_LIMIT_EXCEEDED",
            updatedAt: now,
          }),
        ),
      );
      return null;
    }
    const leaseToken = randomUUID();
    const claimed: MemoryDelivery = Object.freeze({
      ...candidate,
      status: "sending",
      attemptCount: candidate.attemptCount + 1,
      nextAttemptAt: null,
      claimedAt: now,
      leaseUntil: new Date(now.getTime() + MEMORY_DELIVERY_LEASE_MS),
      leaseToken,
      workerId,
      reservedCostCents: reservedCost,
      providerOutcomePending: true,
      lastErrorCode: null,
      updatedAt: now,
    });
    context.repository.setDelivery(claimed);
    const spent = context.repository
      .deliveriesFor(batch)
      .reduce((total, row) => total + row.costCents, 0);
    return Object.freeze({
      deliveryId: claimed.id,
      batchId: batch.id,
      leaseToken,
      attemptNo: claimed.attemptCount,
      providerCode: batch.providerCode,
      assurance: batch.assurance,
      template: batch.template,
      candidate: reminder,
      expectedMessageSha256: candidate.messageSha256 ?? "",
      batchEstimatedCostCents: batch.estimatedCostCents,
      batchRecipientCount: batch.recipientCount,
      maxCostCents: batch.maxCostCents,
      spentCostCents: spent,
      reservedCostCents: reservedCost,
    });
  });
}

export function createMemoryNotificationWorkerStore(
  context: MemoryNotificationWorkerContext,
): NotificationWorkerStore {
  return Object.freeze({
    claimNext: (tenant, workerId, now) => claimNext(context, tenant, workerId, now),
    settleAttempt: (tenant, settlement) => settleMemoryAttempt(context, tenant, settlement),
    renewLease: (tenant, deliveryId, leaseToken, now) =>
      renewMemoryLease(context, tenant, deliveryId, leaseToken, now),
    expireAccepted: (tenant, now, limit) => expireMemoryAccepted(context, tenant, now, limit),
    applyReceipt: (tenant, receipt) => applyMemoryReceipt(context, tenant, receipt),
  });
}

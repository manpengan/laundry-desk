import type { TenantContext } from "../db/types.js";
import type { NotificationWorkerStore } from "./delivery-types.js";
import {
  clearMemoryDeliveryFingerprints,
  type MemoryDelivery,
  type MemoryNotificationWorkerContext,
  MEMORY_DELIVERY_LEASE_MS,
  MEMORY_RECEIPT_TIMEOUT_MS,
  MEMORY_RETRY_DELAYS_MS,
  memoryDeliverySha256,
} from "./memory-delivery-support.js";

function settledDelivery(
  current: MemoryDelivery,
  settlement: Parameters<NotificationWorkerStore["settleAttempt"]>[1],
): Readonly<{ delivery: MemoryDelivery; status: "accepted" | "retry_wait" | "manual_required" }> {
  const costInvalid = settlement.costCents > current.reservedCostCents;
  const accepted = settlement.outcome === "accepted" && !costInvalid;
  const retry =
    !accepted &&
    !costInvalid &&
    settlement.outcome !== "permanent_failure" &&
    current.attemptCount < 5;
  const status = accepted ? "accepted" : retry ? "retry_wait" : "manual_required";
  const errorCode = costInvalid
    ? "COST_LIMIT_EXCEEDED"
    : accepted
      ? null
      : (settlement.errorCode ?? "PROVIDER_RESULT_INVALID");
  const retryDelay =
    MEMORY_RETRY_DELAYS_MS[current.attemptCount - 1] ?? MEMORY_RETRY_DELAYS_MS.at(-1) ?? 7_200_000;
  const replacement: MemoryDelivery = Object.freeze({
    ...current,
    status,
    nextAttemptAt: retry ? new Date(settlement.completedAt.getTime() + retryDelay) : null,
    claimedAt: null,
    leaseUntil: null,
    leaseToken: null,
    workerId: null,
    lastErrorCode: errorCode,
    providerRefSha256: accepted ? settlement.providerRefSha256 : null,
    costCents: accepted ? settlement.costCents : current.costCents,
    reservedCostCents: settlement.outcome === "uncertain" ? current.reservedCostCents : 0,
    providerOutcomePending: false,
    acceptedAt: accepted ? settlement.completedAt : null,
    updatedAt: settlement.completedAt,
  });
  return Object.freeze({
    delivery:
      status === "manual_required" ? clearMemoryDeliveryFingerprints(replacement) : replacement,
    status,
  });
}

function applyPendingReceipt(
  context: MemoryNotificationWorkerContext,
  delivery: MemoryDelivery,
): boolean {
  const receipt = [...context.repository.receiptsFor(delivery.id)].sort((left, right) => {
    if (left.status !== right.status) return left.status === "delivered" ? -1 : 1;
    return left.observedAt.getTime() - right.observedAt.getTime();
  })[0];
  if (receipt === undefined || delivery.status !== "accepted" || delivery.acceptedAt === null) {
    return false;
  }
  const deliveredAt = new Date(
    Math.max(receipt.observedAt.getTime(), delivery.acceptedAt.getTime()),
  );
  context.repository.setDelivery(
    clearMemoryDeliveryFingerprints(
      Object.freeze({
        ...delivery,
        status: receipt.status === "delivered" ? "delivered" : "manual_required",
        deliveredAt: receipt.status === "delivered" ? deliveredAt : null,
        lastErrorCode: receipt.status === "failed" ? "PROVIDER_DELIVERY_FAILED" : null,
        updatedAt: receipt.recordedAt,
      }),
    ),
  );
  return true;
}

export function settleMemoryAttempt(
  context: MemoryNotificationWorkerContext,
  tenant: TenantContext,
  settlement: Parameters<NotificationWorkerStore["settleAttempt"]>[1],
) {
  return context.repository.exclusive(async () => {
    const current = context.repository
      .deliveries()
      .find(
        (delivery) =>
          delivery.orgId === tenant.orgId &&
          delivery.storeId === tenant.storeId &&
          delivery.id === settlement.deliveryId,
      );
    if (
      current === undefined ||
      current.status !== "sending" ||
      current.leaseToken !== settlement.leaseToken ||
      current.attemptCount !== settlement.attemptNo
    ) {
      return "stale_lease" as const;
    }
    const next = settledDelivery(current, settlement);
    context.repository.setDelivery(next.delivery);
    context.repository.appendAttempt(
      Object.freeze({ ...settlement, orgId: tenant.orgId, storeId: tenant.storeId }),
    );
    if (next.status === "accepted") applyPendingReceipt(context, next.delivery);
    return next.status;
  });
}

export function expireMemoryAccepted(
  context: MemoryNotificationWorkerContext,
  tenant: TenantContext,
  now: Date,
  limit: number,
) {
  return context.repository.exclusive(async () => {
    const expired = context.repository
      .deliveries()
      .filter(
        (delivery) =>
          delivery.orgId === tenant.orgId &&
          delivery.storeId === tenant.storeId &&
          delivery.status === "accepted" &&
          delivery.acceptedAt !== null &&
          delivery.acceptedAt.getTime() + MEMORY_RECEIPT_TIMEOUT_MS <= now.getTime(),
      )
      .slice(0, limit);
    for (const delivery of expired) {
      context.repository.setDelivery(
        clearMemoryDeliveryFingerprints(
          Object.freeze({
            ...delivery,
            status: "manual_required",
            lastErrorCode: "RECEIPT_TIMEOUT",
            updatedAt: now,
          }),
        ),
      );
    }
    return expired.length;
  });
}

export function renewMemoryLease(
  context: MemoryNotificationWorkerContext,
  tenant: TenantContext,
  deliveryId: string,
  leaseToken: string,
  now: Date,
) {
  return context.repository.exclusive(async () => {
    const current = context.repository
      .deliveries()
      .find(
        (delivery) =>
          delivery.orgId === tenant.orgId &&
          delivery.storeId === tenant.storeId &&
          delivery.id === deliveryId,
      );
    if (
      current?.status !== "sending" ||
      current.leaseToken !== leaseToken ||
      current.leaseUntil === null ||
      current.leaseUntil <= now
    ) {
      return false;
    }
    context.repository.setDelivery(
      Object.freeze({
        ...current,
        leaseUntil: new Date(now.getTime() + MEMORY_DELIVERY_LEASE_MS),
        updatedAt: now,
      }),
    );
    return true;
  });
}

export function applyMemoryReceipt(
  context: MemoryNotificationWorkerContext,
  tenant: TenantContext,
  receipt: Parameters<NotificationWorkerStore["applyReceipt"]>[1],
) {
  return context.repository.exclusive(async () => {
    const hash = memoryDeliverySha256(receipt.receiptId);
    if (context.repository.hasReceipt(tenant.orgId, tenant.storeId, receipt.providerCode, hash)) {
      return "duplicate" as const;
    }
    const current = context.repository
      .deliveries()
      .find(
        (delivery) =>
          delivery.orgId === tenant.orgId &&
          delivery.storeId === tenant.storeId &&
          delivery.id === receipt.deliveryId,
      );
    if (current === undefined) return "not_found" as const;
    const batch = context.repository
      .batches()
      .find((candidate) => candidate.id === current.batchId);
    if (batch?.providerCode !== receipt.providerCode) return "ignored" as const;
    context.repository.appendReceipt(
      Object.freeze({ ...receipt, orgId: tenant.orgId, storeId: tenant.storeId, hash }),
    );
    if (current.status !== "accepted") {
      return ["queued", "sending", "retry_wait"].includes(current.status)
        ? ("pending" as const)
        : ("ignored" as const);
    }
    return applyPendingReceipt(context, current) ? ("applied" as const) : ("ignored" as const);
  });
}

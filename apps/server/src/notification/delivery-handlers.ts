import { createHash, randomUUID } from "node:crypto";

import {
  NotificationDeliveryBatchEnqueueInputSchema,
  NotificationDeliveryBatchEnqueueResultSchema,
  NotificationDeliveryBatchGetInputSchema,
  NotificationDeliveryBatchGetResultSchema,
  NotificationDeliveryBatchesListInputSchema,
  NotificationDeliveryBatchesListResultSchema,
  NotificationDeliveryCapabilityInputSchema,
  NotificationDeliveryCapabilityResultSchema,
  createCommandError,
  type PickupReminderCandidate,
} from "@laundry/contracts";
import { groupPickupReminders, renderPickupReminder } from "@laundry/domain";

import type { CommandHandler, HandlerOutcome } from "../bus/types.js";
import { HandlerCommandError } from "../bus/types.js";
import { DISABLED_NOTIFICATION_CAPABILITY } from "./delivery-provider.js";
import {
  requireFrozenNotificationDelivery,
  requireNotificationCostBounds,
} from "./delivery-confirmation.js";
import type { NotificationHandlerDeps, PickupReminderFilters } from "./types.js";

const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

function requirePermission(permissions: readonly string[] | undefined, permission: string): void {
  if (permissions?.includes(permission) !== true) {
    throw new HandlerCommandError(createCommandError("PERMISSION_DENIED"));
  }
}

function requireDelivery(deps: NotificationHandlerDeps) {
  const delivery = deps.delivery;
  if (delivery === undefined) {
    throw new HandlerCommandError(createCommandError("RESOURCE_UNAVAILABLE"));
  }
  const assurance = delivery.capability.state;
  if (assurance === "disabled") {
    throw new HandlerCommandError(createCommandError("RESOURCE_UNAVAILABLE"));
  }
  const {
    provider_code: providerCode,
    unit_cost_cents: unitCost,
    max_batch_cost_cents: maxBatchCost,
  } = delivery.capability;
  if (providerCode === null || unitCost === null || maxBatchCost === null) {
    throw new HandlerCommandError(createCommandError("RESOURCE_UNAVAILABLE"));
  }
  return Object.freeze({ assurance, delivery, providerCode, unitCost, maxBatchCost });
}

function nowFrom(deps: NotificationHandlerDeps): Date {
  const now = deps.now?.() ?? new Date();
  if (!Number.isFinite(now.getTime())) {
    throw new HandlerCommandError(createCommandError("TRANSACTION_FAILED"));
  }
  return now;
}

function reminderFilters(input: {
  min_age_days: 30 | 90 | 180;
  unpaid_only: boolean;
  garment_statuses: readonly ("ready" | "racked")[];
  limit: number;
}): PickupReminderFilters {
  return Object.freeze({
    minAgeDays: input.min_age_days,
    unpaidOnly: input.unpaid_only,
    garmentStatuses: Object.freeze([...input.garment_statuses]),
    limit: input.limit,
  });
}

function currentCandidates(
  requestedIds: readonly string[],
  candidates: readonly PickupReminderCandidate[],
): readonly (PickupReminderCandidate & Readonly<{ customer_id: string }>)[] {
  const byId = new Map(candidates.map((candidate) => [candidate.order_id, candidate]));
  const ordered = requestedIds.map((orderId) => byId.get(orderId));
  if (ordered.some((candidate) => candidate === undefined || candidate.customer_id === null)) {
    throw new HandlerCommandError(createCommandError("INVARIANT_FAILED"));
  }
  return Object.freeze(
    ordered.map(
      (candidate) => candidate as PickupReminderCandidate & Readonly<{ customer_id: string }>,
    ),
  );
}

function enqueueHandler(deps: NotificationHandlerDeps): CommandHandler {
  return async (context): Promise<HandlerOutcome> => {
    requirePermission(context.actor.permissions, "customer_read");
    requirePermission(context.actor.permissions, "notification_send");
    const input = NotificationDeliveryBatchEnqueueInputSchema.parse(context.parsed);
    const { assurance, delivery, providerCode, unitCost, maxBatchCost } = requireDelivery(deps);
    const now = nowFrom(deps);
    const estimatedCost = requireNotificationCostBounds({
      orderCount: input.order_ids.length,
      maxCostCents: input.max_cost_cents,
      unitCostCents: unitCost,
      capabilityMaxCostCents: maxBatchCost,
    });

    const locked = await deps.store.lockOrders(context.client, context.tenant, input.order_ids);
    if (locked !== input.order_ids.length) {
      throw new HandlerCommandError(createCommandError("INVARIANT_FAILED"));
    }
    if (
      !(await delivery.store.assertOrdersAvailable(context.client, context.tenant, input.order_ids))
    ) {
      throw new HandlerCommandError(createCommandError("INVARIANT_FAILED"));
    }
    const candidates = currentCandidates(
      input.order_ids,
      await deps.store.listPickupReminders({
        client: context.client,
        tenant: context.tenant,
        filters: reminderFilters({ ...input, limit: input.order_ids.length }),
        orderIds: input.order_ids,
        now,
      }),
    );
    const template = await delivery.store.getActiveTemplate(
      context.client,
      context.tenant,
      input.template_code,
    );
    if (template === null) {
      throw new HandlerCommandError(createCommandError("RESOURCE_UNAVAILABLE"));
    }
    requireFrozenNotificationDelivery(context, deps, template);

    const batchId = randomUUID();
    const deliveries = candidates.map((candidate) => {
      const group = groupPickupReminders([candidate], "order")[0];
      if (group === undefined) {
        throw new HandlerCommandError(createCommandError("INVARIANT_FAILED"));
      }
      return Object.freeze({
        id: randomUUID(),
        candidate,
        messageSha256: sha256(renderPickupReminder(template.body, group)),
      });
    });
    const result = NotificationDeliveryBatchEnqueueResultSchema.parse(
      await delivery.store.enqueueBatch({
        client: context.client,
        tenant: context.tenant,
        batchId,
        input,
        template,
        providerCode,
        assurance,
        estimatedCostCents: estimatedCost,
        createdByStaffId: context.actor.staffId,
        createdAt: now,
        deliveries,
      }),
    );
    return Object.freeze({
      result,
      audit: Object.freeze({
        entity: "notification_delivery_batch",
        entityId: batchId,
        afterJson: JSON.stringify({
          batch_id: batchId,
          assurance: result.assurance,
          provider_code: result.provider_code,
          order_count: result.order_count,
          estimated_cost_cents: result.estimated_cost_cents,
          max_cost_cents: result.max_cost_cents,
        }),
      }),
      events: Object.freeze([
        Object.freeze({
          type: "notification.delivery_batch_queued",
          payload: Object.freeze({ batch_id: batchId, order_count: result.order_count }),
        }),
      ]),
    });
  };
}

function capabilityHandler(deps: NotificationHandlerDeps): CommandHandler {
  return async (context): Promise<HandlerOutcome> => {
    requirePermission(context.actor.permissions, "customer_read");
    NotificationDeliveryCapabilityInputSchema.parse(context.parsed);
    return Object.freeze({
      result: NotificationDeliveryCapabilityResultSchema.parse(
        deps.delivery?.capability ?? DISABLED_NOTIFICATION_CAPABILITY,
      ),
    });
  };
}

function listHandler(deps: NotificationHandlerDeps): CommandHandler {
  return async (context): Promise<HandlerOutcome> => {
    requirePermission(context.actor.permissions, "customer_read");
    requirePermission(context.actor.permissions, "notification_send");
    const input = NotificationDeliveryBatchesListInputSchema.parse(context.parsed);
    const { delivery } = requireDelivery(deps);
    return Object.freeze({
      result: NotificationDeliveryBatchesListResultSchema.parse({
        batches: await delivery.store.listBatches(
          context.client,
          context.tenant,
          input.limit ?? 10,
        ),
      }),
    });
  };
}

function getHandler(deps: NotificationHandlerDeps): CommandHandler {
  return async (context): Promise<HandlerOutcome> => {
    requirePermission(context.actor.permissions, "customer_read");
    requirePermission(context.actor.permissions, "notification_send");
    const input = NotificationDeliveryBatchGetInputSchema.parse(context.parsed);
    const { delivery } = requireDelivery(deps);
    const result = await delivery.store.getBatch(context.client, context.tenant, input.batch_id);
    if (result === null) {
      throw new HandlerCommandError(createCommandError("RESOURCE_UNAVAILABLE"));
    }
    return Object.freeze({ result: NotificationDeliveryBatchGetResultSchema.parse(result) });
  };
}

export function createNotificationDeliveryHandlers(deps: NotificationHandlerDeps) {
  return Object.freeze({
    "notification.delivery_batch.enqueue": enqueueHandler(deps),
    "notification.delivery.capability.get": capabilityHandler(deps),
    "notification.delivery_batches.list": listHandler(deps),
    "notification.delivery_batch.get": getHandler(deps),
  });
}

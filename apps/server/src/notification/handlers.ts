import { createHash, randomUUID } from "node:crypto";

import {
  NotificationManualListCreateInputSchema,
  NotificationManualListCreateResultSchema,
  PickupReminderListInputSchema,
  PickupReminderListResultSchema,
  createCommandError,
  type NotificationManualListCreateResult,
} from "@laundry/contracts";
import { groupPickupReminders, renderPickupReminder } from "@laundry/domain";

import type { MutableCommandRegistry } from "../bus/registry.js";
import type { MutableQueryRegistry } from "../bus/query-registry.js";
import { HandlerCommandError, type CommandHandler, type HandlerOutcome } from "../bus/types.js";
import { buildNotificationCsv } from "./csv.js";
import type { NotificationHandlerDeps, PickupReminderFilters } from "./types.js";

function requireCustomerRead(permissions: readonly string[] | undefined): void {
  if (permissions?.includes("customer_read") !== true) {
    throw new HandlerCommandError(createCommandError("PERMISSION_DENIED"));
  }
}

function validNow(deps: NotificationHandlerDeps): Date {
  const now = deps.now?.() ?? new Date();
  if (!Number.isFinite(now.getTime())) {
    throw new HandlerCommandError(createCommandError("TRANSACTION_FAILED"));
  }
  return now;
}

function filters(input: {
  min_age_days?: 30 | 90 | 180 | undefined;
  unpaid_only?: boolean | undefined;
  garment_statuses?: readonly ("ready" | "racked")[] | undefined;
  limit?: number | undefined;
}): PickupReminderFilters {
  return Object.freeze({
    minAgeDays: input.min_age_days ?? 30,
    unpaidOnly: input.unpaid_only ?? false,
    garmentStatuses: Object.freeze([...(input.garment_statuses ?? ["ready", "racked"])]),
    limit: input.limit ?? 200,
  });
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function requiredMessageHash(hashes: ReadonlyMap<string, string>, orderId: string): string {
  const hash = hashes.get(orderId);
  if (hash === undefined) {
    throw new HandlerCommandError(createCommandError("INVARIANT_FAILED"));
  }
  return hash;
}

function manualRows(
  candidates: Parameters<typeof groupPickupReminders>[0],
  groupBy: "order" | "customer",
  template: string,
): NotificationManualListCreateResult["rows"] {
  return groupPickupReminders(candidates, groupBy).map((group) => ({
    order_ids: [...group.order_ids],
    ticket_nos: [...group.ticket_nos],
    customer_name: group.customer_name,
    customer_phone: group.customer_phone,
    garment_count: group.garment_count,
    balance_cents: group.balance_cents,
    message: renderPickupReminder(template, group),
  }));
}

function listHandler(deps: NotificationHandlerDeps): CommandHandler {
  return async (ctx): Promise<HandlerOutcome> => {
    requireCustomerRead(ctx.actor.permissions);
    const input = PickupReminderListInputSchema.parse(ctx.parsed);
    const now = validNow(deps);
    const candidates = await deps.store.listPickupReminders({
      client: ctx.client,
      tenant: ctx.tenant,
      filters: filters(input),
      now,
    });
    const result = PickupReminderListResultSchema.parse({
      generated_at: now.toISOString(),
      channels: { manual: true, sms: false, wechat: false },
      candidates,
    });
    return Object.freeze({ result });
  };
}

function createHandler(deps: NotificationHandlerDeps): CommandHandler {
  return async (ctx): Promise<HandlerOutcome> => {
    requireCustomerRead(ctx.actor.permissions);
    const input = NotificationManualListCreateInputSchema.parse(ctx.parsed);
    const now = validNow(deps);
    const locked = await deps.store.lockOrders(ctx.client, ctx.tenant, input.order_ids);
    if (locked !== input.order_ids.length) {
      throw new HandlerCommandError(createCommandError("INVARIANT_FAILED"));
    }
    const candidates = await deps.store.listPickupReminders({
      client: ctx.client,
      tenant: ctx.tenant,
      filters: filters({
        min_age_days: input.min_age_days,
        unpaid_only: input.unpaid_only,
        garment_statuses: input.garment_statuses,
        limit: input.order_ids.length,
      }),
      now,
      orderIds: input.order_ids,
    });
    if (
      candidates.length !== input.order_ids.length ||
      candidates.some((candidate) => !input.order_ids.includes(candidate.order_id))
    ) {
      throw new HandlerCommandError(createCommandError("INVARIANT_FAILED"));
    }

    const rows = manualRows(candidates, input.group_by, input.message_template);
    const csv = buildNotificationCsv(rows);
    const exportSha256 = sha256(csv);
    const batchId = randomUUID();
    const messageHashByOrder = new Map<string, string>();
    for (const row of rows) {
      const messageHash = sha256(row.message);
      for (const orderId of row.order_ids) messageHashByOrder.set(orderId, messageHash);
    }
    await deps.store.appendManualList(
      ctx.client,
      ctx.tenant,
      candidates.map((candidate) =>
        Object.freeze({
          id: randomUUID(),
          batchId,
          orderId: candidate.order_id,
          customerId: candidate.customer_id,
          grouping: input.group_by,
          messageSha256: requiredMessageHash(messageHashByOrder, candidate.order_id),
          exportSha256,
          staffId: ctx.actor.staffId,
          createdAt: now,
        }),
      ),
    );
    const day = now.toISOString().slice(0, 10).replaceAll("-", "");
    const result = NotificationManualListCreateResultSchema.parse({
      batch_id: batchId,
      generated_at: now.toISOString(),
      channel: "manual",
      status: "list_generated",
      cost_cents: 0,
      recipient_count: rows.length,
      order_count: candidates.length,
      filename: `pickup-reminders-${day}-${batchId.slice(0, 8)}.csv`,
      content_sha256: exportSha256,
      csv,
      rows,
    });
    return Object.freeze({
      result,
      audit: Object.freeze({
        entity: "notification_manual_list",
        entityId: batchId,
        afterJson: JSON.stringify({
          batch_id: batchId,
          order_count: candidates.length,
          recipient_count: rows.length,
          grouping: input.group_by,
          content_sha256: exportSha256,
        }),
      }),
      events: Object.freeze([
        Object.freeze({
          type: "notification.manual_list_generated",
          payload: Object.freeze({ batch_id: batchId, order_count: candidates.length }),
        }),
      ]),
    });
  };
}

export function createNotificationHandlers(
  deps: NotificationHandlerDeps,
): Readonly<
  Record<"notification.pickup_reminders.list" | "notification.manual_list.create", CommandHandler>
> {
  return Object.freeze({
    "notification.pickup_reminders.list": listHandler(deps),
    "notification.manual_list.create": createHandler(deps),
  });
}

export function registerNotificationHandlers(
  commandRegistry: MutableCommandRegistry,
  queryRegistry: MutableQueryRegistry | null,
  deps: NotificationHandlerDeps,
): void {
  const handlers = createNotificationHandlers(deps);
  commandRegistry.registerHandler(
    "notification.manual_list.create",
    handlers["notification.manual_list.create"],
  );
  queryRegistry?.registerHandler(
    "notification.pickup_reminders.list",
    handlers["notification.pickup_reminders.list"],
  );
}

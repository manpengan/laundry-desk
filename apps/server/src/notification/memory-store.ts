import { PickupReminderCandidateSchema, type PickupReminderCandidate } from "@laundry/contracts";

import type { GarmentRecord } from "../order/types.js";
import type {
  MemoryNotificationStoreOptions,
  NotificationLogWrite,
  NotificationStore,
  PickupReminderListRequest,
} from "./types.js";

const PHONE = /^1[3-9]\d{9}$/u;

export function createMemoryNotificationStore({
  orderStore,
}: MemoryNotificationStoreOptions): NotificationStore {
  const logs: Array<NotificationLogWrite & Readonly<{ orgId: string; storeId: string }>> = [];

  const listPickupReminders = async (
    request: PickupReminderListRequest,
  ): Promise<readonly PickupReminderCandidate[]> => {
    if (orderStore.listOrders === undefined) return Object.freeze([]);
    const cutoffSeconds =
      Math.floor(request.now.getTime() / 1_000) - request.filters.minAgeDays * 86_400;
    const selected = request.orderIds === undefined ? null : new Set(request.orderIds);
    const candidates: PickupReminderCandidate[] = [];
    const orders = await orderStore.listOrders(request.tenant.orgId, request.tenant.storeId);
    for (const order of orders) {
      if (
        order.status !== "open" ||
        order.ticket_no === null ||
        order.customer_phone === null ||
        !PHONE.test(order.customer_phone) ||
        order.created_at > cutoffSeconds ||
        (request.filters.unpaidOnly && order.balance_cents === 0) ||
        (selected !== null && !selected.has(order.order_id))
      ) {
        continue;
      }
      const allowed = new Set(request.filters.garmentStatuses);
      const garments = (
        await orderStore.listGarments(request.tenant.orgId, request.tenant.storeId, order.order_id)
      ).filter((garment: GarmentRecord) => allowed.has(garment.status as "ready" | "racked"));
      if (garments.length === 0) continue;
      const statuses = [...new Set(garments.map((garment) => garment.status))].sort();
      const contact = logs
        .filter(
          (log) =>
            log.orgId === request.tenant.orgId &&
            log.storeId === request.tenant.storeId &&
            log.orderId === order.order_id,
        )
        .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())[0];
      candidates.push(
        PickupReminderCandidateSchema.parse({
          order_id: order.order_id,
          ticket_no: order.ticket_no,
          customer_id: order.customer_id,
          customer_name: order.customer_name,
          customer_phone: order.customer_phone,
          garment_count: garments.length,
          balance_cents: order.balance_cents,
          received_at: new Date(order.created_at * 1_000).toISOString(),
          overdue_days: Math.max(
            0,
            Math.floor(request.now.getTime() / 86_400_000 - order.created_at / 86_400),
          ),
          garment_statuses: statuses,
          last_contact_at: contact?.createdAt.toISOString() ?? null,
        }),
      );
    }
    return Object.freeze(
      candidates
        .sort((left, right) =>
          left.received_at === right.received_at
            ? left.ticket_no.localeCompare(right.ticket_no)
            : left.received_at.localeCompare(right.received_at),
        )
        .slice(0, request.filters.limit),
    );
  };

  return Object.freeze({
    listPickupReminders,
    lockOrders: async (_client, tenant, orderIds) => {
      if (orderStore.listOrders === undefined) return 0;
      const ids = new Set(
        (await orderStore.listOrders(tenant.orgId, tenant.storeId)).map((order) => order.order_id),
      );
      return orderIds.filter((id) => ids.has(id)).length;
    },
    appendManualList: async (_client, tenant, rows) => {
      logs.push(
        ...rows.map((row) =>
          Object.freeze({ ...row, orgId: tenant.orgId, storeId: tenant.storeId }),
        ),
      );
    },
  });
}

import type { DeliveryOrderStatus, DeliveryTaskLeg } from "@laundry/contracts";

import type { DeliveryOrderHandlerDeps } from "../delivery-orders/handlers.js";
import type { DeliveryOrderTransitionRequest } from "../delivery-orders/types.js";
import type { DeliveryTaskStore } from "./types.js";

function requiredTaskLeg(
  current: DeliveryOrderStatus,
  target: DeliveryOrderStatus,
): DeliveryTaskLeg | null {
  if (
    (current === "pickup_scheduled" && target === "pickup_in_progress") ||
    (current === "pickup_in_progress" && target === "picked_up")
  ) {
    return "pickup";
  }
  if (
    (current === "return_scheduled" && target === "return_in_progress") ||
    (current === "return_in_progress" && target === "completed")
  ) {
    return "return";
  }
  return null;
}

/** Memory parity for the PostgreSQL order/task triggers in migration 0057. */
export function bindMemoryDeliveryTaskOrderAuthority(
  orders: DeliveryOrderHandlerDeps,
  tasks: DeliveryTaskStore,
): DeliveryOrderHandlerDeps {
  const base = orders.store;
  return Object.freeze({
    ...orders,
    store: Object.freeze({
      ...base,
      async transition(request: DeliveryOrderTransitionRequest) {
        const current = await base.get(request.org_id, request.store_id, request.delivery_order_id);
        if (current === null)
          return Object.freeze({ ok: false as const, reason: "not_found" as const });
        const leg = requiredTaskLeg(current.status, request.target_status);
        if (
          leg !== null &&
          !(await tasks.canExecuteOrderTransition(
            request.org_id,
            request.store_id,
            request.delivery_order_id,
            leg,
            request.staff_id,
          ))
        ) {
          return Object.freeze({ ok: false as const, reason: "state_conflict" as const });
        }
        const result = await base.transition(request);
        if (result.ok) {
          await tasks.settleOrderTransition({
            orgId: request.org_id,
            storeId: request.store_id,
            deliveryOrder: result.delivery_order,
            previousStatus: current.status,
            staffId: request.staff_id,
            at: request.at,
          });
        }
        return result;
      },
    }),
  });
}

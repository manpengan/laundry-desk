/** Pure pickup plan: validate garment transitions, collection, and order closure. */

import { canTransition, type GarmentStatus } from "../status-machine.js";
import { planOrderClosure, type CounterOrderStatus } from "./lifecycle.js";

export type PickupGarmentView = Readonly<{
  garment_id: string;
  status: GarmentStatus;
}>;

export type PickupPlanSuccess = Readonly<{
  ok: true;
  garment_ids: readonly string[];
  from_statuses: readonly GarmentStatus[];
  to_status: "picked_up";
  collect_cents: number;
  next_balance_cents: number;
  next_order_status: "open" | "closed";
}>;

export type PickupRejectReason =
  | "ORDER_NOT_OPEN"
  | "EMPTY_SELECTION"
  | "UNKNOWN_GARMENT"
  | "DUPLICATE_GARMENT"
  | "INVALID_TRANSITION"
  | "INVALID_COLLECT"
  | "COLLECT_EXCEEDS_BALANCE";

export type PickupPlanResult =
  PickupPlanSuccess | Readonly<{ ok: false; reason: PickupRejectReason; garment_id?: string }>;

type PickupInput = Readonly<{
  garments: readonly PickupGarmentView[];
  selected_garment_ids: readonly string[];
  balance_cents: number;
  collect_cents: number;
  order_status?: CounterOrderStatus;
  fulfillment_enabled?: boolean;
}>;

function invalidCollect(input: PickupInput): boolean {
  return (
    !Number.isSafeInteger(input.collect_cents) ||
    !Number.isSafeInteger(input.balance_cents) ||
    input.collect_cents < 0 ||
    input.balance_cents < 0
  );
}

function selectPickupTargets(
  garments: readonly PickupGarmentView[],
  selectedIds: readonly string[],
  fulfillmentEnabled: boolean,
): readonly PickupGarmentView[] | Exclude<PickupPlanResult, PickupPlanSuccess> {
  const byId = new Map(garments.map((garment) => [garment.garment_id, garment]));
  if (selectedIds.length === 0) {
    return garments.filter((garment) =>
      canTransition(garment.status, "picked_up", { fulfillmentEnabled }),
    );
  }

  const seen = new Set<string>();
  const targets: PickupGarmentView[] = [];
  for (const id of selectedIds) {
    if (seen.has(id))
      return Object.freeze({ ok: false, reason: "DUPLICATE_GARMENT", garment_id: id });
    seen.add(id);
    const garment = byId.get(id);
    if (garment === undefined)
      return Object.freeze({ ok: false, reason: "UNKNOWN_GARMENT", garment_id: id });
    if (!canTransition(garment.status, "picked_up", { fulfillmentEnabled })) {
      return Object.freeze({ ok: false, reason: "INVALID_TRANSITION", garment_id: id });
    }
    targets.push(garment);
  }
  return targets;
}

function isPickupFailure(
  result: readonly PickupGarmentView[] | Exclude<PickupPlanResult, PickupPlanSuccess>,
): result is Exclude<PickupPlanResult, PickupPlanSuccess> {
  return !Array.isArray(result);
}

/**
 * Plan marking selected garments picked_up. An empty selection means every pickable
 * garment on the order. The returned order state implements the partial-pickup gate.
 */
export function planPickup(input: PickupInput): PickupPlanResult {
  const orderStatus = input.order_status ?? "open";
  if (orderStatus !== "open") return Object.freeze({ ok: false, reason: "ORDER_NOT_OPEN" });
  if (invalidCollect(input)) return Object.freeze({ ok: false, reason: "INVALID_COLLECT" });
  if (input.collect_cents > input.balance_cents) {
    return Object.freeze({ ok: false, reason: "COLLECT_EXCEEDS_BALANCE" });
  }

  const fulfillmentEnabled = input.fulfillment_enabled ?? false;
  const targets = selectPickupTargets(
    input.garments,
    input.selected_garment_ids,
    fulfillmentEnabled,
  );
  if (isPickupFailure(targets)) return targets;
  if (targets.length === 0) return Object.freeze({ ok: false, reason: "EMPTY_SELECTION" });

  const targetIds = new Set(targets.map((garment) => garment.garment_id));
  const closure = planOrderClosure({
    status: orderStatus,
    garment_statuses: input.garments.map((garment) =>
      targetIds.has(garment.garment_id) ? "picked_up" : garment.status,
    ),
    balance_cents: input.balance_cents - input.collect_cents,
  });
  if (!closure.ok) return Object.freeze({ ok: false, reason: "ORDER_NOT_OPEN" });

  return Object.freeze({
    ok: true,
    garment_ids: Object.freeze(targets.map((garment) => garment.garment_id)),
    from_statuses: Object.freeze(targets.map((garment) => garment.status)),
    to_status: "picked_up",
    collect_cents: input.collect_cents,
    next_balance_cents: input.balance_cents - input.collect_cents,
    next_order_status: closure.next_status,
  });
}

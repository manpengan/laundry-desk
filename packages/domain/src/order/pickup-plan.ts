/**
 * Pure pickup (取衣) plan: validate garment transitions + collection amount.
 */

import { canTransition, type GarmentStatus } from "../status-machine.js";
import { validateCents } from "../money.js";

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
}>;

export type PickupRejectReason =
  | "EMPTY_SELECTION"
  | "UNKNOWN_GARMENT"
  | "INVALID_TRANSITION"
  | "INVALID_COLLECT"
  | "COLLECT_EXCEEDS_BALANCE";

export type PickupPlanResult =
  PickupPlanSuccess | Readonly<{ ok: false; reason: PickupRejectReason; garment_id?: string }>;

/**
 * Plan marking selected garments picked_up.
 * When `selectedIds` is empty, all currently pickable garments on the order are selected.
 */
export function planPickup(input: {
  readonly garments: readonly PickupGarmentView[];
  readonly selected_garment_ids: readonly string[];
  readonly balance_cents: number;
  readonly collect_cents: number;
  readonly fulfillment_enabled?: boolean;
}): PickupPlanResult {
  const fulfillmentEnabled = input.fulfillment_enabled ?? false;
  try {
    validateCents(input.collect_cents);
    validateCents(input.balance_cents);
  } catch {
    return Object.freeze({ ok: false as const, reason: "INVALID_COLLECT" as const });
  }
  if (input.collect_cents < 0 || input.balance_cents < 0) {
    return Object.freeze({ ok: false as const, reason: "INVALID_COLLECT" as const });
  }
  if (input.collect_cents > input.balance_cents) {
    return Object.freeze({ ok: false as const, reason: "COLLECT_EXCEEDS_BALANCE" as const });
  }

  const byId = new Map(input.garments.map((g) => [g.garment_id, g]));
  const pickable = input.garments.filter((g) =>
    canTransition(g.status, "picked_up", { fulfillmentEnabled }),
  );

  let targets: PickupGarmentView[];
  if (input.selected_garment_ids.length === 0) {
    targets = pickable;
  } else {
    targets = [];
    for (const id of input.selected_garment_ids) {
      const g = byId.get(id);
      if (g === undefined) {
        return Object.freeze({
          ok: false as const,
          reason: "UNKNOWN_GARMENT" as const,
          garment_id: id,
        });
      }
      if (!canTransition(g.status, "picked_up", { fulfillmentEnabled })) {
        return Object.freeze({
          ok: false as const,
          reason: "INVALID_TRANSITION" as const,
          garment_id: id,
        });
      }
      targets.push(g);
    }
  }

  if (targets.length === 0) {
    return Object.freeze({ ok: false as const, reason: "EMPTY_SELECTION" as const });
  }

  return Object.freeze({
    ok: true as const,
    garment_ids: Object.freeze(targets.map((g) => g.garment_id)),
    from_statuses: Object.freeze(targets.map((g) => g.status)),
    to_status: "picked_up" as const,
    collect_cents: input.collect_cents,
  });
}

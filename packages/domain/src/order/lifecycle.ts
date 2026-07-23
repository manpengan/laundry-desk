import type { GarmentStatus } from "../status-machine.js";

/** Frozen contracts v0.2 order states. A hold is an event, not a fourth status. */
export type CounterOrderStatus = "open" | "closed" | "cancelled";

export const TERMINAL_GARMENT_STATUSES = Object.freeze([
  "picked_up",
  "delivered",
  "lost",
] as const satisfies readonly GarmentStatus[]);

export type OrderClosureRejectReason = "ORDER_NOT_OPEN" | "EMPTY_GARMENTS" | "INVALID_BALANCE";

export type OrderClosurePlan =
  | Readonly<{ ok: true; next_status: "open" | "closed"; can_close: boolean }>
  | Readonly<{ ok: false; reason: OrderClosureRejectReason }>;

const isTerminalGarmentStatus = (status: GarmentStatus): boolean =>
  (TERMINAL_GARMENT_STATUSES as readonly GarmentStatus[]).includes(status);

/**
 * Orders close only after every garment reaches a terminal state and no balance remains.
 * A non-zero balance intentionally keeps an otherwise fully picked order open for repayment.
 */
export function planOrderClosure(input: {
  readonly status: CounterOrderStatus;
  readonly garment_statuses: readonly GarmentStatus[];
  readonly balance_cents: number;
}): OrderClosurePlan {
  if (input.status !== "open") return Object.freeze({ ok: false, reason: "ORDER_NOT_OPEN" });
  if (input.garment_statuses.length === 0) {
    return Object.freeze({ ok: false, reason: "EMPTY_GARMENTS" });
  }
  if (!Number.isSafeInteger(input.balance_cents) || input.balance_cents < 0) {
    return Object.freeze({ ok: false, reason: "INVALID_BALANCE" });
  }

  const canClose =
    input.balance_cents === 0 && input.garment_statuses.every(isTerminalGarmentStatus);
  return Object.freeze({
    ok: true,
    next_status: canClose ? "closed" : "open",
    can_close: canClose,
  });
}

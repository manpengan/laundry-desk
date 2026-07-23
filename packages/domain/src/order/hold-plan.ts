import type { CounterOrderStatus } from "./lifecycle.js";

/**
 * Contracts v0.2 holds an existing open order. It does not create a `draft`
 * status: draft is not a frozen order status and changing that needs an ADR.
 */
export type HoldPlan =
  | Readonly<{ ok: true; order_status: "open"; held: true; reason: string }>
  | Readonly<{ ok: false; reason: "ORDER_NOT_OPEN" | "INVALID_REASON" }>;

export type ResumePlan =
  | Readonly<{ ok: true; order_status: "open"; held: false }>
  | Readonly<{ ok: false; reason: "ORDER_NOT_OPEN" | "ORDER_NOT_HELD" }>;

const normalizeReason = (reason: string): string | null => {
  const trimmed = reason.trim();
  return trimmed.length > 0 && trimmed.length <= 256 ? trimmed : null;
};

export function planHold(input: {
  readonly status: CounterOrderStatus;
  readonly reason: string;
}): HoldPlan {
  if (input.status !== "open") return Object.freeze({ ok: false, reason: "ORDER_NOT_OPEN" });
  const reason = normalizeReason(input.reason);
  return reason === null
    ? Object.freeze({ ok: false, reason: "INVALID_REASON" })
    : Object.freeze({ ok: true, order_status: "open", held: true, reason });
}

/** Resume only clears a hold marker; the persisted order state remains `open`. */
export function planResume(input: {
  readonly status: CounterOrderStatus;
  readonly held: boolean;
}): ResumePlan {
  if (input.status !== "open") return Object.freeze({ ok: false, reason: "ORDER_NOT_OPEN" });
  if (!input.held) return Object.freeze({ ok: false, reason: "ORDER_NOT_HELD" });
  return Object.freeze({ ok: true, order_status: "open", held: false });
}

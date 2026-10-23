import type { OrderHandlerDeps } from "../order/deps.js";
import type { MemberRuntimeDeps } from "./handler-support.js";

/** PostgreSQL restores balances inside the order repository transaction itself. */
export function withMemberBalanceCancellation(
  order: OrderHandlerDeps,
  member: MemberRuntimeDeps | undefined,
): OrderHandlerDeps {
  if (member === undefined || member.persistence === "sql") return order;
  return Object.freeze({ ...order, balanceCancellation: member.store.reverseOrderPayments });
}

import type { ChannelIntent } from "@laundry/contracts";
import type { ReceiveWorkspace } from "./receive-workspace.js";

/** Keep confirmed channel payments in the clerk workspace across page unmounts. */
export function confirmReceivePayment(store: ReceiveWorkspace, intent: ChannelIntent): void {
  const state = store.getSnapshot();
  const result = state.result;
  if (
    state.phase !== "complete" ||
    result === null ||
    intent.state !== "paid" ||
    intent.purpose !== "order" ||
    intent.order_id !== result.order_id ||
    state.confirmedPaymentIntentIds.includes(intent.intent_id) ||
    !Number.isSafeInteger(intent.amount_cents) ||
    intent.amount_cents <= 0 ||
    intent.amount_cents > result.balance_cents
  )
    return;
  store.patch({
    result: Object.freeze({
      ...result,
      paid_cents: result.paid_cents + intent.amount_cents,
      balance_cents: result.balance_cents - intent.amount_cents,
    }),
    confirmedPaymentIntentIds: Object.freeze([
      ...state.confirmedPaymentIntentIds,
      intent.intent_id,
    ]),
  });
}

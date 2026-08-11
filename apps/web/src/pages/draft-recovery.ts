import type { OrderGetResult } from "./order-read-model.js";
import type { ReceiveLineDraft } from "./receive-garment-form.js";

export type RecoveredDraftForm = Readonly<{
  draft_id: string;
  customer_phone: string;
  customer_name: string;
  note: string;
  discount_cents: string;
  urgent: boolean;
  freight: boolean;
  lines: readonly ReceiveLineDraft[];
}>;

export type RecoverDraftResult =
  Readonly<{ ok: true; value: RecoveredDraftForm }> | Readonly<{ ok: false; message: string }>;

/** Convert only a still-unreceived server draft into immutable counter form state. */
export function recoverDraftForm(order: OrderGetResult): RecoverDraftResult {
  if (
    order.status !== "draft" ||
    order.ticket_no !== null ||
    order.pickup_code !== null ||
    order.paid_cents !== 0 ||
    order.balance_cents !== order.payable_cents ||
    order.garments.length !== 0
  ) {
    return Object.freeze({ ok: false, message: "该挂单已开单或状态已变化，请刷新列表" });
  }
  if (order.lines.length === 0) {
    return Object.freeze({ ok: false, message: "挂单没有可恢复的衣物明细" });
  }
  const lines: ReceiveLineDraft[] = order.lines.map((line) =>
    Object.freeze({
      key: `draft-${order.order_id}-line-${line.line_index}`,
      service_code: line.service_code,
      category_code: line.category_code,
      unit_price_cents: line.unit_price_cents,
      qty: String(line.qty),
      garments: Object.freeze(
        line.garments.map((garment, pieceIndex) =>
          Object.freeze({
            key: `draft-${order.order_id}-line-${line.line_index}-piece-${pieceIndex}`,
            color: garment.color ?? "",
            brand: garment.brand ?? "",
            defects_text: garment.defects.join("，"),
            accessories_text: garment.accessories.join("，"),
            note: garment.note ?? "",
            addon_codes: Object.freeze(garment.addons.map((addon) => addon.code)),
          }),
        ),
      ),
    }),
  );
  return Object.freeze({
    ok: true,
    value: Object.freeze({
      draft_id: order.order_id,
      customer_phone: order.customer_phone ?? "",
      customer_name: order.customer_name ?? "",
      note: order.note ?? "",
      discount_cents: String(order.discount_cents),
      urgent: order.urgent_selected,
      freight: order.freight_selected,
      lines: Object.freeze(lines),
    }),
  });
}

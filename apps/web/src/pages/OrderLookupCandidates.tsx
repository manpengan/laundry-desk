/** Safe parser and explicit-choice list for the bounded order.lookup query. */

import { Button, MoneyText, StatusBadge } from "@laundry/ui";

import { parseOrderListRows, type OrderListRowView } from "./OrdersList.js";

const MATCH_LABELS = Object.freeze({
  ticket_no: "票号",
  pickup_code: "取件码",
  garment_barcode: "衣物条码",
  customer_phone: "手机号",
  customer_name: "客户姓名",
});

export type OrderLookupMatchKind = keyof typeof MATCH_LABELS;

export type OrderLookupRowView = OrderListRowView &
  Readonly<{
    pickup_code: string | null;
    matched_by: OrderLookupMatchKind;
  }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMatchKind(value: unknown): value is OrderLookupMatchKind {
  return typeof value === "string" && value in MATCH_LABELS;
}

export function parseOrderLookupRows(value: unknown): readonly OrderLookupRowView[] | null {
  const base = parseOrderListRows(value);
  if (base === null || !isRecord(value) || !Array.isArray(value.orders)) return null;
  const rows: OrderLookupRowView[] = [];
  for (const [index, raw] of value.orders.entries()) {
    const row = base[index];
    if (row === undefined || !isRecord(raw)) return null;
    const pickupCode = raw.pickup_code;
    if (typeof pickupCode !== "string" && pickupCode !== null) return null;
    if (!isMatchKind(raw.matched_by)) return null;
    rows.push(Object.freeze({ ...row, pickup_code: pickupCode, matched_by: raw.matched_by }));
  }
  return Object.freeze(rows);
}

export function OrderLookupCandidates({
  orders,
  disabled,
  onSelect,
}: Readonly<{
  orders: readonly OrderLookupRowView[];
  disabled: boolean;
  onSelect: (orderId: string) => void;
}>) {
  if (orders.length < 2) return null;
  return (
    <section
      className="ld-order-lookup"
      aria-label="选择匹配订单"
      data-testid="pickup-lookup-candidates"
    >
      <h2 className="ld-order-lookup__title">找到多张订单，请选择</h2>
      <ul className="ld-order-lookup__list">
        {orders.map((order) => (
          <li key={order.order_id}>
            <Button
              variant="secondary"
              type="button"
              onClick={() => onSelect(order.order_id)}
              disabled={disabled}
            >
              <span>{order.ticket_no ?? "挂单"}</span>
              <span> · {MATCH_LABELS[order.matched_by]}</span>
              <span> · {order.customer_name ?? order.customer_phone ?? "散客"}</span>
              {order.pickup_code === null ? null : <span> · {order.pickup_code}</span>}
              <StatusBadge family="order" status={order.status} />
              <MoneyText fen={order.balance_cents} size="sm" />
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

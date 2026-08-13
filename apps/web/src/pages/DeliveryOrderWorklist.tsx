import type { DeliveryOrderStatus } from "@laundry/contracts";

import {
  DELIVERY_ORDER_ROUTE_LABELS,
  DELIVERY_ORDER_STATUS_FILTERS,
  DELIVERY_ORDER_STATUS_LABELS,
  formatDeliveryOrderFee,
  shortDeliveryOrderId,
  type DeliveryOrderView,
} from "./delivery-order-model.js";

export type DeliveryOrderWorklistProps = Readonly<{
  orders: readonly DeliveryOrderView[];
  status: DeliveryOrderStatus | "all";
  selectedId: string | null;
  busy: boolean;
  loaded: boolean;
  onStatusChange(value: DeliveryOrderStatus | "all"): void;
  onSelect(deliveryOrderId: string): void;
}>;

export function DeliveryOrderWorklist({
  orders,
  status,
  selectedId,
  busy,
  loaded,
  onStatusChange,
  onSelect,
}: DeliveryOrderWorklistProps) {
  return (
    <section className="ld-delivery-orders__worklist" aria-label="取送订单列表">
      <label className="ld-delivery-orders__filter">
        状态
        <select
          value={status}
          disabled={busy}
          onChange={(event) => onStatusChange(event.target.value as DeliveryOrderStatus | "all")}
        >
          {DELIVERY_ORDER_STATUS_FILTERS.map((value) => (
            <option key={value} value={value}>
              {value === "all" ? "全部" : DELIVERY_ORDER_STATUS_LABELS[value]}
            </option>
          ))}
        </select>
      </label>
      {!loaded ? <p role="status">正在读取取送订单…</p> : null}
      {loaded && orders.length === 0 ? <p>当前筛选下没有取送订单。</p> : null}
      <ul className="ld-delivery-orders__rows">
        {orders.map((row) => (
          <li key={row.delivery_order_id}>
            <button
              type="button"
              className={row.delivery_order_id === selectedId ? "is-selected" : undefined}
              disabled={busy}
              onClick={() => onSelect(row.delivery_order_id)}
            >
              <strong>{DELIVERY_ORDER_STATUS_LABELS[row.status]}</strong>
              <span>洗衣单 {shortDeliveryOrderId(row.laundry_order_id)}</span>
              <span>
                {DELIVERY_ORDER_ROUTE_LABELS.collection[row.collection_method]} →{" "}
                {DELIVERY_ORDER_ROUTE_LABELS.return[row.return_method]}
              </span>
              <span>
                {formatDeliveryOrderFee(row.total_fee_cents)} · v{row.version}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

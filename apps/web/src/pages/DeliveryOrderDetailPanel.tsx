import { Button } from "@laundry/ui";

import type { DeliveryOrderCancellationReason, DeliveryOrderStatus } from "@laundry/contracts";

import {
  DELIVERY_ORDER_CANCELLATION_LABELS,
  DELIVERY_ORDER_ROUTE_LABELS,
  DELIVERY_ORDER_STATUS_LABELS,
  formatDeliveryOrderFee,
  formatDeliveryOrderTime,
  shortDeliveryOrderId,
  type DeliveryOrderPendingTransition,
  type DeliveryOrderView,
} from "./delivery-order-model.js";

export type DeliveryOrderDetailPanelProps = Readonly<{
  detail: DeliveryOrderView | null;
  nextStatuses: readonly DeliveryOrderStatus[];
  cancellationReason: DeliveryOrderCancellationReason;
  busy: boolean;
  onCancellationReasonChange(value: DeliveryOrderCancellationReason): void;
  onTransition(value: DeliveryOrderStatus): void;
}>;

export function DeliveryOrderDetailPanel({
  detail,
  nextStatuses,
  cancellationReason,
  busy,
  onCancellationReasonChange,
  onTransition,
}: DeliveryOrderDetailPanelProps) {
  return (
    <section className="ld-delivery-orders__detail" aria-label="取送订单详情">
      {detail === null ? (
        <p>选择一张取送订单查看权威详情和合法下一步。</p>
      ) : (
        <>
          <div className="ld-delivery-orders__detail-head">
            <h2>{DELIVERY_ORDER_STATUS_LABELS[detail.status]}</h2>
            <span>版本 {detail.version}</span>
          </div>
          <dl>
            <div>
              <dt>配送订单</dt>
              <dd title={detail.delivery_order_id}>
                {shortDeliveryOrderId(detail.delivery_order_id)}
              </dd>
            </div>
            <div>
              <dt>洗衣订单</dt>
              <dd title={detail.laundry_order_id}>
                {shortDeliveryOrderId(detail.laundry_order_id)}
              </dd>
            </div>
            <div>
              <dt>取件预约</dt>
              <dd title={detail.pickup_appointment_id ?? undefined}>
                {detail.pickup_appointment_id === null
                  ? "不适用"
                  : shortDeliveryOrderId(detail.pickup_appointment_id)}
              </dd>
            </div>
            <div>
              <dt>返件预约</dt>
              <dd title={detail.return_appointment_id ?? undefined}>
                {detail.return_appointment_id === null
                  ? "不适用"
                  : shortDeliveryOrderId(detail.return_appointment_id)}
              </dd>
            </div>
            <div>
              <dt>路线</dt>
              <dd>
                {DELIVERY_ORDER_ROUTE_LABELS.collection[detail.collection_method]} →{" "}
                {DELIVERY_ORDER_ROUTE_LABELS.return[detail.return_method]}
              </dd>
            </div>
            <div>
              <dt>费用快照</dt>
              <dd>
                取件 {formatDeliveryOrderFee(detail.pickup_fee_cents)} · 返件{" "}
                {formatDeliveryOrderFee(detail.return_fee_cents)}
              </dd>
            </div>
            <div>
              <dt>最后更新</dt>
              <dd>{formatDeliveryOrderTime(detail.updated_at)}</dd>
            </div>
          </dl>

          {nextStatuses.includes("cancelled") ? (
            <label className="ld-delivery-orders__cancel-reason">
              取消原因
              <select
                value={cancellationReason}
                disabled={busy}
                onChange={(event) =>
                  onCancellationReasonChange(event.target.value as DeliveryOrderCancellationReason)
                }
              >
                {Object.entries(DELIVERY_ORDER_CANCELLATION_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          <div className="ld-delivery-orders__actions">
            {nextStatuses.map((targetStatus) => (
              <Button
                key={targetStatus}
                type="button"
                variant={targetStatus === "cancelled" ? "danger" : "primary"}
                disabled={busy}
                onClick={() => onTransition(targetStatus)}
              >
                {DELIVERY_ORDER_STATUS_LABELS[targetStatus]}
              </Button>
            ))}
            {nextStatuses.length === 0 ? <p>该订单已是不可逆终态。</p> : null}
          </div>
        </>
      )}
    </section>
  );
}

export function DeliveryOrderPendingSummary({
  pending,
}: Readonly<{ pending: DeliveryOrderPendingTransition }>) {
  const summary = pending.summary;
  return (
    <dl className="ld-delivery-orders__pending-summary">
      <div>
        <dt>配送订单</dt>
        <dd>{summary.deliveryOrderId}</dd>
      </div>
      <div>
        <dt>洗衣订单</dt>
        <dd>{summary.laundryOrderId}</dd>
      </div>
      <div>
        <dt>路线</dt>
        <dd>
          {DELIVERY_ORDER_ROUTE_LABELS.collection[summary.collectionMethod]} →{" "}
          {DELIVERY_ORDER_ROUTE_LABELS.return[summary.returnMethod]}
        </dd>
      </div>
      <div>
        <dt>转换</dt>
        <dd>
          {DELIVERY_ORDER_STATUS_LABELS[summary.currentStatus]}（版本{" "}
          {pending.body.expected_version}） → {pending.label}
        </dd>
      </div>
      {summary.cancellationReason === null ? null : (
        <div>
          <dt>取消原因</dt>
          <dd>{DELIVERY_ORDER_CANCELLATION_LABELS[summary.cancellationReason]}</dd>
        </div>
      )}
    </dl>
  );
}

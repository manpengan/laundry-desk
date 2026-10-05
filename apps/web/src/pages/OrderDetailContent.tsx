import { MaskedPhone, MoneyText, StatusBadge } from "@laundry/ui";

import type { ReactNode } from "react";
import type { OrderGetGarment, OrderGetResult } from "./order-form.js";
import { serviceLabel } from "./catalog-services.js";
import { discountPolicyLabel, waiverPolicyLabel } from "./order-policy-labels.js";
import { OrderPhotosPanel, type OrderPhotosPanelProps } from "./OrderPhotosPanel.js";

export type OrderDetailContentProps = Omit<OrderPhotosPanelProps, "order"> & {
  order: OrderGetResult;
  photoSection?: ReactNode;
};

/** Pure detail body, kept separate so the action controller stays compact. */
export function OrderDetailContent({
  order,
  photoSection,
  ...photoProps
}: OrderDetailContentProps) {
  return (
    <>
      <section className="ld-order-detail__summary" aria-label="订单摘要">
        <div className="ld-order-detail__amounts">
          <div>
            <span>应付</span>
            <strong data-testid="order-detail-payable">
              <MoneyText fen={order.payable_cents} size="lg" />
            </strong>
          </div>
          <div>
            <span>已付</span>
            <strong data-testid="order-detail-paid">
              <MoneyText fen={order.paid_cents} size="lg" />
            </strong>
          </div>
          <div className={order.balance_cents > 0 ? "is-due" : undefined}>
            <span>余额</span>
            <strong data-testid="order-detail-balance">
              <MoneyText fen={order.balance_cents} size="lg" />
            </strong>
          </div>
        </div>
        <dl className="ld-order-detail__meta">
          <div>
            <dt>票号</dt>
            <dd data-testid="order-detail-ticket">{order.ticket_no ?? "挂单"}</dd>
          </div>
          <div>
            <dt>取件码</dt>
            <dd>{order.pickup_code ?? "—"}</dd>
          </div>
          <div>
            <dt>状态</dt>
            <dd data-testid="order-detail-status">
              <StatusBadge family="order" status={order.status} />
            </dd>
          </div>
          <div>
            <dt>客户</dt>
            <dd data-testid="order-detail-name">{order.customer_name ?? "散客"}</dd>
          </div>
          <div>
            <dt>手机</dt>
            <dd
              className="ld-order-detail__phone ld-orders-phone-internal"
              data-testid="order-detail-phone"
            >
              {order.customer_phone === null ? "—" : <MaskedPhone phone={order.customer_phone} />}
            </dd>
          </div>
          <div>
            <dt>原价</dt>
            <dd>
              <MoneyText fen={order.original_cents} />
            </dd>
          </div>
          <div>
            <dt>折扣</dt>
            <dd>
              −<MoneyText fen={order.discount_cents} />
            </dd>
          </div>
          <div>
            <dt>附加费用</dt>
            <dd>
              <MoneyText fen={order.addon_cents + order.urgent_cents + order.freight_cents} />
            </dd>
          </div>
          <div>
            <dt>折扣来源</dt>
            <dd data-testid="order-detail-discount-source">{discountPolicyLabel(order)}</dd>
          </div>
          <div>
            <dt>特殊处理</dt>
            <dd data-testid="order-detail-waivers">{waiverPolicyLabel(order)}</dd>
          </div>
        </dl>
        <details className="ld-order-detail__more">
          <summary>更多信息</summary>
          <dl className="ld-order-detail__meta">
            <div>
              <dt>顾客档案版本</dt>
              <dd>v{order.customer_profile_version}</dd>
            </div>
            <div>
              <dt>备注</dt>
              <dd>{order.note ?? "—"}</dd>
            </div>
          </dl>
        </details>
      </section>
      {photoSection ?? <OrderPhotosPanel key={order.order_id} order={order} {...photoProps} />}
      <section className="ld-order-detail__garments" aria-label="衣物列表">
        <h3 className="ld-order-detail__section-title">衣物</h3>
        {order.garments.length === 0 ? (
          <p className="ld-order-detail__empty">暂无衣物</p>
        ) : (
          <ul className="ld-order-detail__garment-list" data-testid="order-detail-garments">
            {order.garments.map((garment) => (
              <GarmentRow key={garment.garment_id} garment={garment} />
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function GarmentRow({ garment }: { garment: OrderGetGarment }) {
  const details = [
    garment.color === null ? null : `颜色：${garment.color}`,
    garment.brand === null ? null : `品牌：${garment.brand}`,
    garment.defects.length === 0 ? null : `瑕疵：${garment.defects.join("、")}`,
    garment.accessories.length === 0 ? null : `附件：${garment.accessories.join("、")}`,
    garment.note === null ? null : `备注：${garment.note}`,
    garment.addons.length === 0
      ? null
      : `附加项：${garment.addons.map((addon) => addon.name).join("、")}`,
  ].filter((item): item is string => item !== null);
  return (
    <li className="ld-order-detail__garment" data-testid="order-detail-garment">
      <div className="ld-order-detail__garment-head">
        <span className="ld-order-detail__barcode">{garment.barcode}</span>
        <StatusBadge family="garment" status={garment.status} />
        <MoneyText fen={garment.unit_price_cents} size="sm" />
      </div>
      <span className="ld-order-detail__garment-kind">
        {garment.catalog_name ??
          `${serviceLabel(garment.service_code)} · ${garment.category_code || "—"}`}
      </span>
      {details.length === 0 ? null : (
        <span className="ld-order-detail__garment-details">{details.join("；")}</span>
      )}
    </li>
  );
}

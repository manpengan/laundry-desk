import { Button, MoneyText, StatusBadge } from "@laundry/ui";

import type { OrderGetGarment, OrderGetResult } from "./order-form.js";
import type { PhotoMetaRow } from "./OrderDetailDrawer.js";

export type OrderDetailContentProps = {
  order: OrderGetResult;
  photos?: readonly PhotoMetaRow[];
  onRegisterPhoto?: () => void;
  registerBusy?: boolean;
};

/** Pure detail body, kept separate so the action controller stays compact. */
export function OrderDetailContent({
  order,
  photos = [],
  onRegisterPhoto,
  registerBusy = false,
}: OrderDetailContentProps) {
  return (
    <>
      <section className="ld-order-detail__summary" aria-label="订单摘要">
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
            <dd data-testid="order-detail-name">{order.customer_name ?? "—"}</dd>
          </div>
          <div>
            <dt>手机</dt>
            <dd
              className="ld-order-detail__phone ld-orders-phone-internal"
              data-testid="order-detail-phone"
            >
              {order.customer_phone ?? "—"}
            </dd>
          </div>
          <div>
            <dt>应付</dt>
            <dd data-testid="order-detail-payable">
              <MoneyText fen={order.payable_cents} />
            </dd>
          </div>
          <div>
            <dt>已付</dt>
            <dd data-testid="order-detail-paid">
              <MoneyText fen={order.paid_cents} />
            </dd>
          </div>
          <div>
            <dt>余额</dt>
            <dd data-testid="order-detail-balance">
              <MoneyText fen={order.balance_cents} />
            </dd>
          </div>
        </dl>
      </section>
      <section className="ld-order-detail__photos" aria-label="照片">
        <div className="ld-order-detail__section-head">
          <h3 className="ld-order-detail__section-title">照片</h3>
          <span className="ld-order-detail__photo-count" data-testid="order-detail-photo-count">
            {photos.length} 张
          </span>
        </div>
        <div className="ld-order-detail__photo-strip" data-testid="order-detail-photos">
          {photos.length === 0 ? (
            <p className="ld-order-detail__photo-empty">暂无照片（元数据骨架）</p>
          ) : (
            <ul className="ld-order-detail__photo-list">
              {photos.map((photo) => (
                <li
                  key={photo.photo_id}
                  className="ld-order-detail__photo-thumb"
                  data-testid="order-detail-photo-thumb"
                  title={`${photo.kind} · ${photo.storage_key}`}
                >
                  <span className="ld-order-detail__photo-kind">{photo.kind}</span>
                  <span className="ld-order-detail__photo-bytes">{photo.byte_size} B</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        {onRegisterPhoto !== undefined ? (
          <Button
            variant="secondary"
            type="button"
            onClick={onRegisterPhoto}
            disabled={registerBusy || order.garments.length === 0}
            data-testid="order-detail-register-photo-btn"
          >
            {registerBusy ? "登记中…" : "登记照片(骨架)"}
          </Button>
        ) : null}
      </section>
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
  return (
    <li className="ld-order-detail__garment" data-testid="order-detail-garment">
      <span className="ld-order-detail__barcode">{garment.barcode}</span>
      <StatusBadge family="garment" status={garment.status} />
      <MoneyText fen={garment.unit_price_cents} size="sm" />
    </li>
  );
}

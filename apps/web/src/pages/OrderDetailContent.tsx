import { MoneyText, StatusBadge } from "@laundry/ui";

import type { PhotoPort } from "../host/photo-port.js";
import type { OrderGetGarment, OrderGetResult } from "./order-form.js";
import { discountPolicyLabel, waiverPolicyLabel } from "./order-policy-labels.js";
import { PhotoGallery } from "./PhotoGallery.js";
import type { PhotoMetaRow } from "./photo-list.js";

export type OrderDetailContentProps = {
  order: OrderGetResult;
  photos?: readonly PhotoMetaRow[];
  photoLoading?: boolean;
  photoError?: string | null;
  onRetryPhotos?: () => void;
  onRegisterPhoto?: (file: File) => void;
  uploadError?: string | null;
  onRetryUpload?: () => void;
  onDeletePhoto?: (photoId: string) => Promise<boolean>;
  registerBusy?: boolean;
  photoPort?: PhotoPort;
};

/** Pure detail body, kept separate so the action controller stays compact. */
export function OrderDetailContent({
  order,
  photos = [],
  photoLoading = false,
  photoError = null,
  onRetryPhotos,
  onRegisterPhoto,
  uploadError = null,
  onRetryUpload,
  onDeletePhoto,
  registerBusy = false,
  photoPort,
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
            <dt>折扣来源</dt>
            <dd data-testid="order-detail-discount-source">{discountPolicyLabel(order)}</dd>
          </div>
          <div>
            <dt>档案快照</dt>
            <dd>v{order.customer_profile_version}</dd>
          </div>
          <div>
            <dt>运营豁免</dt>
            <dd data-testid="order-detail-waivers">{waiverPolicyLabel(order)}</dd>
          </div>
          <div>
            <dt>附加费用</dt>
            <dd>
              <MoneyText fen={order.addon_cents + order.urgent_cents + order.freight_cents} />
            </dd>
          </div>
          <div>
            <dt>备注</dt>
            <dd>{order.note ?? "—"}</dd>
          </div>
        </dl>
      </section>
      <section className="ld-order-detail__photos" aria-label="照片">
        <div className="ld-order-detail__section-head">
          <h3 className="ld-order-detail__section-title">照片</h3>
          <span className="ld-order-detail__photo-count" data-testid="order-detail-photo-count">
            {photoLoading || photoError !== null ? "—" : `${photos.length} 张`}
          </span>
        </div>
        <div className="ld-order-detail__photo-strip" data-testid="order-detail-photos">
          {photoLoading ? (
            <p className="ld-order-detail__photo-empty">照片加载中…</p>
          ) : photoError !== null ? (
            <div className="ld-order-detail__photo-error" role="alert">
              <p>照片暂时无法加载：{photoError}</p>
              {onRetryPhotos !== undefined ? (
                <button type="button" onClick={onRetryPhotos}>
                  重试照片
                </button>
              ) : null}
            </div>
          ) : photos.length === 0 ? (
            <p className="ld-order-detail__photo-empty">暂无照片</p>
          ) : (
            <PhotoGallery
              photos={photos}
              {...(photoPort === undefined ? {} : { photoPort })}
              {...(onDeletePhoto === undefined ? {} : { onDelete: onDeletePhoto })}
            />
          )}
        </div>
        {onRegisterPhoto !== undefined ? (
          <label className="ld-order-detail__photo-upload">
            <span>{registerBusy ? "上传中…" : "上传照片"}</span>
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                if (file !== undefined) onRegisterPhoto(file);
                event.currentTarget.value = "";
              }}
              disabled={registerBusy || order.garments.length === 0}
              data-testid="order-detail-register-photo-btn"
            />
          </label>
        ) : null}
        {uploadError !== null ? (
          <div className="ld-order-detail__photo-error" role="alert">
            <p>照片上传失败：{uploadError}</p>
            {onRetryUpload !== undefined ? (
              <button type="button" disabled={registerBusy} onClick={onRetryUpload}>
                重试上传
              </button>
            ) : null}
          </div>
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
      <span>
        {garment.service_code || "—"}/{garment.category_code || "—"}
      </span>
      {details.length === 0 ? null : (
        <span className="ld-order-detail__garment-details">{details.join("；")}</span>
      )}
    </li>
  );
}

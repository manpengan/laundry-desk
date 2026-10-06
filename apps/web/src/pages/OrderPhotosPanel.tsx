import { Icon } from "@laundry/ui";
import { useState } from "react";
import type { PhotoKind, PhotoPort } from "../host/photo-port.js";
import type { PhotoMetaRow } from "./photo-list.js";
import type { PhotoOrder } from "./use-order-photos.js";
import { PHOTO_KIND_LABELS, photoGarmentLabel, type PhotoSelection } from "./order-photo-labels.js";
import { PhotoGallery } from "./PhotoGallery.js";

export type OrderPhotosPanelProps = Readonly<{
  order: PhotoOrder;
  photos?: readonly PhotoMetaRow[];
  photoLoading?: boolean;
  photoError?: string | null;
  onRetryPhotos?: () => void;
  onRegisterPhoto?: (file: File, selection: PhotoSelection) => void;
  uploadError?: string | null;
  uploadTarget?: string;
  onRetryUpload?: () => void;
  onDiscardUpload?: () => void;
  onDeletePhoto?: (photoId: string) => Promise<boolean>;
  registerBusy?: boolean;
  photoPort?: PhotoPort;
}>;

export function OrderPhotosPanel({
  order,
  photos = [],
  photoLoading = false,
  photoError = null,
  onRetryPhotos,
  onRegisterPhoto,
  uploadError = null,
  uploadTarget,
  onRetryUpload,
  onDiscardUpload,
  onDeletePhoto,
  registerBusy = false,
  photoPort,
}: OrderPhotosPanelProps) {
  // Multi-garment orders require an explicit choice instead of silently using the first item.
  const [garmentId, setGarmentId] = useState(
    order.garments.length === 1 ? (order.garments[0]?.garment_id ?? "") : "",
  );
  const [kind, setKind] = useState<PhotoKind>("receive");
  const garment = order.garments.find((item) => item.garment_id === garmentId);
  return (
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
            {onRetryPhotos === undefined ? null : (
              <button type="button" onClick={onRetryPhotos}>
                重试照片
              </button>
            )}
          </div>
        ) : photos.length === 0 ? (
          <p className="ld-order-detail__photo-empty">暂无照片</p>
        ) : (
          <PhotoGallery
            key={order.order_id}
            photos={photos}
            garments={order.garments}
            {...(photoPort === undefined ? {} : { photoPort })}
            {...(onDeletePhoto === undefined ? {} : { onDelete: onDeletePhoto })}
          />
        )}
      </div>
      {onRegisterPhoto === undefined ? null : (
        <div className="ld-order-photo-controls">
          <label>
            照片对应衣物
            <select
              aria-label="照片对应衣物"
              value={garmentId}
              disabled={registerBusy}
              onChange={(event) => setGarmentId(event.currentTarget.value)}
            >
              <option value="">请选择衣物</option>
              {order.garments.map((item) => (
                <option key={item.garment_id} value={item.garment_id}>
                  {photoGarmentLabel(item)}
                </option>
              ))}
            </select>
          </label>
          <label>
            照片种类
            <select
              aria-label="照片种类"
              value={kind}
              disabled={registerBusy}
              onChange={(event) => {
                const value = event.currentTarget.value;
                if (Object.hasOwn(PHOTO_KIND_LABELS, value)) setKind(value as PhotoKind);
              }}
            >
              {Object.entries(PHOTO_KIND_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <p className="ld-order-detail__photo-empty">
            {garment === undefined
              ? "请先选择衣物，再上传照片。"
              : `保存到：${photoGarmentLabel(garment)} / ${PHOTO_KIND_LABELS[kind]}`}
          </p>
          <label className="ld-order-detail__photo-upload">
            <Icon name="camera" size={16} />
            <span>{registerBusy ? "上传中…" : "上传照片"}</span>
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                if (file !== undefined && garment !== undefined)
                  onRegisterPhoto(file, { garmentId, kind });
                event.currentTarget.value = "";
              }}
              disabled={registerBusy || garment === undefined || uploadError !== null}
              data-testid="order-detail-register-photo-btn"
            />
          </label>
        </div>
      )}
      {uploadError === null ? null : (
        <div className="ld-order-detail__photo-error" role="alert">
          <p>照片上传失败：{uploadError}</p>
          {uploadTarget === undefined ? null : <p>重试仍保存到：{uploadTarget}</p>}
          {onRetryUpload === undefined ? null : (
            <button type="button" disabled={registerBusy} onClick={onRetryUpload}>
              重试上传
            </button>
          )}
          {onDiscardUpload === undefined ? null : (
            <button type="button" disabled={registerBusy} onClick={onDiscardUpload}>
              放弃本次上传
            </button>
          )}
        </div>
      )}
    </section>
  );
}

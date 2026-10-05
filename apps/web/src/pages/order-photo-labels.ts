import type { PhotoKind } from "../host/photo-port.js";
import type { OrderGetGarment } from "./order-form.js";
import { serviceLabel } from "./catalog-services.js";

export const PHOTO_KIND_LABELS: Readonly<Record<PhotoKind, string>> = Object.freeze({
  receive: "收衣",
  defect: "污渍 / 破损",
  ready: "洗后",
  other: "其他",
});

export function photoKindLabel(kind: string): string {
  return Object.hasOwn(PHOTO_KIND_LABELS, kind) ? PHOTO_KIND_LABELS[kind as PhotoKind] : "其他";
}

export function photoGarmentLabel(garment: OrderGetGarment): string {
  return [
    garment.barcode,
    serviceLabel(garment.service_code),
    garment.category_code,
    garment.color,
    garment.brand,
  ]
    .filter(Boolean)
    .join(" · ");
}

export type PhotoSelection = Readonly<{ garmentId: string; kind: PhotoKind }>;

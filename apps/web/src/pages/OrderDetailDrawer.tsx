/**
 * Workbench order detail drawer — loads order.get + photo.list_by_order when open.
 * Photo section uses the named PhotoPort; transport credentials stay outside React.
 */

import { Drawer, useToast } from "@laundry/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AuthClient } from "../auth/AuthClient.js";
import type { SessionView } from "../auth/types.js";
import type { CommandPort, QueryPort } from "../commands/types.js";
import { MAX_PHOTO_BYTES, type PhotoContentType, type PhotoPort } from "../host/photo-port.js";
import { OrderDetailActions } from "./OrderDetailActions.js";
import { OrderDetailContent } from "./OrderDetailContent.js";
import { PaymentLedgerPanel } from "./PaymentLedgerPanel.js";
import { parsePhotoList, unwrapPhotoResult } from "./photo-list.js";
import type { PhotoMetaRow } from "./photo-list.js";
import { parseOrderGetResult, unwrapCommandResult, type OrderGetResult } from "./order-form.js";

export { OrderDetailContent, type OrderDetailContentProps } from "./OrderDetailContent.js";
export { parsePhotoList, unwrapPhotoResult, type PhotoMetaRow } from "./photo-list.js";

export type OrderDetailDrawerProps = {
  open: boolean;
  orderId: string | null;
  queryClient: QueryPort;
  commandClient?: CommandPort;
  authClient?: AuthClient;
  session?: SessionView;
  photoPort?: PhotoPort;
  /** UI feature mirror only; server remains authoritative. */
  memberEnabled?: boolean;
  onClose: () => void;
  /** Navigate to pickup with this order id. */
  onPickup?: (orderId: string) => void;
};

export type OrderDetailLoadState =
  | Readonly<{ status: "idle" }>
  | Readonly<{ status: "loading" }>
  | Readonly<{ status: "error"; message: string }>
  | Readonly<{ status: "ready"; order: OrderGetResult }>;

type FailedPhotoUpload = Readonly<{
  file: File;
  uploadId: ReturnType<typeof crypto.randomUUID>;
  message: string;
}>;

export function OrderDetailDrawer({
  open,
  orderId,
  queryClient,
  commandClient,
  authClient,
  session,
  photoPort,
  memberEnabled = false,
  onClose,
  onPickup,
}: OrderDetailDrawerProps) {
  const toast = useToast();
  const [load, setLoad] = useState<OrderDetailLoadState>({ status: "idle" });
  const [photos, setPhotos] = useState<readonly PhotoMetaRow[]>([]);
  const [photoLoading, setPhotoLoading] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [failedPhotoUpload, setFailedPhotoUpload] = useState<FailedPhotoUpload | null>(null);
  const requestRef = useRef(0);

  const loadPhotos = useCallback(
    async (id: string, req: number) => {
      if (req !== requestRef.current) return;
      setPhotoLoading(true);
      setPhotoError(null);
      try {
        const res = await queryClient.execute<unknown>("photo.list_by_order", {
          order_id: id,
        });
        if (req !== requestRef.current) return;
        if (!res.ok) {
          setPhotos([]);
          setPhotoError(res.error.message ?? res.error.code);
          return;
        }
        const parsed = parsePhotoList(unwrapPhotoResult(res.data));
        if (parsed === null) {
          setPhotos([]);
          setPhotoError("照片列表响应格式错误");
          return;
        }
        setPhotos(parsed);
      } catch {
        if (req !== requestRef.current) return;
        setPhotos([]);
        setPhotoError("加载照片失败");
      } finally {
        if (req === requestRef.current) setPhotoLoading(false);
      }
    },
    [queryClient],
  );

  const loadOrder = useCallback(
    async (id: string) => {
      const req = ++requestRef.current;
      setLoad({ status: "loading" });
      setPhotos([]);
      setPhotoLoading(false);
      setPhotoError(null);
      try {
        const res = await queryClient.execute<unknown>("order.get", { order_id: id });
        if (req !== requestRef.current) return;
        if (!res.ok) {
          setLoad({
            status: "error",
            message: res.error.message ?? res.error.code,
          });
          return;
        }
        const parsed = parseOrderGetResult(unwrapCommandResult(res.data));
        if (parsed === null) {
          setLoad({ status: "error", message: "订单详情无法解析" });
          return;
        }
        setLoad({ status: "ready", order: parsed });
        void loadPhotos(id, req);
      } catch {
        if (req !== requestRef.current) return;
        setLoad({ status: "error", message: "加载订单失败" });
      }
    },
    [loadPhotos, queryClient],
  );

  useEffect(() => {
    if (!open || orderId === null || orderId.length === 0) {
      requestRef.current += 1;
      setLoad({ status: "idle" });
      setPhotos([]);
      setPhotoLoading(false);
      setPhotoError(null);
      setFailedPhotoUpload(null);
      return;
    }
    void loadOrder(orderId);
  }, [open, orderId, loadOrder]);

  const title = load.status === "ready" ? `订单 ${load.order.ticket_no ?? "挂单"}` : "订单详情";

  const handleRegisterPhoto = useCallback(
    async (file: File, uploadId = crypto.randomUUID()) => {
      if (photoPort === undefined) {
        toast.push("照片上传不可用", "error");
        return;
      }
      if (load.status !== "ready" || orderId === null) return;
      const garment = load.order.garments[0];
      if (garment === undefined) {
        toast.push("订单暂无衣物，无法上传照片", "error");
        return;
      }
      if (file.type !== "image/jpeg" && file.type !== "image/png" && file.type !== "image/webp") {
        toast.push("仅支持 JPEG、PNG 或 WebP", "error");
        return;
      }
      if (file.size < 1 || file.size > MAX_PHOTO_BYTES) {
        toast.push("照片大小必须在 1 B 至 8 MiB 之间", "error");
        return;
      }
      setPhotoBusy(true);
      try {
        const res = await photoPort.upload({
          upload_id: uploadId,
          order_id: orderId,
          garment_id: garment.garment_id,
          kind: "receive",
          content_type: file.type as PhotoContentType,
          bytes: new Uint8Array(await file.arrayBuffer()),
        });
        if (!res.ok) {
          const message = res.error.message ?? res.error.code;
          setFailedPhotoUpload({ file, uploadId, message });
          toast.push(message, "error");
          return;
        }
        setFailedPhotoUpload(null);
        toast.push("照片已安全保存", "success");
        const req = requestRef.current;
        await loadPhotos(orderId, req);
      } catch {
        setFailedPhotoUpload({ file, uploadId, message: "上传照片失败" });
        toast.push("上传照片失败", "error");
      } finally {
        setPhotoBusy(false);
      }
    },
    [load, loadPhotos, orderId, photoPort, toast],
  );

  const handleDeletePhoto = useCallback(
    async (photoId: string): Promise<boolean> => {
      if (photoPort === undefined || orderId === null) return false;
      setPhotoBusy(true);
      try {
        const result = await photoPort.remove(photoId, crypto.randomUUID());
        if (!result.ok) {
          toast.push(result.error.message ?? result.error.code, "error");
          return false;
        }
        toast.push("照片已删除，操作已记录审计", "success");
        await loadPhotos(orderId, requestRef.current);
        return true;
      } catch {
        toast.push("删除照片失败", "error");
        return false;
      } finally {
        setPhotoBusy(false);
      }
    },
    [loadPhotos, orderId, photoPort, toast],
  );

  return (
    <Drawer open={open} title={title} onClose={onClose} className="ld-order-detail-drawer">
      <div className="ld-order-detail" data-testid="order-detail-drawer">
        {load.status === "idle" || load.status === "loading" ? (
          <p className="ld-order-detail__status" data-testid="order-detail-loading">
            {load.status === "loading" ? "加载中…" : "选择订单查看详情"}
          </p>
        ) : null}

        {load.status === "error" ? (
          <p className="ld-order-detail__error" data-testid="order-detail-error" role="alert">
            {load.message}
          </p>
        ) : null}

        {load.status === "ready" ? (
          <OrderDetailContent
            order={load.order}
            photos={photos}
            photoLoading={photoLoading}
            photoError={photoError}
            uploadError={failedPhotoUpload?.message ?? null}
            onRetryPhotos={() => {
              if (orderId !== null) void loadPhotos(orderId, requestRef.current);
            }}
            {...(photoPort !== undefined
              ? {
                  onRegisterPhoto: (file: File) => void handleRegisterPhoto(file),
                  onDeletePhoto: handleDeletePhoto,
                }
              : {})}
            {...(failedPhotoUpload === null
              ? {}
              : {
                  onRetryUpload: () =>
                    void handleRegisterPhoto(failedPhotoUpload.file, failedPhotoUpload.uploadId),
                })}
            registerBusy={photoBusy}
            {...(photoPort === undefined ? {} : { photoPort })}
          />
        ) : null}
        {load.status === "ready" ? (
          <PaymentLedgerPanel
            orderId={load.order.order_id}
            queryClient={queryClient}
            onCompleted={() => loadOrder(load.order.order_id)}
            {...(commandClient === undefined ? {} : { commandClient })}
            {...(authClient === undefined ? {} : { authClient })}
            {...(session === undefined ? {} : { session })}
          />
        ) : null}
        <OrderDetailActions
          orderId={orderId}
          order={load.status === "ready" ? load.order : null}
          queryClient={queryClient}
          memberEnabled={memberEnabled}
          onClose={onClose}
          onReload={loadOrder}
          {...(commandClient === undefined ? {} : { commandClient })}
          {...(onPickup === undefined ? {} : { onPickup })}
        />
      </div>
    </Drawer>
  );
}

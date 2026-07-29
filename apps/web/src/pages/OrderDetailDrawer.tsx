/**
 * Workbench order detail drawer — loads order.get + photo.list_by_order when open.
 * Photo section uses the named PhotoPort; transport credentials stay outside React.
 */

import { Button, Drawer, useToast } from "@laundry/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { isStepUpRequired } from "../commands/command-client.js";
import type { CommandPort, QueryPort } from "../commands/types.js";
import { MAX_PHOTO_BYTES, type PhotoContentType, type PhotoPort } from "../host/photo-port.js";
import { DangerConfirmDialog } from "./DangerConfirmDialog.js";
import { OrderDetailContent } from "./OrderDetailContent.js";
import { PaymentCollectionDialog } from "./PaymentCollectionDialog.js";
import { parseOrderGetResult, unwrapCommandResult, type OrderGetResult } from "./order-form.js";

export { OrderDetailContent, type OrderDetailContentProps } from "./OrderDetailContent.js";

export type OrderDetailDrawerProps = {
  open: boolean;
  orderId: string | null;
  queryClient: QueryPort;
  commandClient?: CommandPort;
  photoPort?: PhotoPort;
  onClose: () => void;
  /** Navigate to pickup with this order id. */
  onPickup?: (orderId: string) => void;
};

export type OrderDetailLoadState =
  | Readonly<{ status: "idle" }>
  | Readonly<{ status: "loading" }>
  | Readonly<{ status: "error"; message: string }>
  | Readonly<{ status: "ready"; order: OrderGetResult }>;

export type PhotoMetaRow = Readonly<{
  photo_id: string;
  garment_id: string;
  order_id: string;
  kind: string;
  content_type: string;
  byte_size: number;
  taken_at: number;
}>;

type CancelState =
  Readonly<{ status: "idle" }> | Readonly<{ status: "server_confirmation"; confirmRef: string }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asInt(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

/** Unwrap bus `{ execution, result }` or bare result. */
export function unwrapPhotoResult(data: unknown): unknown {
  if (!isRecord(data)) return data;
  if ("result" in data) return data.result;
  return data;
}

export function parsePhotoList(value: unknown): readonly PhotoMetaRow[] | null {
  if (!isRecord(value)) return null;
  if (!Array.isArray(value.photos)) return null;
  const rows: PhotoMetaRow[] = [];
  for (const item of value.photos) {
    if (!isRecord(item)) return null;
    if (typeof item.photo_id !== "string") return null;
    if (typeof item.garment_id !== "string") return null;
    if (typeof item.order_id !== "string") return null;
    if (typeof item.kind !== "string") return null;
    if (typeof item.content_type !== "string") return null;
    const byteSize = asInt(item.byte_size);
    const takenAt = asInt(item.taken_at);
    if (byteSize === null || takenAt === null || byteSize < 1) return null;
    rows.push(
      Object.freeze({
        photo_id: item.photo_id,
        garment_id: item.garment_id,
        order_id: item.order_id,
        kind: item.kind,
        content_type: item.content_type,
        byte_size: byteSize,
        taken_at: takenAt,
      }),
    );
  }
  return Object.freeze(rows);
}

export function OrderDetailDrawer({
  open,
  orderId,
  queryClient,
  commandClient,
  photoPort,
  onClose,
  onPickup,
}: OrderDetailDrawerProps) {
  const toast = useToast();
  const [load, setLoad] = useState<OrderDetailLoadState>({ status: "idle" });
  const [photos, setPhotos] = useState<readonly PhotoMetaRow[]>([]);
  const [photoLoading, setPhotoLoading] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelBusy, setCancelBusy] = useState(false);
  const [cancelState, setCancelState] = useState<CancelState>({ status: "idle" });
  const [paymentOpen, setPaymentOpen] = useState(false);
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
      return;
    }
    void loadOrder(orderId);
  }, [open, orderId, loadOrder]);

  const title = load.status === "ready" ? `订单 ${load.order.ticket_no ?? "挂单"}` : "订单详情";

  const handlePickup = useCallback(() => {
    if (orderId === null || orderId.length === 0) return;
    if (onPickup === undefined) {
      toast.push("取衣入口不可用", "error");
      return;
    }
    onPickup(orderId);
  }, [onPickup, orderId, toast]);

  const handleRegisterPhoto = useCallback(
    async (file: File) => {
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
          order_id: orderId,
          garment_id: garment.garment_id,
          kind: "receive",
          content_type: file.type as PhotoContentType,
          bytes: new Uint8Array(await file.arrayBuffer()),
        });
        if (!res.ok) {
          toast.push(res.error.message ?? res.error.code, "error");
          return;
        }
        toast.push("照片已安全保存", "success");
        const req = requestRef.current;
        await loadPhotos(orderId, req);
      } catch {
        toast.push("上传照片失败", "error");
      } finally {
        setPhotoBusy(false);
      }
    },
    [load, loadPhotos, orderId, photoPort, toast],
  );

  const closeCancel = useCallback(() => {
    if (cancelBusy) return;
    setCancelOpen(false);
    setCancelState({ status: "idle" });
  }, [cancelBusy]);

  const handleCancel = useCallback(
    async (reason: string) => {
      if (commandClient === undefined || orderId === null || load.status !== "ready") return;
      setCancelBusy(true);
      try {
        const res =
          cancelState.status === "server_confirmation"
            ? await commandClient.execute<unknown>(
                "order.cancel",
                {},
                { confirmRef: cancelState.confirmRef },
              )
            : await commandClient.execute<unknown>("order.cancel", { order_id: orderId, reason });
        if (res.ok) {
          toast.push("订单已撤销，相关流水已按规则反向记账", "success");
          setCancelOpen(false);
          setCancelState({ status: "idle" });
          await loadOrder(orderId);
          return;
        }
        if (cancelState.status === "idle" && isStepUpRequired(res)) {
          if (res.error.code !== "POLICY_CONFIRMATION_REQUIRED") {
            toast.push("此撤销需要主管二次授权，请由主管在授权入口完成", "error");
            return;
          }
          setCancelState({
            status: "server_confirmation",
            confirmRef: res.error.detail.confirm_ref,
          });
          toast.push("服务端要求再次确认", "info");
          return;
        }
        toast.push(res.error.message ?? res.error.code, "error");
      } finally {
        setCancelBusy(false);
      }
    },
    [cancelState, commandClient, load.status, loadOrder, orderId, toast],
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
            onRetryPhotos={() => {
              if (orderId !== null) void loadPhotos(orderId, requestRef.current);
            }}
            {...(photoPort !== undefined
              ? { onRegisterPhoto: (file: File) => void handleRegisterPhoto(file) }
              : {})}
            registerBusy={photoBusy}
          />
        ) : null}

        <div className="ld-order-detail__actions">
          {onPickup !== undefined ? (
            <Button
              variant="primary"
              type="button"
              onClick={handlePickup}
              disabled={orderId === null || orderId.length === 0}
              data-testid="order-detail-pickup-btn"
            >
              去取衣
            </Button>
          ) : null}
          <Button
            variant="ghost"
            type="button"
            onClick={onClose}
            data-testid="order-detail-close-btn"
          >
            关闭
          </Button>
          {commandClient !== undefined &&
          load.status === "ready" &&
          load.order.status === "open" &&
          load.order.balance_cents > 0 ? (
            <Button
              variant="secondary"
              type="button"
              onClick={() => setPaymentOpen(true)}
              data-testid="order-detail-payment-btn"
            >
              补缴 / 收款
            </Button>
          ) : null}
          {commandClient !== undefined &&
          load.status === "ready" &&
          load.order.status === "open" ? (
            <Button
              variant="danger"
              type="button"
              onClick={() => setCancelOpen(true)}
              disabled={cancelBusy}
              data-testid="order-detail-cancel-btn"
            >
              撤销订单
            </Button>
          ) : null}
        </div>
      </div>
      <DangerConfirmDialog
        open={cancelOpen}
        title="撤销订单"
        description="撤销会关闭订单，并按服务端规则生成可审计的反向流水。此操作不能撤回。"
        confirmLabel={cancelState.status === "server_confirmation" ? "再次确认撤销" : "确认撤销"}
        busy={cancelBusy}
        serverConfirmation={cancelState.status === "server_confirmation"}
        onClose={closeCancel}
        onConfirm={(reason) => void handleCancel(reason)}
      />
      {commandClient !== undefined && load.status === "ready" ? (
        <PaymentCollectionDialog
          open={paymentOpen}
          order={load.order}
          commandClient={commandClient}
          onClose={() => setPaymentOpen(false)}
          onCompleted={() => {
            if (orderId !== null) void loadOrder(orderId);
          }}
        />
      ) : null}
    </Drawer>
  );
}

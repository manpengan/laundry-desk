/**
 * Workbench order detail drawer — loads order.get + photo.list_by_order when open.
 * Photo section is M3 metadata skeleton (count + placeholder thumbs; no blobs).
 */

import { Button, Drawer, useToast } from "@laundry/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { isStepUpRequired } from "../commands/command-client.js";
import type { CommandPort, QueryPort } from "../commands/types.js";
import { DangerConfirmDialog } from "./DangerConfirmDialog.js";
import { OrderDetailContent } from "./OrderDetailContent.js";
import { parseOrderGetResult, unwrapCommandResult, type OrderGetResult } from "./order-form.js";

export { OrderDetailContent, type OrderDetailContentProps } from "./OrderDetailContent.js";

export type OrderDetailDrawerProps = {
  open: boolean;
  orderId: string | null;
  queryClient: QueryPort;
  /** Required for photo.register skeleton button. */
  commandClient?: CommandPort;
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
  storage_key: string;
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
    if (typeof item.storage_key !== "string") return null;
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
        storage_key: item.storage_key,
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
  onClose,
  onPickup,
}: OrderDetailDrawerProps) {
  const toast = useToast();
  const [load, setLoad] = useState<OrderDetailLoadState>({ status: "idle" });
  const [photos, setPhotos] = useState<readonly PhotoMetaRow[]>([]);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelBusy, setCancelBusy] = useState(false);
  const [cancelState, setCancelState] = useState<CancelState>({ status: "idle" });
  const requestRef = useRef(0);

  const loadPhotos = useCallback(
    async (id: string, req: number) => {
      try {
        const res = await queryClient.execute<unknown>("photo.list_by_order", {
          order_id: id,
        });
        if (req !== requestRef.current) return;
        if (!res.ok) {
          setPhotos([]);
          return;
        }
        const parsed = parsePhotoList(unwrapPhotoResult(res.data));
        setPhotos(parsed ?? []);
      } catch {
        if (req !== requestRef.current) return;
        setPhotos([]);
      }
    },
    [queryClient],
  );

  const loadOrder = useCallback(
    async (id: string) => {
      const req = ++requestRef.current;
      setLoad({ status: "loading" });
      setPhotos([]);
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
      setLoad({ status: "idle" });
      setPhotos([]);
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

  const handleRegisterPhoto = useCallback(async () => {
    if (commandClient === undefined) {
      toast.push("照片登记不可用", "error");
      return;
    }
    if (load.status !== "ready" || orderId === null) return;
    const garment = load.order.garments[0];
    if (garment === undefined) {
      toast.push("订单暂无衣物，无法登记照片", "error");
      return;
    }
    setPhotoBusy(true);
    try {
      const fakeKey = `skeleton/${orderId}/${garment.garment_id}/${Date.now()}.jpg`;
      const res = await commandClient.execute<unknown>("photo.register", {
        order_id: orderId,
        garment_id: garment.garment_id,
        kind: "receive",
        storage_key: fakeKey,
        content_type: "image/jpeg",
        byte_size: 1024,
      });
      if (!res.ok) {
        toast.push(res.error.message ?? res.error.code, "error");
        return;
      }
      toast.push("已登记照片元数据（骨架）", "success");
      const req = requestRef.current;
      await loadPhotos(orderId, req);
    } catch {
      toast.push("登记照片失败", "error");
    } finally {
      setPhotoBusy(false);
    }
  }, [commandClient, load, loadPhotos, orderId, toast]);

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
            {...(commandClient !== undefined
              ? { onRegisterPhoto: () => void handleRegisterPhoto() }
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
    </Drawer>
  );
}

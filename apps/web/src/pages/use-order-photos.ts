import { useToast } from "@laundry/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import type { QueryPort } from "../commands/types.js";
import { MAX_PHOTO_BYTES, type PhotoContentType, type PhotoPort } from "../host/photo-port.js";
import { parsePhotoList, unwrapPhotoResult, type PhotoMetaRow } from "./photo-list.js";
import { photoGarmentLabel, photoKindLabel, type PhotoSelection } from "./order-photo-labels.js";
import type { OrderGetResult } from "./order-form.js";

export type PhotoOrder = Pick<OrderGetResult, "order_id" | "garments">;
type UploadAttempt = Readonly<{
  file: File;
  uploadId: string;
  orderId: string;
  selection: PhotoSelection;
  contentType: PhotoContentType;
  label: string;
}>;
type FailedUpload = Readonly<{ attempt: UploadAttempt; message: string }>;

/** Mount once per order. Every asynchronous operation keeps that order's identity. */
export function useOrderPhotos(order: PhotoOrder, queryClient: QueryPort, photoPort?: PhotoPort) {
  const toast = useToast();
  const [photos, setPhotos] = useState<readonly PhotoMetaRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<FailedUpload | null>(null);
  const generation = useRef(0);
  const listRequest = useRef(0);
  const mutation = useRef(false);

  const reload = useCallback(async () => {
    const scope = generation.current;
    const request = ++listRequest.current;
    const current = () => scope === generation.current && request === listRequest.current;
    setLoading(true);
    setError(null);
    try {
      const response = await queryClient.execute<unknown>("photo.list_by_order", {
        order_id: order.order_id,
      });
      if (!current()) return;
      if (!response.ok) {
        setError(response.error.message ?? response.error.code);
        return;
      }
      const parsed = parsePhotoList(unwrapPhotoResult(response.data));
      if (parsed === null || parsed.some((photo) => photo.order_id !== order.order_id)) {
        setError("照片列表响应格式错误");
        return;
      }
      setPhotos(parsed);
    } catch {
      if (current()) setError("加载照片失败");
    } finally {
      if (current()) setLoading(false);
    }
  }, [order.order_id, queryClient]);

  useEffect(() => {
    generation.current += 1;
    mutation.current = false;
    setBusy(false);
    setFailed(null);
    setPhotos([]);
    void reload();
    return () => {
      generation.current += 1;
    };
  }, [reload, photoPort]);

  const uploadAttempt = async (attempt: UploadAttempt) => {
    if (photoPort === undefined || mutation.current || attempt.orderId !== order.order_id) return;
    const scope = generation.current;
    const current = () => scope === generation.current;
    mutation.current = true;
    setBusy(true);
    try {
      const bytes = new Uint8Array(await attempt.file.arrayBuffer());
      if (!current()) return;
      const result = await photoPort.upload({
        upload_id: attempt.uploadId,
        order_id: attempt.orderId,
        garment_id: attempt.selection.garmentId,
        kind: attempt.selection.kind,
        content_type: attempt.contentType,
        bytes,
      });
      if (!current()) return;
      if (!result.ok) {
        const message = result.error.message ?? result.error.code;
        setFailed({ attempt, message });
        toast.push(message, "error");
        return;
      }
      setFailed(null);
      toast.push("照片已安全保存", "success");
      await reload();
    } catch {
      if (current()) {
        setFailed({ attempt, message: "上传照片失败" });
        toast.push("上传照片失败", "error");
      }
    } finally {
      if (current()) {
        mutation.current = false;
        setBusy(false);
      }
    }
  };

  const upload = (file: File, selection: PhotoSelection) => {
    const garment = order.garments.find((item) => item.garment_id === selection.garmentId);
    if (garment === undefined) {
      toast.push("请先选择照片对应的衣物", "error");
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
    void uploadAttempt(
      Object.freeze({
        file,
        uploadId: crypto.randomUUID(),
        orderId: order.order_id,
        selection: Object.freeze({ ...selection }),
        contentType: file.type,
        label: `${photoGarmentLabel(garment)} / ${photoKindLabel(selection.kind)}`,
      }),
    );
  };

  const remove = async (photoId: string): Promise<boolean> => {
    if (photoPort === undefined || mutation.current) return false;
    const scope = generation.current;
    const current = () => scope === generation.current;
    mutation.current = true;
    setBusy(true);
    try {
      const result = await photoPort.remove(photoId, crypto.randomUUID());
      if (!current()) return false;
      if (!result.ok) {
        toast.push(result.error.message ?? result.error.code, "error");
        return false;
      }
      toast.push("照片已删除，操作已记录审计", "success");
      await reload();
      return true;
    } catch {
      if (current()) toast.push("删除照片失败", "error");
      return false;
    } finally {
      if (current()) {
        mutation.current = false;
        setBusy(false);
      }
    }
  };

  return {
    photos,
    loading,
    error,
    busy,
    failed,
    reload,
    upload,
    remove,
    retry: () => {
      if (failed !== null) void uploadAttempt(failed.attempt);
    },
    discardFailure: () => {
      if (!mutation.current) setFailed(null);
    },
  };
}

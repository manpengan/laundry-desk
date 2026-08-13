import type {
  DeliveryEvidence,
  DeliveryEvidenceAttachment,
  DeliveryEvidenceAttachmentKind,
  DeliveryEvidenceConfirmationSummary,
  DeliveryEvidenceExceptionReason,
  DeliveryEvidenceGps,
  DeliveryEvidenceRecordInput,
} from "@laundry/contracts";
import { useCallback, useEffect, useState } from "react";

import { isStepUpRequired } from "../commands/command-client.js";
import type { CommandFailure, CommandPort, QueryPort } from "../commands/types.js";
import type { DeliveryEvidenceMediaPort } from "../host/delivery-evidence-port.js";
import {
  buildDeliveryEvidenceRecord,
  deliveryEvidenceCanComplete,
  evidenceSummaryMatches,
  parseDeliveryEvidenceList,
  parseDeliveryEvidenceRecord,
} from "./mobile-delivery-evidence-model.js";
import type { MobileTaskDetail } from "./mobile-task-model.js";
import type { MobileTaskRequestAuthority } from "./mobile-task-request-authority.js";

export type MobileDeliveryEvidencePending = Readonly<{
  kind: "evidence";
  confirmRef: string;
  body: DeliveryEvidenceRecordInput;
  summary: DeliveryEvidenceConfirmationSummary;
  scope: string;
  detailKey: string;
}>;

const detailKey = (detail: MobileTaskDetail | null): string => JSON.stringify(detail);
const now = (): number => Math.floor(Date.now() / 1_000);

function contentType(file: File): "image/jpeg" | "image/png" | "image/webp" | null {
  return file.type === "image/jpeg" || file.type === "image/png" || file.type === "image/webp"
    ? file.type
    : null;
}

export function useMobileDeliveryEvidence(
  options: Readonly<{
    authority: MobileTaskRequestAuthority;
    commandClient: CommandPort;
    queryClient: QueryPort;
    mediaPort?: DeliveryEvidenceMediaPort;
    currentStaffId: string;
    detail: MobileTaskDetail | null;
    online: boolean;
    scope: string;
    onFailure(error: CommandFailure, fallback: string): void;
    onError(error: Readonly<{ title: string; message: string }>): void;
    onSuccess(message: string): void;
    reload(): Promise<void>;
  }>,
) {
  const {
    authority,
    commandClient,
    currentStaffId,
    detail,
    mediaPort,
    onError,
    onFailure,
    online,
    queryClient,
    reload,
    scope,
  } = options;
  const [items, setItems] = useState<readonly DeliveryEvidence[]>([]);
  const [attachments, setAttachments] = useState<readonly DeliveryEvidenceAttachment[]>([]);
  const [gps, setGps] = useState<DeliveryEvidenceGps | null>(null);
  const [mode, setModeState] = useState<"complete" | "exception">("complete");
  const [reason, setReasonState] =
    useState<DeliveryEvidenceExceptionReason>("customer_unavailable");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<MobileDeliveryEvidencePending | null>(null);

  const resetForm = useCallback(() => {
    authority.invalidate("evidenceMutation");
    authority.invalidate("media");
    setAttachments([]);
    setGps(null);
    setPending(null);
    setModeState("complete");
    setReasonState("customer_unavailable");
    setBusy(false);
  }, [authority]);

  const load = useCallback(async () => {
    if (!online || detail === null) return;
    const token = authority.begin(
      "evidence",
      JSON.stringify([scope, detail.task.delivery_task_id, detail.task.version]),
    );
    setLoading(true);
    const result = await queryClient.execute<unknown>(
      "delivery.evidence.list",
      { delivery_task_id: detail.task.delivery_task_id, limit: 50 },
      { signal: token.signal },
    );
    if (!authority.isCurrent(token)) return;
    if (!result.ok) {
      onFailure(result.error, "读取交付证据失败");
    } else {
      const parsed = parseDeliveryEvidenceList(result.data);
      if (parsed === null) onError({ title: "响应不可信", message: "交付证据列表无法安全解析。" });
      else setItems(parsed);
    }
    if (authority.isCurrent(token)) setLoading(false);
  }, [authority, detail, onError, onFailure, online, queryClient, scope]);

  useEffect(() => {
    authority.invalidate("evidence");
    resetForm();
    setItems([]);
    if (online && detail !== null) void load();
  }, [authority, detail, load, online, resetForm, scope]);

  const setMode = useCallback((value: "complete" | "exception") => {
    setPending(null);
    setModeState(value);
  }, []);
  const setReason = useCallback((value: DeliveryEvidenceExceptionReason) => {
    setPending(null);
    setReasonState(value);
  }, []);

  const captureGps = useCallback(() => {
    if (!online || detail === null) return;
    if (typeof navigator === "undefined" || navigator.geolocation === undefined) {
      onError({ title: "定位不可用", message: "此浏览器不支持单次定位，请改用现场附件记录异常。" });
      return;
    }
    const token = authority.begin("media", JSON.stringify([scope, detailKey(detail), "gps"]));
    setPending(null);
    setBusy(true);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        if (!authority.isCurrent(token)) return;
        setGps(
          Object.freeze({
            latitude_e7: Math.round(position.coords.latitude * 10_000_000),
            longitude_e7: Math.round(position.coords.longitude * 10_000_000),
            accuracy_mm: Math.min(
              100_000_000,
              Math.max(0, Math.round(position.coords.accuracy * 1_000)),
            ),
            captured_at: Math.floor(position.timestamp / 1_000),
          }),
        );
        setBusy(false);
      },
      () => {
        if (!authority.isCurrent(token)) return;
        setBusy(false);
        onError({ title: "定位失败", message: "未取得本次定位授权或定位不可用。" });
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 15_000 },
    );
  }, [authority, detail, onError, online, scope]);

  const upload = useCallback(
    async (kind: DeliveryEvidenceAttachmentKind, file: File) => {
      if (!online || detail === null || mediaPort === undefined) {
        onError({ title: "附件不可用", message: "当前宿主未启用交付附件上传。" });
        return;
      }
      const declaredType = contentType(file);
      if (declaredType === null) {
        onError({ title: "文件格式不支持", message: "请选择 JPEG、PNG 或 WebP 图片。" });
        return;
      }
      const attachmentId = crypto.randomUUID();
      const capturedAt = now();
      const token = authority.begin(
        "media",
        JSON.stringify([scope, detailKey(detail), kind, attachmentId]),
      );
      setPending(null);
      setBusy(true);
      const result = await mediaPort.upload(
        {
          attachment_id: attachmentId,
          delivery_order_id: detail.order.delivery_order_id,
          delivery_task_id: detail.task.delivery_task_id,
          leg: detail.task.leg,
          expected_delivery_task_version: detail.task.version,
          kind,
          captured_at: capturedAt,
          content_type: declaredType,
          bytes: new Uint8Array(await file.arrayBuffer()),
        },
        { signal: token.signal },
      );
      if (!authority.isCurrent(token)) return;
      setBusy(false);
      if (!result.ok) {
        onFailure(result.error, "上传交付附件失败");
        return;
      }
      setAttachments((current) =>
        Object.freeze([...current.filter((row) => row.kind !== kind), result.data.attachment]),
      );
    },
    [authority, detail, mediaPort, onError, onFailure, online, scope],
  );

  const finish = useCallback(
    async (value: unknown) => {
      const parsed = parseDeliveryEvidenceRecord(value);
      if (parsed === null || parsed.evidence.delivery_task_id !== detail?.task.delivery_task_id) {
        onError({ title: "响应不可信", message: "交付证据响应无法安全解析。" });
        await reload();
        return;
      }
      resetForm();
      options.onSuccess(
        parsed.evidence.outcome === "complete_leg" ? "交付证据与任务已原子完成" : "异常证据已记录",
      );
      await reload();
    },
    [detail?.task.delivery_task_id, onError, options, reload, resetForm],
  );

  const submit = useCallback(async () => {
    if (!online || detail === null || (mode === "complete" && !deliveryEvidenceCanComplete(detail)))
      return;
    const body = buildDeliveryEvidenceRecord({
      detail,
      evidenceId: crypto.randomUUID(),
      mode,
      reason,
      capturedAt: now(),
      gps,
      attachments,
    });
    if (body === null) {
      onError({
        title: "证据不足",
        message:
          detail.task.leg === "return" && mode === "complete"
            ? "送达完成需要定位、照片和签名。"
            : "请先采集定位或现场附件。",
      });
      return;
    }
    const token = authority.begin(
      "evidenceMutation",
      JSON.stringify([scope, detailKey(detail), body]),
    );
    setPending(null);
    setBusy(true);
    const result = await commandClient.execute<unknown>("delivery.evidence.record", body, {
      signal: token.signal,
    });
    if (!authority.isCurrent(token)) return;
    setBusy(false);
    if (result.ok) return finish(result.data);
    if (
      isStepUpRequired(result) &&
      result.error.code === "POLICY_CONFIRMATION_REQUIRED" &&
      result.error.detail.summary?.kind === "delivery_evidence_record" &&
      (await evidenceSummaryMatches(result.error.detail.summary, body, currentStaffId, attachments))
    ) {
      setPending(
        Object.freeze({
          kind: "evidence",
          confirmRef: result.error.detail.confirm_ref,
          body,
          summary: result.error.detail.summary,
          scope,
          detailKey: detailKey(detail),
        }),
      );
      return;
    }
    onFailure(result.error, "提交交付证据失败");
  }, [
    attachments,
    authority,
    commandClient,
    currentStaffId,
    detail,
    finish,
    gps,
    mode,
    onError,
    onFailure,
    online,
    reason,
    scope,
  ]);

  const confirm = useCallback(async () => {
    if (
      pending === null ||
      !online ||
      pending.scope !== scope ||
      pending.detailKey !== detailKey(detail)
    ) {
      setPending(null);
      return;
    }
    const token = authority.begin(
      "evidenceMutation",
      JSON.stringify([scope, pending.confirmRef, pending.detailKey]),
    );
    setBusy(true);
    const result = await commandClient.execute<unknown>(
      "delivery.evidence.record",
      {},
      { confirmRef: pending.confirmRef, signal: token.signal },
    );
    if (!authority.isCurrent(token)) return;
    setBusy(false);
    setPending(null);
    if (!result.ok) {
      onFailure(result.error, "确认交付证据失败");
      await reload();
      return;
    }
    await finish(result.data);
  }, [authority, commandClient, detail, finish, onFailure, online, pending, reload, scope]);

  return Object.freeze({
    items,
    attachments,
    gps,
    mode,
    reason,
    loading,
    busy,
    pending,
    canComplete: deliveryEvidenceCanComplete(detail),
    setMode,
    setReason,
    captureGps,
    upload,
    submit,
    confirm,
    reset: resetForm,
    refresh: load,
  });
}

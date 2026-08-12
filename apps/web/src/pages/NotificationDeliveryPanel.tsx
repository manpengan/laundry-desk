import {
  type NotificationDeliveryBatchEnqueueInput,
  type NotificationDeliveryBatchGetResult,
  type NotificationDeliveryBatchSummary,
  type NotificationDeliveryCapabilityResult,
  type NotificationDeliveryConfirmationSummary,
} from "@laundry/contracts";
import { Button, MoneyText, useToast } from "@laundry/ui";
import { useCallback, useEffect, useMemo, useState } from "react";

import type { AuthClient } from "../auth/AuthClient.js";
import type { SessionView } from "../auth/types.js";
import { isStepUpRequired } from "../commands/command-client.js";
import type { CommandPort, QueryPort } from "../commands/types.js";
import { StepUpConfirmDialog } from "../shell/StepUpConfirmDialog.js";
import { DangerConfirmDialog } from "./DangerConfirmDialog.js";
import {
  buildNotificationEnqueueInput,
  formatNotificationTime,
  manualFallbackOrderIds,
  notificationAcceptedCountLabel,
  notificationBatchStatusLabel,
  notificationCapabilityCopy,
  notificationDeliveredCountLabel,
  notificationDeliveryStatusLabel,
  parseNotificationBatchDetail,
  parseNotificationBatchList,
  parseNotificationCapability,
  parseNotificationEnqueueResult,
} from "./notification-delivery-model.js";
import { PendingSummary } from "./notification-delivery-pending-summary.js";
import type { PickupReminderFilterState } from "./pickup-reminder-model.js";

type PendingBatch = Readonly<{
  confirmRef: string;
  kind: "confirm" | "step_up";
  input: NotificationDeliveryBatchEnqueueInput;
  summary: NotificationDeliveryConfirmationSummary;
}>;

export type NotificationDeliveryPanelProps = Readonly<{
  commandClient: CommandPort;
  queryClient: QueryPort;
  session: SessionView;
  authClient?: AuthClient;
  filters: PickupReminderFilterState;
  selectedOrderIds: readonly string[];
  onManualFallback: (orderIds: readonly string[]) => void;
}>;

function BatchCounts({ batch }: Readonly<{ batch: NotificationDeliveryBatchSummary }>) {
  return (
    <span>
      待处理 {batch.counts.queued + batch.counts.sending + batch.counts.retry_wait} ·{" "}
      {notificationAcceptedCountLabel(batch.assurance)} {batch.counts.accepted} ·{" "}
      {notificationDeliveredCountLabel(batch.assurance)} {batch.counts.delivered} · 人工{" "}
      {batch.counts.manual_required}
    </span>
  );
}

export function NotificationDeliveryPanel({
  commandClient,
  queryClient,
  session,
  authClient,
  filters,
  selectedOrderIds,
  onManualFallback,
}: NotificationDeliveryPanelProps) {
  const toast = useToast();
  const isAdmin = session.role === "admin";
  const [capability, setCapability] = useState<NotificationDeliveryCapabilityResult | null>(null);
  const [batches, setBatches] = useState<readonly NotificationDeliveryBatchSummary[]>([]);
  const [detail, setDetail] = useState<NotificationDeliveryBatchGetResult | null>(null);
  const [pending, setPending] = useState<PendingBatch | null>(null);
  const [busy, setBusy] = useState(false);

  const loadOverview = useCallback(async () => {
    setBusy(true);
    try {
      const capabilityResult = await queryClient.execute<unknown>(
        "notification.delivery.capability.get",
        {},
      );
      if (!capabilityResult.ok) {
        toast.push(capabilityResult.error.message ?? capabilityResult.error.code, "error");
        return;
      }
      const parsedCapability = parseNotificationCapability(capabilityResult.data);
      if (parsedCapability === null) {
        toast.push("通知通道状态无法解析", "error");
        return;
      }
      setCapability(parsedCapability);
      if (!isAdmin || parsedCapability.state === "disabled") {
        setBatches([]);
        setDetail(null);
        return;
      }
      const listResult = await queryClient.execute<unknown>("notification.delivery_batches.list", {
        limit: 10,
      });
      if (!listResult.ok) {
        toast.push(listResult.error.message ?? listResult.error.code, "error");
        return;
      }
      const parsedBatches = parseNotificationBatchList(listResult.data);
      if (parsedBatches === null) {
        toast.push("通知批次列表无法解析", "error");
        return;
      }
      setBatches(parsedBatches);
    } finally {
      setBusy(false);
    }
  }, [isAdmin, queryClient, toast]);

  useEffect(() => {
    void loadOverview();
  }, [loadOverview]);

  const loadDetail = useCallback(
    async (batchId: string) => {
      setBusy(true);
      try {
        const result = await queryClient.execute<unknown>("notification.delivery_batch.get", {
          batch_id: batchId,
        });
        if (!result.ok) {
          toast.push(result.error.message ?? result.error.code, "error");
          return;
        }
        const parsed = parseNotificationBatchDetail(result.data);
        if (parsed === null) {
          toast.push("通知批次详情无法解析", "error");
          return;
        }
        setDetail(parsed);
      } finally {
        setBusy(false);
      }
    },
    [queryClient, toast],
  );

  const complete = useCallback(
    async (data: unknown) => {
      const result = parseNotificationEnqueueResult(data);
      if (result === null) {
        toast.push("通知入队结果无法解析", "error");
        return;
      }
      setPending(null);
      toast.push(
        result.assurance === "software_only"
          ? "批次已进入软件模拟队列；没有发送短信"
          : "批次已入队；等待短信通道接单与回执",
        "success",
      );
      await loadOverview();
      await loadDetail(result.batch_id);
    },
    [loadDetail, loadOverview, toast],
  );

  const execute = useCallback(
    async (input: NotificationDeliveryBatchEnqueueInput, confirmRef?: string) => {
      setBusy(true);
      try {
        const result = await commandClient.execute<unknown>(
          "notification.delivery_batch.enqueue",
          confirmRef === undefined ? input : {},
          confirmRef === undefined ? {} : { confirmRef },
        );
        if (result.ok) {
          await complete(result.data);
          return;
        }
        if (isStepUpRequired(result)) {
          const summary = result.error.detail.summary;
          if (summary?.kind !== "notification_delivery_batch") {
            toast.push("服务端未返回可核对的通知批次摘要，请重试", "error");
            return;
          }
          setPending(
            Object.freeze({
              confirmRef: result.error.detail.confirm_ref,
              kind: result.error.code === "POLICY_STEP_UP_REQUIRED" ? "step_up" : "confirm",
              input,
              summary,
            }),
          );
          return;
        }
        toast.push(result.error.message ?? result.error.code, "error");
      } finally {
        setBusy(false);
      }
    },
    [commandClient, complete, toast],
  );

  const enqueue = useCallback(() => {
    if (capability === null) return;
    const input = buildNotificationEnqueueInput(selectedOrderIds, filters, capability);
    if (input === null) {
      toast.push("所选订单、模板或成本上限不符合通知通道约束", "error");
      return;
    }
    void execute(input);
  }, [capability, execute, filters, selectedOrderIds, toast]);

  const capabilityCopy = capability === null ? null : notificationCapabilityCopy(capability);
  const fallbackIds = useMemo(
    () => (detail === null ? [] : manualFallbackOrderIds(detail)),
    [detail],
  );
  const canEnqueue =
    isAdmin &&
    capability?.state !== "disabled" &&
    capability !== null &&
    selectedOrderIds.length > 0;

  return (
    <section
      className="ld-notification-delivery"
      aria-label="自动通知通道"
      data-testid="notification-delivery-panel"
    >
      <header className="ld-notification-delivery__header">
        <div>
          <h2>自动通知通道</h2>
          {capabilityCopy === null ? (
            <p>正在读取通道保证级别…</p>
          ) : (
            <div
              className="ld-notification-delivery__banner"
              data-state={capability?.state}
              role="status"
            >
              <strong>{capabilityCopy.title}</strong>
              <span>{capabilityCopy.description}</span>
            </div>
          )}
        </div>
        <Button type="button" variant="ghost" onClick={() => void loadOverview()} disabled={busy}>
          刷新通道与批次
        </Button>
      </header>

      {!isAdmin ? (
        <p className="ld-notification-delivery__staff-note">
          只有店长可创建和查看自动通知批次；人工名单仍可正常使用。
        </p>
      ) : (
        <div className="ld-notification-delivery__enqueue">
          <span>当前已选择 {selectedOrderIds.length}/50 单</span>
          <Button type="button" variant="primary" onClick={enqueue} disabled={busy || !canEnqueue}>
            {capabilityCopy?.actionLabel ?? "读取通道中"}（{selectedOrderIds.length}）
          </Button>
        </div>
      )}

      {isAdmin && batches.length > 0 ? (
        <div className="ld-notification-delivery__table-wrap">
          <table className="ld-notification-delivery__table">
            <thead>
              <tr>
                <th>创建时间</th>
                <th>批次状态</th>
                <th>进度</th>
                <th>成本</th>
                <th>详情</th>
              </tr>
            </thead>
            <tbody>
              {batches.map((batch) => (
                <tr key={batch.batch_id} data-testid="notification-delivery-batch-row">
                  <td>{formatNotificationTime(batch.created_at)}</td>
                  <td>{notificationBatchStatusLabel(batch.status)}</td>
                  <td>
                    <BatchCounts batch={batch} />
                  </td>
                  <td>
                    <MoneyText fen={batch.spent_cost_cents} size="sm" /> /{" "}
                    <MoneyText fen={batch.max_cost_cents} size="sm" />
                  </td>
                  <td>
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => void loadDetail(batch.batch_id)}
                      disabled={busy}
                    >
                      查看
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {detail === null ? null : (
        <div
          className="ld-notification-delivery__detail"
          data-testid="notification-delivery-detail"
        >
          <div className="ld-notification-delivery__detail-header">
            <div>
              <h3>批次详情</h3>
              <p>
                {notificationBatchStatusLabel(detail.batch.status)} · {detail.batch.recipient_count}{" "}
                单
              </p>
            </div>
            <Button
              type="button"
              variant="ghost"
              onClick={() => void loadDetail(detail.batch.batch_id)}
              disabled={busy}
            >
              刷新详情
            </Button>
          </div>
          <ul className="ld-notification-delivery__deliveries">
            {detail.deliveries.map((delivery) => (
              <li key={delivery.delivery_id} data-testid="notification-delivery-row">
                <strong>{delivery.ticket_no}</strong>
                <span>
                  {notificationDeliveryStatusLabel(delivery.status, detail.batch.assurance)}
                </span>
                <span>尝试 {delivery.attempt_count}/5</span>
                <span>{delivery.last_error_code ?? "无错误码"}</span>
              </li>
            ))}
          </ul>
          {fallbackIds.length > 0 ? (
            <Button
              type="button"
              variant="secondary"
              onClick={() => onManualFallback(fallbackIds)}
              disabled={busy}
            >
              带回人工名单（{fallbackIds.length}）
            </Button>
          ) : null}
        </div>
      )}

      <DangerConfirmDialog
        open={pending?.kind === "confirm"}
        title="确认创建通知批次"
        description={
          pending?.summary === undefined
            ? "服务端已冻结本批订单。"
            : `服务端已冻结 ${pending.summary.order_count} 个订单；近 24 小时风险累计 ${pending.summary.risk_window_order_count} 单。入队不代表发送或送达。`
        }
        summary={pending === null ? undefined : <PendingSummary summary={pending.summary} />}
        confirmLabel="确认入队"
        serverConfirmation
        busy={busy}
        onClose={() => setPending(null)}
        onConfirm={() =>
          pending === null ? undefined : void execute(pending.input, pending.confirmRef)
        }
      />
      {pending?.kind === "step_up" && authClient !== undefined ? (
        <StepUpConfirmDialog
          open
          onClose={() => setPending(null)}
          authClient={authClient}
          confirmRef={pending.confirmRef}
          currentStaffId={session.session.staff_id}
          commandLabel="创建大批量通知"
          summary={<PendingSummary summary={pending.summary} />}
          onApproved={() => void execute(pending.input, pending.confirmRef)}
        />
      ) : null}
    </section>
  );
}

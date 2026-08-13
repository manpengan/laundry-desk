import type { DeliveryTaskConfirmationSummary } from "@laundry/contracts";

import {
  DELIVERY_TASK_LEG_LABELS,
  DELIVERY_TASK_REASON_LABELS,
  DELIVERY_TASK_STATUS_LABELS,
} from "./delivery-task-model.js";

const OPERATION_LABELS = Object.freeze({
  assign: "分派任务",
  respond: "接单决定",
  transfer: "转派任务",
  takeover: "人工接管",
});

export function DeliveryTaskPendingSummary({
  summary,
}: Readonly<{ summary: DeliveryTaskConfirmationSummary }>) {
  return (
    <dl className="ld-delivery-tasks__pending-summary">
      <div>
        <dt>操作</dt>
        <dd>{OPERATION_LABELS[summary.operation]}</dd>
      </div>
      <div>
        <dt>配送订单</dt>
        <dd>{summary.delivery_order_id}</dd>
      </div>
      <div>
        <dt>订单版本 / 配送腿</dt>
        <dd>
          v{summary.delivery_order_version} · {DELIVERY_TASK_LEG_LABELS[summary.leg]}
        </dd>
      </div>
      {summary.delivery_task_id === null ? null : (
        <div>
          <dt>当前任务</dt>
          <dd>
            {summary.delivery_task_id} · v{summary.delivery_task_version} ·{" "}
            {summary.current_status === null
              ? "未知"
              : DELIVERY_TASK_STATUS_LABELS[summary.current_status]}
          </dd>
        </div>
      )}
      <div>
        <dt>归属变更</dt>
        <dd>
          {summary.from_assignee_staff_id ?? "未分派"} → {summary.to_assignee_staff_id}
        </dd>
      </div>
      {summary.decision === null ? null : (
        <div>
          <dt>决定</dt>
          <dd>{summary.decision === "accept" ? "接受任务" : "拒绝任务"}</dd>
        </div>
      )}
      {summary.resolution_reason === null ? null : (
        <div>
          <dt>受控原因</dt>
          <dd>{DELIVERY_TASK_REASON_LABELS[summary.resolution_reason]}</dd>
        </div>
      )}
    </dl>
  );
}

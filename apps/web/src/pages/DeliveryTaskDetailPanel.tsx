import { Button } from "@laundry/ui";

import type { DeliveryTaskResolutionReason } from "@laundry/contracts";

import type { StaffAccessView } from "./staff-access.js";
import {
  DELIVERY_TASK_LEG_LABELS,
  DELIVERY_TASK_REASON_LABELS,
  DELIVERY_TASK_STATUS_LABELS,
  shortDeliveryTaskId,
  type DeliveryTaskView,
} from "./delivery-task-model.js";

export type DeliveryTaskDetailPanelProps = Readonly<{
  task: DeliveryTaskView | null;
  staff: readonly StaffAccessView[];
  currentStaffId: string;
  admin: boolean;
  targetStaffId: string;
  reason: DeliveryTaskResolutionReason;
  busy: boolean;
  onTargetStaffChange(value: string): void;
  onReasonChange(value: DeliveryTaskResolutionReason): void;
  onRespond(decision: "accept" | "reject"): void;
  onTransfer(): void;
  onTakeover(): void;
}>;

export function DeliveryTaskDetailPanel({
  task,
  staff,
  currentStaffId,
  admin,
  targetStaffId,
  reason,
  busy,
  onTargetStaffChange,
  onReasonChange,
  onRespond,
  onTransfer,
  onTakeover,
}: DeliveryTaskDetailPanelProps) {
  if (task === null) {
    return (
      <section className="ld-delivery-tasks__detail" aria-label="配送任务详情">
        <p>选择一项任务查看当前归属和可执行操作。</p>
      </section>
    );
  }
  const targets = staff.filter((row) => row.is_active && row.staff_id !== task.assignee_staff_id);
  const canRespond = task.status === "offered" && task.assignee_staff_id === currentStaffId;
  const canReassign = admin && (task.status === "offered" || task.status === "accepted");

  return (
    <section className="ld-delivery-tasks__detail" aria-label="配送任务详情">
      <div className="ld-delivery-tasks__detail-head">
        <h2>{DELIVERY_TASK_STATUS_LABELS[task.status]}</h2>
        <span>版本 {task.version}</span>
      </div>
      <dl>
        <div>
          <dt>任务 / 配送单</dt>
          <dd title={`${task.delivery_task_id} / ${task.delivery_order_id}`}>
            {shortDeliveryTaskId(task.delivery_task_id)} /{" "}
            {shortDeliveryTaskId(task.delivery_order_id)}
          </dd>
        </div>
        <div>
          <dt>配送腿</dt>
          <dd>{DELIVERY_TASK_LEG_LABELS[task.leg]}</dd>
        </div>
        <div>
          <dt>当前执行人</dt>
          <dd title={task.assignee_staff_id}>{shortDeliveryTaskId(task.assignee_staff_id)}</dd>
        </div>
        <div>
          <dt>来源</dt>
          <dd>
            {task.source === "assignment"
              ? "初次/重新分派"
              : task.source === "transfer"
                ? "转派"
                : "人工接管"}
          </dd>
        </div>
      </dl>

      {canRespond ? (
        <div className="ld-delivery-tasks__action-block">
          <h3>我的接单决定</h3>
          <Button type="button" disabled={busy} onClick={() => onRespond("accept")}>
            接受任务
          </Button>
          <Button
            variant="danger"
            type="button"
            disabled={busy}
            onClick={() => onRespond("reject")}
          >
            按下方原因拒绝
          </Button>
        </div>
      ) : null}

      {canReassign ? (
        <div className="ld-delivery-tasks__action-block">
          <h3>管理员归属调整</h3>
          <label>
            新执行人
            <select
              value={targetStaffId}
              disabled={busy}
              onChange={(event) => onTargetStaffChange(event.target.value)}
            >
              <option value="">请选择</option>
              {targets.map((row) => (
                <option key={row.staff_id} value={row.staff_id}>
                  {row.display_name}（{row.role === "admin" ? "店长" : "员工"}）
                </option>
              ))}
            </select>
          </label>
          <label>
            受控原因
            <select
              value={reason}
              disabled={busy}
              onChange={(event) =>
                onReasonChange(event.target.value as DeliveryTaskResolutionReason)
              }
            >
              {Object.entries(DELIVERY_TASK_REASON_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <Button type="button" disabled={busy || targetStaffId.length === 0} onClick={onTransfer}>
            转派给所选员工
          </Button>
          {task.assignee_staff_id === currentStaffId ? null : (
            <Button variant="danger" type="button" disabled={busy} onClick={onTakeover}>
              由我人工接管（需另一店长复核）
            </Button>
          )}
        </div>
      ) : null}
    </section>
  );
}

import { Button } from "@laundry/ui";

import type { StaffAccessView } from "./staff-access.js";
import {
  DELIVERY_TASK_LEG_LABELS,
  shortDeliveryTaskId,
  type DeliveryTaskCandidate,
} from "./delivery-task-model.js";

export type DeliveryTaskAssignmentEditorProps = Readonly<{
  candidates: readonly DeliveryTaskCandidate[];
  staff: readonly StaffAccessView[];
  candidateKey: string;
  assigneeStaffId: string;
  busy: boolean;
  onCandidateChange(value: string): void;
  onAssigneeChange(value: string): void;
  onAssign(): void;
}>;

export function DeliveryTaskAssignmentEditor({
  candidates,
  staff,
  candidateKey,
  assigneeStaffId,
  busy,
  onCandidateChange,
  onAssigneeChange,
  onAssign,
}: DeliveryTaskAssignmentEditorProps) {
  const activeStaff = staff.filter(({ is_active }) => is_active);
  return (
    <section className="ld-delivery-tasks__assignment" aria-label="分派配送任务">
      <div>
        <h2>分派待执行配送腿</h2>
        <p>只列出当前处于待取件或待送回状态的权威配送订单。</p>
      </div>
      <label>
        配送订单与配送腿
        <select
          value={candidateKey}
          disabled={busy}
          onChange={(event) => onCandidateChange(event.target.value)}
        >
          <option value="">请选择</option>
          {candidates.map((candidate) => (
            <option key={candidate.key} value={candidate.key}>
              {shortDeliveryTaskId(candidate.delivery_order_id)} ·{" "}
              {DELIVERY_TASK_LEG_LABELS[candidate.leg]} · 订单 v{candidate.order_version}
            </option>
          ))}
        </select>
      </label>
      <label>
        执行员工
        <select
          value={assigneeStaffId}
          disabled={busy}
          onChange={(event) => onAssigneeChange(event.target.value)}
        >
          <option value="">请选择</option>
          {activeStaff.map((row) => (
            <option key={row.staff_id} value={row.staff_id}>
              {row.display_name}（{row.role === "admin" ? "店长" : "员工"}）
            </option>
          ))}
        </select>
      </label>
      <Button
        type="button"
        disabled={busy || candidateKey.length === 0 || assigneeStaffId.length === 0}
        onClick={onAssign}
      >
        发出任务
      </Button>
    </section>
  );
}

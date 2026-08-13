import {
  DELIVERY_TASK_LEG_LABELS,
  DELIVERY_TASK_STATUS_LABELS,
  shortDeliveryTaskId,
  type DeliveryTaskView,
} from "./delivery-task-model.js";

export type DeliveryTaskWorklistProps = Readonly<{
  tasks: readonly DeliveryTaskView[];
  selectedId: string | null;
  mineOnly: boolean;
  activeOnly: boolean;
  busy: boolean;
  loaded: boolean;
  onMineOnlyChange(value: boolean): void;
  onActiveOnlyChange(value: boolean): void;
  onSelect(taskId: string): void;
}>;

export function DeliveryTaskWorklist({
  tasks,
  selectedId,
  mineOnly,
  activeOnly,
  busy,
  loaded,
  onMineOnlyChange,
  onActiveOnlyChange,
  onSelect,
}: DeliveryTaskWorklistProps) {
  return (
    <section className="ld-delivery-tasks__worklist" aria-label="配送任务列表">
      <div className="ld-delivery-tasks__filters">
        <label>
          <input
            type="checkbox"
            checked={mineOnly}
            disabled={busy}
            onChange={(event) => onMineOnlyChange(event.target.checked)}
          />
          只看我的任务
        </label>
        <label>
          <input
            type="checkbox"
            checked={activeOnly}
            disabled={busy}
            onChange={(event) => onActiveOnlyChange(event.target.checked)}
          />
          只看进行中
        </label>
      </div>
      {!loaded ? <p role="status">正在读取配送任务…</p> : null}
      {loaded && tasks.length === 0 ? <p>当前筛选下没有配送任务。</p> : null}
      <ul className="ld-delivery-tasks__rows">
        {tasks.map((task) => (
          <li key={task.delivery_task_id}>
            <button
              type="button"
              className={task.delivery_task_id === selectedId ? "is-selected" : undefined}
              disabled={busy}
              onClick={() => onSelect(task.delivery_task_id)}
            >
              <strong>{DELIVERY_TASK_STATUS_LABELS[task.status]}</strong>
              <span>
                {DELIVERY_TASK_LEG_LABELS[task.leg]} · 任务{" "}
                {shortDeliveryTaskId(task.delivery_task_id)}
              </span>
              <span>配送单 {shortDeliveryTaskId(task.delivery_order_id)}</span>
              <span>
                执行人 {shortDeliveryTaskId(task.assignee_staff_id)} · v{task.version}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

import { Button } from "@laundry/ui";
import type { DeliveryTaskResolutionReason } from "@laundry/contracts";

import {
  DELIVERY_ORDER_CANCELLATION_LABELS,
  DELIVERY_ORDER_ROUTE_LABELS,
  DELIVERY_ORDER_STATUS_LABELS,
  formatDeliveryOrderTime,
  shortDeliveryOrderId,
} from "../pages/delivery-order-model.js";
import {
  DELIVERY_TASK_LEG_LABELS,
  DELIVERY_TASK_REASON_LABELS,
  DELIVERY_TASK_STATUS_LABELS,
  shortDeliveryTaskId,
  type DeliveryTaskView,
} from "../pages/delivery-task-model.js";
import {
  mobileTaskAvailabilityCopy,
  mobileTaskExecutionAction,
  type MobileTaskDetail,
} from "./mobile-task-model.js";
import type { MobileTaskPendingAction } from "./use-mobile-task-mutations.js";

export function MobileTaskList(
  props: Readonly<{
    tasks: readonly DeliveryTaskView[];
    selectedId: string | null;
    loaded: boolean;
    loading: boolean;
    busy: boolean;
    onSelect(taskId: string): void;
  }>,
) {
  const { tasks, selectedId, loaded, loading, busy, onSelect } = props;
  return (
    <section
      className={`ld-mobile-task-list${selectedId === null ? "" : " is-detail-open"}`}
      aria-label="我的配送任务列表"
      aria-busy={loading}
    >
      {loading && !loaded ? <p role="status">正在读取我的任务…</p> : null}
      {loaded && tasks.length === 0 ? (
        <div className="ld-mobile-task-empty">
          <strong>当前没有任务</strong>
          <span>可切换到“全部记录”查看已完成或已结束任务。</span>
        </div>
      ) : null}
      <ul>
        {tasks.map((task) => (
          <li key={task.delivery_task_id}>
            <button
              type="button"
              className="ld-mobile-task-card"
              data-status={task.status}
              aria-current={task.delivery_task_id === selectedId ? "true" : undefined}
              disabled={busy}
              onClick={() => onSelect(task.delivery_task_id)}
            >
              <span className="ld-mobile-task-card__status">
                {DELIVERY_TASK_STATUS_LABELS[task.status]}
              </span>
              <strong>{DELIVERY_TASK_LEG_LABELS[task.leg]}</strong>
              <span>任务 {shortDeliveryTaskId(task.delivery_task_id)}</span>
              <span>配送单 {shortDeliveryOrderId(task.delivery_order_id)}</span>
              <time dateTime={new Date(task.updated_at * 1_000).toISOString()}>
                更新于 {formatDeliveryOrderTime(task.updated_at)}
              </time>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function MobileTaskDetailCard(
  props: Readonly<{
    selectedTask: DeliveryTaskView | null;
    detail: MobileTaskDetail | null;
    loading: boolean;
    online: boolean;
    busy: boolean;
    reason: DeliveryTaskResolutionReason;
    onBack(): void;
    onReasonChange(value: DeliveryTaskResolutionReason): void;
    onRespond(decision: "accept" | "reject"): void;
    onTransition(): void;
  }>,
) {
  const {
    selectedTask,
    detail,
    loading,
    online,
    busy,
    reason,
    onBack,
    onReasonChange,
    onRespond,
    onTransition,
  } = props;
  const task = detail?.task ?? selectedTask;
  const order = detail?.order ?? null;
  const action = mobileTaskExecutionAction(detail);

  return (
    <section
      className={`ld-mobile-task-detail${selectedTask === null ? "" : " is-detail-open"}`}
      aria-label="配送任务详情"
      aria-busy={loading}
    >
      {selectedTask === null ? (
        <div className="ld-mobile-task-empty">
          <strong>选择任务查看详情</strong>
          <span>手机窄屏会在列表与详情之间切换。</span>
        </div>
      ) : (
        <>
          <Button variant="ghost" type="button" className="ld-mobile-task-back" onClick={onBack}>
            返回任务列表
          </Button>
          {loading ? <p role="status">正在核对任务与订单状态…</p> : null}
          {task === null ? null : (
            <>
              <div className="ld-mobile-task-detail__heading">
                <div>
                  <span className="ld-mobile-task-detail__eyebrow">我的配送任务</span>
                  <h2>{DELIVERY_TASK_LEG_LABELS[task.leg]}</h2>
                </div>
                <span className="ld-mobile-task-status" data-status={task.status}>
                  {DELIVERY_TASK_STATUS_LABELS[task.status]}
                </span>
              </div>
              <dl className="ld-mobile-task-facts">
                <div>
                  <dt>任务编号</dt>
                  <dd>{shortDeliveryTaskId(task.delivery_task_id)}</dd>
                </div>
                <div>
                  <dt>配送订单</dt>
                  <dd>{shortDeliveryOrderId(task.delivery_order_id)}</dd>
                </div>
                <div>
                  <dt>任务版本</dt>
                  <dd>v{task.version}</dd>
                </div>
                <div>
                  <dt>订单状态</dt>
                  <dd>{order === null ? "待读取" : DELIVERY_ORDER_STATUS_LABELS[order.status]}</dd>
                </div>
                <div>
                  <dt>最后更新</dt>
                  <dd>{formatDeliveryOrderTime(task.updated_at)}</dd>
                </div>
              </dl>
              <p className="ld-mobile-task-availability" role="status">
                {mobileTaskAvailabilityCopy(task, order)}
              </p>
              {!online ? (
                <p className="ld-mobile-task-offline-note" role="status">
                  当前离线：仅显示上次读取结果，所有操作已停用。
                </p>
              ) : null}
              {task.status === "offered" ? (
                <div className="ld-mobile-task-actions">
                  <Button
                    type="button"
                    size="lg"
                    disabled={!online || busy || detail === null}
                    onClick={() => onRespond("accept")}
                  >
                    接受任务
                  </Button>
                  <label>
                    拒绝原因
                    <select
                      value={reason}
                      disabled={!online || busy || detail === null}
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
                  <Button
                    variant="danger"
                    type="button"
                    size="lg"
                    disabled={!online || busy || detail === null}
                    onClick={() => onRespond("reject")}
                  >
                    拒绝任务
                  </Button>
                </div>
              ) : null}
              {action === null ? null : (
                <div className="ld-mobile-task-actions">
                  <p>{action.hint}</p>
                  <Button type="button" size="lg" disabled={!online || busy} onClick={onTransition}>
                    {action.label}
                  </Button>
                </div>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}

export function MobileTaskTransitionSummary({
  pending,
}: Readonly<{ pending: Extract<MobileTaskPendingAction, { kind: "transition" }> }>) {
  return (
    <dl className="ld-mobile-task-confirmation">
      <div>
        <dt>配送任务</dt>
        <dd>{pending.authority.deliveryTaskId}</dd>
      </div>
      <div>
        <dt>任务腿 / 任务版本</dt>
        <dd>
          {DELIVERY_TASK_LEG_LABELS[pending.authority.leg]} ·{" "}
          {DELIVERY_TASK_STATUS_LABELS[pending.authority.taskStatus]} · v
          {pending.authority.deliveryTaskVersion}
        </dd>
      </div>
      <div>
        <dt>配送订单</dt>
        <dd>{pending.authority.deliveryOrderId}</dd>
      </div>
      <div>
        <dt>洗衣订单</dt>
        <dd>{pending.authority.laundryOrderId}</dd>
      </div>
      <div>
        <dt>路线</dt>
        <dd>
          {DELIVERY_ORDER_ROUTE_LABELS.collection[pending.authority.collectionMethod]} →{" "}
          {DELIVERY_ORDER_ROUTE_LABELS.return[pending.authority.returnMethod]}
        </dd>
      </div>
      <div>
        <dt>状态转换 / 订单版本</dt>
        <dd>
          {DELIVERY_ORDER_STATUS_LABELS[pending.authority.currentStatus]} →{" "}
          {DELIVERY_ORDER_STATUS_LABELS[pending.authority.targetStatus]} · v
          {pending.authority.deliveryOrderVersion}
        </dd>
      </div>
      {pending.authority.cancellationReason === null ? null : (
        <div>
          <dt>取消原因</dt>
          <dd>{DELIVERY_ORDER_CANCELLATION_LABELS[pending.authority.cancellationReason]}</dd>
        </div>
      )}
    </dl>
  );
}

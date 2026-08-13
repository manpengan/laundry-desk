import { Button, useToast } from "@laundry/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DeliveryTaskResolutionReason } from "@laundry/contracts";
import type { AuthClient } from "../auth/AuthClient.js";
import type { SessionView } from "../auth/types.js";
import { isStepUpRequired } from "../commands/command-client.js";
import type { CommandPort, QueryPort } from "../commands/types.js";
import { StepUpConfirmDialog } from "../shell/StepUpConfirmDialog.js";
import {
  createStepUpAttemptAuthority,
  type StepUpAttemptToken,
} from "../shell/step-up-attempt-authority.js";
import { DangerConfirmDialog } from "./DangerConfirmDialog.js";
import { DeliveryTaskAssignmentEditor } from "./DeliveryTaskAssignmentEditor.js";
import { DeliveryTaskDetailPanel } from "./DeliveryTaskDetailPanel.js";
import { DeliveryTaskPendingSummary } from "./DeliveryTaskPendingSummary.js";
import { DeliveryTaskWorklist } from "./DeliveryTaskWorklist.js";
import {
  deliveryOrderSessionScope,
  createDeliveryOrderStepUpCloseGate,
} from "./delivery-order-request-authority.js";
import { parseDeliveryOrders } from "./delivery-order-model.js";
import {
  buildDeliveryTaskAssign,
  buildDeliveryTaskListInput,
  buildDeliveryTaskResponse,
  buildDeliveryTaskTakeover,
  buildDeliveryTaskTransfer,
  deliveryTaskCandidates,
  deliveryTaskPendingStillMatches,
  parseDeliveryTaskMutation,
  parseDeliveryTasks,
  type DeliveryTaskCommand,
  type DeliveryTaskCommandBody,
  type DeliveryTaskPendingAction,
  type DeliveryTaskView,
} from "./delivery-task-model.js";
import { parseStaffAccessRows, type StaffAccessView } from "./staff-access.js";

export type DeliveryTasksPanelProps = Readonly<{
  queryClient: QueryPort;
  commandClient: CommandPort;
  authClient: AuthClient;
  session: SessionView;
}>;
const COMMAND_LABELS: Readonly<Record<DeliveryTaskCommand, string>> = Object.freeze({
  "delivery.task.assign": "分派配送任务",
  "delivery.task.respond": "提交接单决定",
  "delivery.task.transfer": "转派配送任务",
  "delivery.task.takeover": "人工接管配送任务",
});
export function DeliveryTasksPanel({
  queryClient,
  commandClient,
  authClient,
  session,
}: DeliveryTasksPanelProps) {
  const toast = useToast();
  const scope = deliveryOrderSessionScope(session);
  const requestRef = useRef(0);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const closeGateRef = useRef(createDeliveryOrderStepUpCloseGate());
  const stepUpAuthorityRef = useRef(createStepUpAttemptAuthority());
  const [tasks, setTasks] = useState<readonly DeliveryTaskView[]>([]);
  const [orders, setOrders] = useState<ReturnType<typeof parseDeliveryOrders>>([]);
  const [staff, setStaff] = useState<readonly StaffAccessView[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mineOnly, setMineOnly] = useState(session.role !== "admin");
  const [activeOnly, setActiveOnly] = useState(true);
  const [candidateKey, setCandidateKey] = useState("");
  const [assigneeStaffId, setAssigneeStaffId] = useState("");
  const [targetStaffId, setTargetStaffId] = useState("");
  const [reason, setReason] = useState<DeliveryTaskResolutionReason>("other");
  const [pending, setPending] = useState<DeliveryTaskPendingAction | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const candidates = useMemo(() => deliveryTaskCandidates(orders ?? []), [orders]);
  const selected = tasks.find(({ delivery_task_id }) => delivery_task_id === selectedId) ?? null;
  const invalidateStepUp = () => {
    stepUpAuthorityRef.current.invalidate();
    closeGateRef.current.reset();
  };
  const load = useCallback(async () => {
    const request = ++requestRef.current;
    const requestScope = scope;
    const taskInput = buildDeliveryTaskListInput(
      mineOnly ? session.session.staff_id : null,
      activeOnly,
    );
    if (taskInput === null) return;
    setBusy(true);
    try {
      const [taskResult, orderResult, staffResult] = await Promise.all([
        queryClient.execute<unknown>("delivery.tasks.list", taskInput),
        queryClient.execute<unknown>("delivery.orders.list", { limit: 100 }),
        queryClient.execute<unknown>("staff.access.list", {}),
      ]);
      if (request !== requestRef.current || requestScope !== scopeRef.current) return;
      const failed = [taskResult, orderResult, staffResult].find((result) => !result.ok);
      if (failed !== undefined && !failed.ok) {
        toast.push(failed.error.message ?? failed.error.code, "error");
        setLoaded(false);
        return;
      }
      if (!taskResult.ok || !orderResult.ok || !staffResult.ok) return;
      const nextTasks = parseDeliveryTasks(taskResult.data);
      const nextOrders = parseDeliveryOrders(orderResult.data);
      const nextStaff = parseStaffAccessRows(staffResult.data);
      if (nextTasks === null || nextOrders === null || nextStaff === null) {
        toast.push("配送任务工作台响应无法解析", "error");
        setLoaded(false);
        return;
      }
      setTasks(nextTasks);
      setOrders(nextOrders);
      setStaff(nextStaff);
      setSelectedId((current) =>
        nextTasks.some(({ delivery_task_id }) => delivery_task_id === current)
          ? current
          : (nextTasks[0]?.delivery_task_id ?? null),
      );
      setCandidateKey((current) =>
        deliveryTaskCandidates(nextOrders).some(({ key }) => key === current) ? current : "",
      );
      setAssigneeStaffId((current) =>
        nextStaff.some(({ staff_id, is_active }) => staff_id === current && is_active)
          ? current
          : "",
      );
      setLoaded(true);
    } catch {
      if (request !== requestRef.current || requestScope !== scopeRef.current) return;
      setLoaded(false);
      toast.push("配送任务读取失败，请检查服务连接", "error");
    } finally {
      if (request === requestRef.current && requestScope === scopeRef.current) setBusy(false);
    }
  }, [activeOnly, mineOnly, queryClient, scope, session.session.staff_id, toast]);
  useEffect(() => {
    requestRef.current += 1;
    invalidateStepUp();
    setTasks([]);
    setOrders([]);
    setStaff([]);
    setSelectedId(null);
    setPending(null);
    setLoaded(false);
    void load();
    return () => {
      requestRef.current += 1;
    };
  }, [load, scope]);

  const execute = useCallback(
    async (command: DeliveryTaskCommand, body: DeliveryTaskCommandBody) => {
      const request = ++requestRef.current;
      invalidateStepUp();
      setPending(null);
      setBusy(true);
      try {
        const result = await commandClient.execute<unknown>(command, body);
        if (request !== requestRef.current) return;
        if (result.ok) {
          if (parseDeliveryTaskMutation(result.data) === null) {
            toast.push("配送任务操作响应无法解析", "error");
            return;
          }
          toast.push(`${COMMAND_LABELS[command]}完成`, "success");
          await load();
          return;
        }
        if (isStepUpRequired(result)) {
          const summary = result.error.detail.summary;
          if (summary?.kind !== "delivery_task_operation") {
            toast.push("服务端未返回完整的配送任务确认摘要", "error");
            return;
          }
          const kind = result.error.code === "POLICY_STEP_UP_REQUIRED" ? "step_up" : "confirm";
          const confirmRef = result.error.detail.confirm_ref;
          if (kind === "step_up") {
            stepUpAuthorityRef.current.begin(JSON.stringify([scopeRef.current, confirmRef]));
          }
          setPending(Object.freeze({ command, body, confirmRef, kind, summary }));
          return;
        }
        toast.push(
          result.error.code === "INVARIANT_FAILED"
            ? "订单、任务版本或人员归属已变化，请按最新资料重试"
            : (result.error.message ?? result.error.code),
          "error",
        );
        await load();
      } catch {
        if (request === requestRef.current) toast.push(`${COMMAND_LABELS[command]}失败`, "error");
      } finally {
        if (request === requestRef.current) setBusy(false);
      }
    },
    [commandClient, load, toast],
  );

  const resume = useCallback(
    async (expectedStepUp?: StepUpAttemptToken) => {
      if (pending === null) return;
      if (
        expectedStepUp !== undefined &&
        !stepUpAuthorityRef.current.isCurrent(
          expectedStepUp,
          JSON.stringify([scopeRef.current, pending.confirmRef]),
        )
      ) {
        return;
      }
      if (!deliveryTaskPendingStillMatches(pending, tasks, candidates)) {
        invalidateStepUp();
        setPending(null);
        toast.push("任务或订单版本已变化，请重新读取后发起", "error");
        return;
      }
      stepUpAuthorityRef.current.invalidate();
      const request = ++requestRef.current;
      setBusy(true);
      try {
        const result = await commandClient.execute<unknown>(
          pending.command,
          {},
          {
            confirmRef: pending.confirmRef,
          },
        );
        if (request !== requestRef.current) return;
        setPending(null);
        if (!result.ok || parseDeliveryTaskMutation(result.data) === null) {
          toast.push(
            result.ok ? "配送任务确认响应无法解析" : (result.error.message ?? result.error.code),
            "error",
          );
          await load();
          return;
        }
        toast.push(`${COMMAND_LABELS[pending.command]}完成`, "success");
        await load();
      } catch {
        if (request === requestRef.current) toast.push("配送任务确认失败，请重新读取", "error");
      } finally {
        if (request === requestRef.current) setBusy(false);
      }
    },
    [candidates, commandClient, load, pending, tasks, toast],
  );

  const assign = () => {
    const candidate = candidates.find(({ key }) => key === candidateKey);
    if (candidate === undefined) return toast.push("请选择待分派配送腿", "error");
    const body = buildDeliveryTaskAssign(candidate, assigneeStaffId);
    if (body === null) return toast.push("请选择有效执行员工", "error");
    void execute("delivery.task.assign", body);
  };
  const respond = (decision: "accept" | "reject") => {
    if (selected === null) return;
    const body = buildDeliveryTaskResponse(selected, decision, reason);
    if (body !== null) void execute("delivery.task.respond", body);
  };
  const transfer = () => {
    if (selected === null) return;
    const body = buildDeliveryTaskTransfer(selected, targetStaffId, reason);
    if (body === null) return toast.push("请选择另一名有效员工", "error");
    void execute("delivery.task.transfer", body);
  };
  const takeover = () => {
    if (selected === null) return;
    const body = buildDeliveryTaskTakeover(selected, reason);
    if (body !== null) void execute("delivery.task.takeover", body);
  };
  const closePending = () => {
    invalidateStepUp();
    requestRef.current += 1;
    setPending(null);
    setBusy(false);
  };

  return (
    <main
      className="ld-delivery-tasks lg-card"
      id="main-content"
      tabIndex={-1}
      aria-label="配送任务工作台"
    >
      <header className="ld-delivery-tasks__header">
        <div>
          <h1 className="ld-shell-main__title">配送任务</h1>
          <p className="ld-shell-main__hint">分派、接拒、转派与人工接管均保留不可变归属历史。</p>
        </div>
        <Button variant="ghost" type="button" disabled={busy} onClick={() => void load()}>
          重新读取
        </Button>
      </header>
      {session.features.delivery_enabled === true ? null : (
        <p className="ld-delivery-orders__notice" role="status">
          取送功能已关闭新订单入口；既有配送腿仍可分派、接单、转派或接管直至安全收口。
        </p>
      )}
      {session.role === "admin" ? (
        <DeliveryTaskAssignmentEditor
          candidates={candidates}
          staff={staff}
          candidateKey={candidateKey}
          assigneeStaffId={assigneeStaffId}
          busy={busy}
          onCandidateChange={(value) => {
            invalidateStepUp();
            setPending(null);
            setCandidateKey(value);
          }}
          onAssigneeChange={(value) => {
            invalidateStepUp();
            setPending(null);
            setAssigneeStaffId(value);
          }}
          onAssign={assign}
        />
      ) : null}
      <div className="ld-delivery-tasks__layout">
        <DeliveryTaskWorklist
          tasks={tasks}
          selectedId={selectedId}
          mineOnly={mineOnly}
          activeOnly={activeOnly}
          busy={busy}
          loaded={loaded}
          onMineOnlyChange={(value) => {
            invalidateStepUp();
            setPending(null);
            setMineOnly(value);
          }}
          onActiveOnlyChange={(value) => {
            invalidateStepUp();
            setPending(null);
            setActiveOnly(value);
          }}
          onSelect={(value) => {
            invalidateStepUp();
            setPending(null);
            setSelectedId(value);
            setTargetStaffId("");
          }}
        />
        <DeliveryTaskDetailPanel
          task={selected}
          staff={staff}
          currentStaffId={session.session.staff_id}
          admin={session.role === "admin"}
          targetStaffId={targetStaffId}
          reason={reason}
          busy={busy}
          onTargetStaffChange={setTargetStaffId}
          onReasonChange={setReason}
          onRespond={respond}
          onTransfer={transfer}
          onTakeover={takeover}
        />
      </div>
      <DangerConfirmDialog
        open={pending?.kind === "confirm"}
        title="确认配送任务操作"
        description="以下内容由服务端从当前订单、任务版本和人员归属生成。"
        summary={
          pending === null ? undefined : <DeliveryTaskPendingSummary summary={pending.summary} />
        }
        confirmLabel="确认执行"
        serverConfirmation
        busy={busy}
        onClose={closePending}
        onConfirm={() => void resume()}
      />
      {pending?.kind === "step_up" ? (
        <StepUpConfirmDialog
          open
          authClient={authClient}
          confirmRef={pending.confirmRef}
          currentStaffId={session.session.staff_id}
          commandLabel={COMMAND_LABELS[pending.command]}
          summary={<DeliveryTaskPendingSummary summary={pending.summary} />}
          onClose={() => {
            if (closeGateRef.current.consumeClose()) closePending();
          }}
          onApproved={() => {
            const token = stepUpAuthorityRef.current.current();
            if (token === null) return;
            closeGateRef.current.markApproved();
            void resume(token);
          }}
        />
      ) : null}
    </main>
  );
}

import type { DeliveryTaskResolutionReason } from "@laundry/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { SessionView } from "../auth/types.js";
import type { CommandFailure, CommandPort, QueryPort } from "../commands/types.js";
import type { DeliveryEvidenceMediaPort } from "../host/delivery-evidence-port.js";
import { buildDeliveryTaskListInput, type DeliveryTaskView } from "../pages/delivery-task-model.js";
import {
  parseMobileTaskDetail,
  parseMyDeliveryTasks,
  type MobileTaskDetail,
} from "./mobile-task-model.js";
import {
  createMobileTaskRequestAuthority,
  mobileTaskSessionScope,
  type MobileTaskRequestAuthority,
} from "./mobile-task-request-authority.js";
import { useMobileTaskMutations } from "./use-mobile-task-mutations.js";
import { useMobileDeliveryEvidence } from "./use-mobile-delivery-evidence.js";

export type MobileTaskWorkbenchError = Readonly<{ title: string; message: string }>;

function browserOnline(): boolean {
  return typeof navigator === "undefined" || navigator.onLine !== false;
}

function friendlyFailure(error: CommandFailure, fallback: string): MobileTaskWorkbenchError {
  if (error.code === "PERMISSION_DENIED") {
    return Object.freeze({ title: "无任务权限", message: "当前员工账号不能访问配送任务。" });
  }
  if (error.code === "NETWORK") {
    return Object.freeze({ title: "连接失败", message: "无法连接服务，请检查网络后重试。" });
  }
  if (error.code === "INVARIANT_FAILED" || error.code === "IDEMPOTENCY_CONFLICT") {
    return Object.freeze({ title: "状态已变化", message: "任务或订单已更新，请刷新后重试。" });
  }
  return Object.freeze({ title: fallback, message: error.message ?? fallback });
}

export function useMobileTaskWorkbench(
  options: Readonly<{
    session: SessionView;
    queryClient: QueryPort;
    commandClient: CommandPort;
    mediaPort?: DeliveryEvidenceMediaPort;
    onSessionExpired(): void;
    onSuccess(message: string): void;
  }>,
) {
  const { session, queryClient, commandClient, mediaPort, onSessionExpired, onSuccess } = options;
  const scope = mobileTaskSessionScope(session);
  const authorityRef = useRef<MobileTaskRequestAuthority>(createMobileTaskRequestAuthority(scope));
  if (authorityRef.current.scope !== scope) {
    authorityRef.current.invalidateAll();
    authorityRef.current = createMobileTaskRequestAuthority(scope);
  }

  const [online, setOnline] = useState(browserOnline);
  const [activeOnly, setActiveOnlyState] = useState(true);
  const [tasks, setTasks] = useState<readonly DeliveryTaskView[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<MobileTaskDetail | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [reason, setReasonState] = useState<DeliveryTaskResolutionReason>("unavailable");
  const [error, setError] = useState<MobileTaskWorkbenchError | null>(null);
  const selectedTask = useMemo(
    () => tasks.find((task) => task.delivery_task_id === selectedId) ?? null,
    [selectedId, tasks],
  );

  const handleFailure = useCallback(
    (failure: CommandFailure, fallback: string) => {
      if (failure.code === "AUTHENTICATION_FAILED") {
        authorityRef.current.invalidateAll();
        setTasks([]);
        setSelectedId(null);
        setDetail(null);
        setLoaded(false);
        onSessionExpired();
        return;
      }
      if (failure.code !== "REQUEST_ABORTED") setError(friendlyFailure(failure, fallback));
    },
    [onSessionExpired],
  );

  const loadList = useCallback(async () => {
    if (!online) return;
    const input = buildDeliveryTaskListInput(session.session.staff_id, activeOnly);
    if (input === null) return;
    const token = authorityRef.current.begin(
      "list",
      JSON.stringify([scope, activeOnly, session.session.staff_id]),
    );
    setListLoading(true);
    try {
      const result = await queryClient.execute<unknown>("delivery.tasks.list", input, {
        signal: token.signal,
      });
      if (!authorityRef.current.isCurrent(token)) return;
      if (!result.ok) {
        setLoaded(false);
        handleFailure(result.error, "读取任务失败");
        return;
      }
      const parsed = parseMyDeliveryTasks(result.data, session.session.staff_id);
      if (parsed === null) {
        setTasks([]);
        setLoaded(false);
        setError(Object.freeze({ title: "响应不可信", message: "任务列表响应无法安全解析。" }));
        return;
      }
      setTasks(parsed);
      setSelectedId((current) =>
        parsed.some((task) => task.delivery_task_id === current) ? current : null,
      );
      setLoaded(true);
      setError(null);
    } catch {
      if (!authorityRef.current.isCurrent(token)) return;
      setLoaded(false);
      setError(Object.freeze({ title: "连接失败", message: "读取任务失败，请检查网络后重试。" }));
    } finally {
      if (authorityRef.current.isCurrent(token)) setListLoading(false);
    }
  }, [activeOnly, handleFailure, online, queryClient, scope, session.session.staff_id]);

  const loadDetail = useCallback(
    async (task: DeliveryTaskView) => {
      if (!online) return;
      const token = authorityRef.current.begin(
        "detail",
        JSON.stringify([scope, task.delivery_task_id, task.version]),
      );
      setDetailLoading(true);
      try {
        const [taskResult, orderResult] = await Promise.all([
          queryClient.execute<unknown>(
            "delivery.task.get",
            { delivery_task_id: task.delivery_task_id },
            { signal: token.signal },
          ),
          queryClient.execute<unknown>(
            "delivery.order.get",
            { delivery_order_id: task.delivery_order_id },
            { signal: token.signal },
          ),
        ]);
        if (!authorityRef.current.isCurrent(token)) return;
        const failure = !taskResult.ok
          ? taskResult.error
          : !orderResult.ok
            ? orderResult.error
            : null;
        if (failure !== null) {
          setDetail(null);
          handleFailure(failure, "读取任务详情失败");
          return;
        }
        if (!taskResult.ok || !orderResult.ok) return;
        const parsed = parseMobileTaskDetail(taskResult.data, orderResult.data, {
          taskId: task.delivery_task_id,
          orderId: task.delivery_order_id,
          currentStaffId: session.session.staff_id,
        });
        if (parsed === null) {
          setDetail(null);
          setError(
            Object.freeze({ title: "详情已变化", message: "任务归属或订单已变化，请刷新。" }),
          );
          return;
        }
        setDetail(parsed);
        setError(null);
      } catch {
        if (!authorityRef.current.isCurrent(token)) return;
        setDetail(null);
        setError(Object.freeze({ title: "连接失败", message: "读取详情失败，请检查网络。" }));
      } finally {
        if (authorityRef.current.isCurrent(token)) setDetailLoading(false);
      }
    },
    [handleFailure, online, queryClient, scope, session.session.staff_id],
  );

  const reloadAfterMutation = useCallback(async () => {
    authorityRef.current.invalidate("detail");
    setDetail(null);
    setDetailLoading(false);
    await loadList();
  }, [loadList]);

  const mutations = useMobileTaskMutations({
    authority: authorityRef.current,
    commandClient,
    currentStaffId: session.session.staff_id,
    detail,
    online,
    reason,
    scope,
    onFailure: handleFailure,
    onError: setError,
    onSuccess,
    reload: reloadAfterMutation,
  });
  const evidence = useMobileDeliveryEvidence({
    authority: authorityRef.current,
    commandClient,
    queryClient,
    ...(mediaPort === undefined ? {} : { mediaPort }),
    currentStaffId: session.session.staff_id,
    detail,
    online,
    scope,
    onFailure: handleFailure,
    onError: setError,
    onSuccess,
    reload: reloadAfterMutation,
  });

  const clearSensitiveState = useCallback(() => {
    authorityRef.current.invalidateAll();
    mutations.reset();
    evidence.reset();
    setTasks([]);
    setSelectedId(null);
    setDetail(null);
    setError(null);
    setLoaded(false);
    setListLoading(false);
    setDetailLoading(false);
  }, [evidence.reset, mutations.reset]);

  useEffect(() => {
    const handleOnline = () => setOnline(true);
    const handleOffline = () => {
      authorityRef.current.invalidateAll();
      mutations.reset();
      evidence.reset();
      setOnline(false);
    };
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, [evidence.reset, mutations.reset]);

  useEffect(() => {
    clearSensitiveState();
  }, [clearSensitiveState, scope]);

  useEffect(() => {
    if (!online) {
      authorityRef.current.invalidateAll();
      mutations.reset();
      setListLoading(false);
      setDetailLoading(false);
      return;
    }
    void loadList();
  }, [loadList, mutations.reset, online]);

  useEffect(() => {
    if (selectedTask === null) {
      authorityRef.current.invalidate("detail");
      setDetail(null);
      setDetailLoading(false);
      return;
    }
    void loadDetail(selectedTask);
  }, [loadDetail, selectedTask]);

  useEffect(() => () => authorityRef.current.invalidateAll(), []);

  const refresh = useCallback(() => {
    authorityRef.current.invalidate("detail");
    mutations.reset();
    evidence.reset();
    setDetail(null);
    setDetailLoading(false);
    void loadList();
  }, [evidence.reset, loadList, mutations.reset]);

  const selectTask = useCallback(
    (taskId: string | null) => {
      authorityRef.current.invalidate("detail");
      mutations.reset();
      evidence.reset();
      setDetail(null);
      setSelectedId(taskId);
    },
    [evidence.reset, mutations.reset],
  );

  const setActiveOnly = useCallback(
    (value: boolean) => {
      authorityRef.current.invalidate("list");
      selectTask(null);
      setTasks([]);
      setLoaded(false);
      setListLoading(false);
      setError(null);
      setActiveOnlyState(value);
    },
    [selectTask],
  );

  const setReason = useCallback(
    (value: DeliveryTaskResolutionReason) => {
      mutations.reset();
      setReasonState(value);
    },
    [mutations.reset],
  );

  return Object.freeze({
    online,
    activeOnly,
    tasks,
    selectedId,
    selectedTask,
    detail,
    listLoading,
    detailLoading,
    mutationBusy: mutations.busy || evidence.busy,
    loaded,
    reason,
    pending: evidence.pending ?? mutations.pending,
    evidence,
    error,
    refresh,
    selectTask,
    setActiveOnly,
    setReason,
    respond: mutations.respond,
    transition: mutations.transition,
    confirmPending: evidence.pending === null ? mutations.confirm : evidence.confirm,
    closePending: evidence.pending === null ? mutations.reset : evidence.reset,
    clearSensitiveState,
  });
}

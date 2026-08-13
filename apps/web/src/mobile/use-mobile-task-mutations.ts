import type {
  DeliveryOrderTransitionInput,
  DeliveryTaskConfirmationSummary,
  DeliveryTaskRespondInput,
} from "@laundry/contracts";
import { useCallback, useState } from "react";

import { isStepUpRequired } from "../commands/command-client.js";
import type { CommandFailure, CommandPort } from "../commands/types.js";
import { parseDeliveryOrderMutation } from "../pages/delivery-order-model.js";
import {
  buildDeliveryTaskResponse,
  deliveryTaskPendingStillMatches,
  parseDeliveryTaskMutation,
  type DeliveryTaskPendingAction,
} from "../pages/delivery-task-model.js";
import {
  buildMobileTaskOrderTransition,
  buildMobileTaskTransitionAuthority,
  mobileTaskDetailStillMatches,
  mobileTaskExecutionAction,
  mobileTaskResponseResultMatches,
  mobileTaskResponseSummaryMatches,
  mobileTaskTransitionAuthorityKey,
  mobileTaskTransitionResultMatches,
  mobileTaskTransitionStillMatches,
  type MobileTaskDetail,
  type MobileTaskExecutionAction,
  type MobileTaskTransitionAuthority,
} from "./mobile-task-model.js";
import type { MobileTaskRequestAuthority } from "./mobile-task-request-authority.js";

type DetailSnapshot = Readonly<{
  scope: string;
  taskId: string;
  taskVersion: number;
  taskStatus: MobileTaskDetail["task"]["status"];
  orderId: string;
  orderVersion: number;
}>;

export type MobileTaskPendingAction =
  | Readonly<{
      kind: "respond";
      confirmRef: string;
      body: DeliveryTaskRespondInput;
      summary: DeliveryTaskConfirmationSummary;
      snapshot: DetailSnapshot;
    }>
  | Readonly<{
      kind: "transition";
      confirmRef: string;
      body: DeliveryOrderTransitionInput;
      action: MobileTaskExecutionAction;
      authority: MobileTaskTransitionAuthority;
      authorityKey: string;
      snapshot: DetailSnapshot;
    }>;

export type MobileTaskMutationError = Readonly<{ title: string; message: string }>;

function snapshot(detail: MobileTaskDetail, scope: string): DetailSnapshot {
  return Object.freeze({
    scope,
    taskId: detail.task.delivery_task_id,
    taskVersion: detail.task.version,
    taskStatus: detail.task.status,
    orderId: detail.order.delivery_order_id,
    orderVersion: detail.order.version,
  });
}

export function useMobileTaskMutations(
  options: Readonly<{
    authority: MobileTaskRequestAuthority;
    commandClient: CommandPort;
    currentStaffId: string;
    detail: MobileTaskDetail | null;
    online: boolean;
    reason: Parameters<typeof buildDeliveryTaskResponse>[2];
    scope: string;
    onFailure(error: CommandFailure, fallback: string): void;
    onError(error: MobileTaskMutationError): void;
    onSuccess(message: string): void;
    reload(): Promise<void>;
  }>,
) {
  const {
    authority,
    commandClient,
    currentStaffId,
    detail,
    online,
    reason,
    scope,
    onFailure,
    onError,
    onSuccess,
    reload,
  } = options;
  const [pending, setPending] = useState<MobileTaskPendingAction | null>(null);
  const [busy, setBusy] = useState(false);

  const complete = useCallback(
    async (message: string) => {
      setPending(null);
      onSuccess(message);
      await reload();
    },
    [onSuccess, reload],
  );

  const respond = useCallback(
    async (decision: "accept" | "reject") => {
      if (!online || detail === null || detail.task.status !== "offered") return;
      const body = buildDeliveryTaskResponse(detail.task, decision, reason);
      if (body === null) return;
      const token = authority.begin("mutation", JSON.stringify([scope, "respond", body]));
      setPending(null);
      setBusy(true);
      try {
        const result = await commandClient.execute<unknown>("delivery.task.respond", body, {
          signal: token.signal,
        });
        if (!authority.isCurrent(token)) return;
        if (result.ok) {
          const updated = parseDeliveryTaskMutation(result.data);
          if (
            updated === null ||
            !mobileTaskResponseResultMatches(updated, detail, currentStaffId, body)
          ) {
            onError({ title: "响应不可信", message: "接单响应无法安全解析。" });
            await reload();
            return;
          }
          await complete(decision === "accept" ? "任务已接受" : "任务已拒绝");
          return;
        }
        if (
          isStepUpRequired(result) &&
          result.error.code === "POLICY_CONFIRMATION_REQUIRED" &&
          result.error.detail.summary?.kind === "delivery_task_operation"
        ) {
          const candidate: DeliveryTaskPendingAction = Object.freeze({
            command: "delivery.task.respond",
            body,
            confirmRef: result.error.detail.confirm_ref,
            kind: "confirm",
            summary: result.error.detail.summary,
          });
          if (
            deliveryTaskPendingStillMatches(candidate, [detail.task], []) &&
            mobileTaskResponseSummaryMatches(detail, currentStaffId, body, candidate.summary)
          ) {
            setPending(
              Object.freeze({
                kind: "respond",
                confirmRef: candidate.confirmRef,
                body,
                summary: candidate.summary,
                snapshot: snapshot(detail, scope),
              }),
            );
            return;
          }
        }
        onFailure(result.error, "提交接单决定失败");
        await reload();
      } catch {
        if (authority.isCurrent(token)) {
          onError({ title: "连接失败", message: "接单操作失败，请刷新确认。" });
          await reload();
        }
      } finally {
        if (authority.isCurrent(token)) setBusy(false);
      }
    },
    [
      authority,
      commandClient,
      complete,
      currentStaffId,
      detail,
      onError,
      onFailure,
      online,
      reason,
      reload,
      scope,
    ],
  );

  const transition = useCallback(async () => {
    const action = mobileTaskExecutionAction(detail);
    if (!online || detail === null || action === null) return;
    const body = buildMobileTaskOrderTransition(detail, action);
    if (body === null) return;
    const transitionAuthority = buildMobileTaskTransitionAuthority(detail, action, body);
    if (transitionAuthority === null) return;
    const authorityKey = mobileTaskTransitionAuthorityKey(scope, body, transitionAuthority);
    const token = authority.begin("mutation", authorityKey);
    setPending(null);
    setBusy(true);
    try {
      const result = await commandClient.execute<unknown>("delivery.order.transition", body, {
        signal: token.signal,
      });
      if (!authority.isCurrent(token)) return;
      if (result.ok) {
        const updated = parseDeliveryOrderMutation(result.data);
        if (updated === null || !mobileTaskTransitionResultMatches(updated, detail, body)) {
          onError({ title: "响应不可信", message: "配送状态响应无法安全解析。" });
          await reload();
          return;
        }
        await complete(`${action.label}完成`);
        return;
      }
      if (isStepUpRequired(result) && result.error.code === "POLICY_CONFIRMATION_REQUIRED") {
        setPending(
          Object.freeze({
            kind: "transition",
            confirmRef: result.error.detail.confirm_ref,
            body,
            action,
            authority: transitionAuthority,
            authorityKey,
            snapshot: snapshot(detail, scope),
          }),
        );
        return;
      }
      onFailure(result.error, `${action.label}失败`);
      await reload();
    } catch {
      if (authority.isCurrent(token)) {
        onError({ title: "连接失败", message: `${action.label}失败，请刷新确认。` });
        await reload();
      }
    } finally {
      if (authority.isCurrent(token)) setBusy(false);
    }
  }, [authority, commandClient, complete, detail, onError, onFailure, online, reload, scope]);

  const confirm = useCallback(async () => {
    if (pending === null || !online) return;
    const snapshotIsCurrent =
      pending.snapshot.scope === scope && mobileTaskDetailStillMatches(detail, pending.snapshot);
    const responseIsCurrent =
      pending.kind !== "respond" ||
      (detail !== null &&
        mobileTaskResponseSummaryMatches(detail, currentStaffId, pending.body, pending.summary));
    const transitionIsCurrent =
      pending.kind !== "transition" ||
      mobileTaskTransitionStillMatches(
        scope,
        detail,
        pending.body,
        pending.authority,
        pending.authorityKey,
      );
    if (!snapshotIsCurrent || !responseIsCurrent || !transitionIsCurrent) {
      authority.invalidate("mutation");
      setPending(null);
      onError({ title: "确认已失效", message: "任务、订单或当前会话已变化，请刷新后重新发起。" });
      await reload();
      return;
    }
    const token = authority.begin(
      "mutation",
      JSON.stringify([
        pending.kind === "transition" ? pending.authorityKey : pending.snapshot,
        pending.confirmRef,
      ]),
    );
    setBusy(true);
    try {
      const command =
        pending.kind === "respond" ? "delivery.task.respond" : "delivery.order.transition";
      const result = await commandClient.execute<unknown>(
        command,
        {},
        {
          confirmRef: pending.confirmRef,
          signal: token.signal,
        },
      );
      if (!authority.isCurrent(token)) return;
      if (!result.ok) {
        setPending(null);
        onFailure(result.error, "确认执行失败");
        await reload();
        return;
      }
      if (pending.kind === "respond") {
        const updated = parseDeliveryTaskMutation(result.data);
        if (
          updated === null ||
          !mobileTaskResponseResultMatches(updated, detail, currentStaffId, pending.body)
        ) {
          setPending(null);
          onError({ title: "响应不可信", message: "接单响应无法安全解析。" });
          await reload();
          return;
        }
        await complete(pending.body.decision === "accept" ? "任务已接受" : "任务已拒绝");
      } else {
        const updated = parseDeliveryOrderMutation(result.data);
        if (updated === null || !mobileTaskTransitionResultMatches(updated, detail, pending.body)) {
          setPending(null);
          onError({ title: "响应不可信", message: "配送状态响应无法安全解析。" });
          await reload();
          return;
        }
        await complete(`${pending.action.label}完成`);
      }
    } catch {
      if (authority.isCurrent(token)) {
        setPending(null);
        onError({ title: "连接失败", message: "确认结果未知，请刷新核对。" });
        await reload();
      }
    } finally {
      if (authority.isCurrent(token)) setBusy(false);
    }
  }, [
    authority,
    commandClient,
    complete,
    currentStaffId,
    detail,
    onError,
    onFailure,
    online,
    pending,
    reload,
    scope,
  ]);

  const reset = useCallback(() => {
    authority.invalidate("mutation");
    setPending(null);
    setBusy(false);
  }, [authority]);

  return Object.freeze({ pending, busy, respond, transition, confirm, reset });
}

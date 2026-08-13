import { Button, useToast } from "@laundry/ui";
import { useCallback } from "react";

import type { AuthClient } from "../auth/AuthClient.js";
import type { SessionView } from "../auth/types.js";
import type { CommandPort, QueryPort } from "../commands/types.js";
import { DangerConfirmDialog } from "../pages/DangerConfirmDialog.js";
import { DeliveryTaskPendingSummary } from "../pages/DeliveryTaskPendingSummary.js";
import {
  MobileTaskDetailCard,
  MobileTaskList,
  MobileTaskTransitionSummary,
} from "./MobileTaskCards.js";
import { useMobileTaskWorkbench } from "./use-mobile-task-workbench.js";

export type MobileTaskShellProps = Readonly<{
  session: SessionView;
  authClient: Pick<AuthClient, "logout">;
  commandClient: CommandPort;
  queryClient: QueryPort;
  onSessionChange(session: SessionView | null): void;
}>;

export function MobileTaskShell({
  session,
  authClient,
  commandClient,
  queryClient,
  onSessionChange,
}: MobileTaskShellProps) {
  const toast = useToast();
  const closeHostSession = useCallback(() => {
    onSessionChange(null);
    void authClient.logout().catch(() => undefined);
  }, [authClient, onSessionChange]);
  const announceSuccess = useCallback((message: string) => toast.push(message, "success"), [toast]);
  const workbench = useMobileTaskWorkbench({
    session,
    queryClient,
    commandClient,
    onSessionExpired: closeHostSession,
    onSuccess: announceSuccess,
  });
  const pending = workbench.pending;

  const logout = () => {
    workbench.clearSensitiveState();
    closeHostSession();
  };

  return (
    <div
      className="ld-mobile-task-shell"
      data-shell="mobile-delivery-tasks"
      data-role={session.role}
      data-online={workbench.online ? "true" : "false"}
      data-delivery-feature={session.features.delivery_enabled === true ? "on" : "off"}
    >
      <a className="ld-mobile-task-skip" href="#mobile-task-main">
        跳到任务内容
      </a>
      <header className="ld-mobile-task-header">
        <div className="ld-mobile-task-identity">
          <span>配送任务 H5</span>
          <strong>{session.display.store_name}</strong>
          <small>{session.display.staff_name}</small>
        </div>
        <div className="ld-mobile-task-header__actions">
          <span
            className="ld-mobile-task-connectivity"
            data-online={workbench.online ? "true" : "false"}
            role="status"
          >
            {workbench.online ? "● 在线" : "○ 离线"}
          </span>
          <button type="button" className="ld-mobile-task-logout" onClick={logout}>
            退出
          </button>
        </div>
      </header>

      <main id="mobile-task-main" className="ld-mobile-task-main" tabIndex={-1}>
        <section className="ld-mobile-task-hero" aria-labelledby="mobile-task-title">
          <div>
            <span>当前员工 · 当前门店</span>
            <h1 id="mobile-task-title">我的配送任务</h1>
            <p>在线接单、拒绝并推进既有配送腿；不采集定位、照片或签名。</p>
          </div>
          <Button
            variant="secondary"
            type="button"
            disabled={!workbench.online || workbench.listLoading || workbench.mutationBusy}
            onClick={workbench.refresh}
          >
            {workbench.listLoading ? "刷新中…" : "刷新任务"}
          </Button>
        </section>

        {!workbench.online ? (
          <div className="ld-mobile-task-banner is-offline" role="status">
            网络已断开。保留本次登录下最后一次读取结果供核对，接单与状态操作均已停用；恢复网络后会自动刷新。
          </div>
        ) : null}
        {session.features.delivery_enabled === true ? null : (
          <div className="ld-mobile-task-banner" role="status">
            取送新订单入口已关闭；已存在的任务仍可接拒并安全收口。
          </div>
        )}
        {workbench.error === null ? null : (
          <div className="ld-mobile-task-error" role="alert">
            <div>
              <strong>{workbench.error.title}</strong>
              <span>{workbench.error.message}</span>
            </div>
            {workbench.online ? (
              <Button variant="secondary" type="button" onClick={workbench.refresh}>
                重试
              </Button>
            ) : null}
          </div>
        )}

        <div className="ld-mobile-task-filter" role="group" aria-label="任务范围">
          <button
            type="button"
            aria-pressed={workbench.activeOnly}
            disabled={workbench.mutationBusy}
            onClick={() => workbench.setActiveOnly(true)}
          >
            进行中
          </button>
          <button
            type="button"
            aria-pressed={!workbench.activeOnly}
            disabled={workbench.mutationBusy}
            onClick={() => workbench.setActiveOnly(false)}
          >
            全部记录
          </button>
        </div>

        <div className="ld-mobile-task-layout">
          <MobileTaskList
            tasks={workbench.tasks}
            selectedId={workbench.selectedId}
            loaded={workbench.loaded}
            loading={workbench.listLoading}
            busy={workbench.mutationBusy}
            onSelect={(taskId) => workbench.selectTask(taskId)}
          />
          <MobileTaskDetailCard
            selectedTask={workbench.selectedTask}
            detail={workbench.detail}
            loading={workbench.detailLoading}
            online={workbench.online}
            busy={workbench.mutationBusy}
            reason={workbench.reason}
            onBack={() => workbench.selectTask(null)}
            onReasonChange={workbench.setReason}
            onRespond={(decision) => void workbench.respond(decision)}
            onTransition={() => void workbench.transition()}
          />
        </div>
      </main>

      <footer className="ld-mobile-task-footer">在线任务面 · 订单状态为权威 · 现场证据后置</footer>

      <DangerConfirmDialog
        open={pending !== null}
        title={
          pending?.kind === "respond"
            ? pending.body.decision === "accept"
              ? "确认接受任务"
              : "确认拒绝任务"
            : (pending?.action.label ?? "确认配送状态")
        }
        description="以下内容绑定服务端当前任务与订单版本；确认前请核对。"
        summary={
          pending?.kind === "respond" ? (
            <DeliveryTaskPendingSummary summary={pending.summary} />
          ) : pending?.kind === "transition" ? (
            <MobileTaskTransitionSummary pending={pending} />
          ) : undefined
        }
        confirmLabel="确认执行"
        serverConfirmation
        busy={workbench.mutationBusy}
        onClose={workbench.closePending}
        onConfirm={() => void workbench.confirmPending()}
      />
    </div>
  );
}

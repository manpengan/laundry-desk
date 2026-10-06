import { Button } from "@laundry/ui";
import type { ReceiveWorkspace, ReceiveWorkspaceState } from "./receive-workspace.js";

type Props = Readonly<{
  state: ReceiveWorkspaceState;
  store: ReceiveWorkspace;
  confirmDiscard: (message: string) => Promise<boolean>;
  onReset: () => void;
  onRetry: () => void;
}>;

export function ReceiveProgressPanel({ state, store, confirmDiscard, onReset, onRetry }: Props) {
  const finishCheckedOperation = async (): Promise<void> => {
    if (
      !(await confirmDiscard(
        "请先在工作台核对本次客户、票号和收款记录。仅在确认本次业务已处理后继续；结果仍不确定时请返回保留，勿再次收款。",
      ))
    )
      return;
    if (store.getSnapshot().phase === "uncertain" && !store.getSnapshot().busy) store.reset();
  };
  if (state.phase === "complete")
    return (
      <section className="ld-receive-complete" role="status">
        <h2>开单已完成</h2>
        <p>本单已登记。确认票号与收款结果后，可开始下一单。</p>
        <Button type="button" onClick={onReset}>
          开下一单
        </Button>
      </section>
    );
  if (state.phase === "queued")
    return (
      <section className="ld-receive-complete" role="status">
        <h2>已离线暂存</h2>
        <p>本机服务暂时连不上，本单已加密暂存在本机，恢复连接后自动开单并生成票号。</p>
        <p>已登记的现金照常收取，不要再次提交本单；同步进度见顶部状态。</p>
        <Button type="button" onClick={onReset}>
          开下一单
        </Button>
      </section>
    );
  if (state.phase === "submitting")
    return (
      <p role="status" aria-live="polite">
        正在确认开单，请稍候…
      </p>
    );
  if (state.phase === "uncertain")
    return (
      <section className="ld-receive-uncertain" role="alert">
        <h2>先确认本次开单结果</h2>
        <p>{state.message}</p>
        <p>输入已保留。确认结果前，暂不接受修改或新单提交。</p>
        <div className="ld-form-actions">
          {state.retryable ? (
            <Button type="button" disabled={state.busy} onClick={onRetry}>
              重试确认本次开单
            </Button>
          ) : null}
          {state.recoveryStatus === "browser" ? (
            <Button
              type="button"
              variant="secondary"
              disabled={state.busy}
              onClick={() => void finishCheckedOperation()}
            >
              已人工核对，结束本次操作
            </Button>
          ) : null}
        </div>
        <p>
          {state.recoveryStatus === "browser"
            ? "可先切到工作台核对订单和收款记录。人工结束只清空本页，不新增订单或收款。"
            : "原开单身份已保存在本机。请连接服务后重试确认；核对成功前将继续保留本单，不会创建新单。"}
        </p>
      </section>
    );
  return state.dirty ? (
    <p className="ld-shell-main__hint" role="status">
      未暂存 · 切页保留当前输入；刷新或切换员工前请暂存。暂存不入账，重新登录后需核对首笔收款。
    </p>
  ) : null;
}

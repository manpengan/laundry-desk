import {
  DesktopReceiveRecoveryInputSchema,
  ReceiveRecoveryDraftSchema,
  type ReceiveRecoveryDraft,
  type ReceiveRecoverySession,
  type ReceiveRecoverySnapshot,
} from "@laundry/contracts";
import type { CommandResult, QueryPort } from "../commands/types.js";
import type { ReceiveRecoveryPort } from "../host/receive-recovery-port.js";
import { parseOrderGetResult, parseReceiveOrderResult, unwrapCommandResult } from "./order-form.js";
import { isOfflineQueuedReceive } from "./receive-submission.js";
import type { ReceiveWorkspace, ReceiveWorkspaceState } from "./receive-workspace.js";

function draftFrom(state: ReceiveWorkspaceState): ReceiveRecoveryDraft {
  const {
    operationId,
    phone,
    name,
    paymentCents,
    paymentMethod,
    pricing,
    note,
    draftId,
    lines,
    dirty,
  } = state;
  return ReceiveRecoveryDraftSchema.parse({
    operationId,
    phone,
    name,
    paymentCents,
    paymentMethod,
    pricing,
    note,
    draftId,
    lines,
    dirty,
  });
}
const failed = (message: string): CommandResult<unknown> => ({
  ok: false,
  error: { code: "RECOVERY_UNAVAILABLE", message, outcomeUnknown: true },
});

/** The binding captures this renderer session. Late callbacks cannot save into a new employee. */
export function connectReceiveRecovery(
  store: ReceiveWorkspace,
  port: ReceiveRecoveryPort,
  expected: ReceiveRecoverySession,
  query: QueryPort,
) {
  store.patch({ recoveryStatus: "loading", recoveryMessage: "正在读取本机开单恢复记录…" });
  let disposed = false;
  let loaded = false;
  let lastQueued = "";
  let lastSaved = "";
  let tail = Promise.resolve();
  const problem = (message: string): void => {
    if (
      !disposed &&
      (store.getSnapshot().recoveryStatus !== "error" ||
        store.getSnapshot().recoveryMessage !== message)
    )
      store.patch({ recoveryStatus: "error", recoveryMessage: message });
  };
  const queueSave = (): void => {
    if (!loaded || disposed) return;
    let draft: ReceiveRecoveryDraft;
    try {
      draft = draftFrom(store.getSnapshot());
    } catch {
      problem("开单内容超过本机恢复保存限制，请减少内容后重试");
      return;
    }
    const text = JSON.stringify(draft);
    if (text === lastQueued) return;
    lastQueued = text;
    tail = tail
      .then(async () => {
        if (disposed || text !== lastQueued) return;
        store.patch({ recoveryStatus: "saving", recoveryMessage: "正在安全保存本机开单内容…" });
        const response = await port.execute({
          operation: "save",
          expected_session: expected,
          draft,
        });
        if (disposed) return;
        if (!response.ok) {
          problem(response.error.message);
          return;
        }
        lastSaved = text;
        if (lastSaved === lastQueued)
          store.patch({ recoveryStatus: "ready", recoveryMessage: "本机开单内容已加密保存" });
      })
      .catch(() => problem("本机开单内容保存失败，已暂停提交，请重试保存"));
  };
  const flush = async (): Promise<boolean> => {
    queueSave();
    await tail;
    return !disposed && loaded && lastSaved === JSON.stringify(draftFrom(store.getSnapshot()));
  };
  const currentReceipt = async (
    snapshot: ReceiveRecoverySnapshot,
  ): Promise<CommandResult<unknown>> => {
    const receipt = snapshot.receipt;
    if (receipt === null) return failed("原开单结果尚未确认，请使用原开单重试，不要再次收款");
    if (!receipt.ok)
      return { ok: false, error: { code: receipt.error.code, message: receipt.error.message } };
    // The offline queue holds it: there is no order to read back until it replays.
    if (isOfflineQueuedReceive(unwrapCommandResult(receipt.data)))
      return { ok: true, data: receipt.data };
    const result = parseReceiveOrderResult(unwrapCommandResult(receipt.data));
    if (result === null) return failed("原开单结果无法显示，请先核对订单，避免重复开单");
    // A later QR payment may have occurred before the crash. Never expose the old debt as payable.
    const latest = await query.execute<unknown>("order.get", { order_id: result.order_id });
    const order = latest.ok ? parseOrderGetResult(unwrapCommandResult(latest.data)) : null;
    if (order === null || order.order_id !== result.order_id)
      return failed("原开单已成功，但最新金额尚未核实，请连接服务后恢复核对，勿再次收款");
    const merged = parseReceiveOrderResult({
      ...result,
      payable_cents: order.payable_cents,
      paid_cents: order.paid_cents,
      balance_cents: order.balance_cents,
    });
    if (merged === null) return failed("原订单状态已变化，请到订单中心核对后再操作");
    return {
      ok: true,
      data: {
        result: merged,
      },
    };
  };
  const restore = async (): Promise<void> => {
    const response = await port.execute({ operation: "load", expected_session: expected });
    if (disposed) return;
    if (!response.ok) {
      problem(response.error.message);
      return;
    }
    const snapshot = response.data;
    if (snapshot.draft !== null) {
      const { draft, pending_body: body } = snapshot;
      const lines = draft.lines.map(({ catalog_name, catalog_code, ...line }) => ({
        ...line,
        ...(catalog_name === undefined ? {} : { catalog_name }),
        ...(catalog_code === undefined ? {} : { catalog_code }),
      }));
      let patch: Partial<ReceiveWorkspaceState> = {
        ...draft,
        lines,
        busy: false,
        ticketPreview: null,
        confirmedPaymentIntentIds: [],
        pendingBody: body,
      };
      if (body !== null) {
        const outcome = await currentReceipt(snapshot);
        if (disposed) return;
        if (outcome.ok) {
          const accepted = unwrapCommandResult(outcome.data);
          patch = isOfflineQueuedReceive(accepted)
            ? {
                ...patch,
                phase: "queued",
                result: null,
                dirty: false,
                retryable: false,
                message: "",
              }
            : {
                ...patch,
                phase: "complete",
                result: parseReceiveOrderResult(accepted),
                dirty: false,
                retryable: false,
                message: "已恢复原开单并核对最新金额。",
              };
        } else if (snapshot.receipt !== null && !snapshot.receipt.ok) {
          patch = {
            ...patch,
            phase: "editing",
            operationId: crypto.randomUUID(),
            pendingBody: null,
            message: "上次开单未成功，已恢复录入内容，请核对后重新提交。",
          };
        } else {
          patch = {
            ...patch,
            phase: "uncertain",
            retryable: true,
            message: outcome.error.message ?? "请核对原开单",
          };
        }
      }
      store.patch(patch);
    }
    loaded = true;
    lastQueued = "";
    queueSave();
  };
  store.setRecoverySubmit(async (body, operationId) => {
    if (!(await flush())) return failed("本机恢复记录尚未安全保存，未发送开单；请重试保存后继续");
    const input = DesktopReceiveRecoveryInputSchema.parse({
      operation: "submit",
      expected_session: expected,
      operation_id: operationId,
      body,
    });
    const response = await port.execute(input);
    if (disposed) return failed("登录身份已变化，本次操作保留在原员工的恢复记录中");
    if (!response.ok) return failed(response.error.message);
    return currentReceipt(response.data);
  });
  const retry = async (): Promise<void> => {
    if (!loaded) return restore();
    lastQueued = "";
    queueSave();
    await tail;
  };
  store.setRecoveryRetry(retry);
  const unsubscribe = store.subscribe(queueSave);
  void restore().catch(() => problem("无法读取本机开单恢复记录，请重试；恢复前不会发送新开单"));
  return () => {
    disposed = true;
    unsubscribe();
    store.setRecoverySubmit(async () => failed("此登录会话已结束，请重新登录"));
    store.setRecoveryRetry(async () => undefined);
  };
}

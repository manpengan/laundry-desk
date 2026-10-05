import type { CommandPort } from "../commands/types.js";
import {
  parseReceiveOrderResult,
  unwrapCommandResult,
  type ReceiveOrderResult,
} from "./order-form.js";
import type { ReceiveWorkspace } from "./receive-workspace.js";

const UNCERTAIN_CODES = new Set([
  "NETWORK",
  "SERVICE_UNAVAILABLE",
  "REQUEST_ABORTED",
  "DESKTOP_BRIDGE",
  "COMMAND_FAILED",
  "TRANSACTION_FAILED",
  "EVENT_DISPATCH_FAILED",
  "INTERNAL_ERROR",
  "TRANSPORT_UNAVAILABLE",
  "RESOURCE_UNAVAILABLE",
  "RECOVERY_UNAVAILABLE",
  "RECOVERY_CONFLICT",
]);

/** Lock synchronously before awaiting transport; a completed or unknown operation cannot be resubmitted. */
export async function submitReceive(
  store: ReceiveWorkspace,
  port: CommandPort,
  body: Readonly<Record<string, unknown>>,
  retry = false,
): Promise<ReceiveOrderResult | null> {
  const { pendingBody: pending, operationId } = store.getSnapshot();
  if (retry && pending === null) return null;
  if (!store.begin(retry)) return null;
  const input = retry && pending !== null ? pending : body;
  store.patch({ pendingBody: input, retryable: false });
  try {
    const response = await store.submit(port, input, operationId);
    if (!response.ok) {
      const uncertain =
        response.error.outcomeUnknown === true || UNCERTAIN_CODES.has(response.error.code);
      store.patch({
        busy: false,
        phase: uncertain ? "uncertain" : "editing",
        retryable: uncertain && response.error.code !== "DESKTOP_BRIDGE",
        message: response.error.message ?? "开单未完成，请检查输入",
        ...(!uncertain ? { operationId: crypto.randomUUID(), pendingBody: null } : {}),
      });
      return null;
    }
    const result = parseReceiveOrderResult(unwrapCommandResult(response.data));
    if (result === null) {
      store.patch({
        busy: false,
        phase: "uncertain",
        message: "服务已受理，但开单结果无法显示。请先核对订单，避免重复开单。",
      });
      return null;
    }
    store.patch({
      busy: false,
      phase: "complete",
      result,
      draftId: null,
      dirty: false,
      message: "",
      pendingBody: null,
    });
    return result;
  } catch {
    store.patch({
      busy: false,
      phase: "uncertain",
      retryable: true,
      message: "开单结果尚未确认，请先确认本次提交的结果，避免重复收款。",
    });
    return null;
  }
}

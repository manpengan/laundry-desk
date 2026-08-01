import {
  DesktopCommandExecuteResultSchema,
  createCommandError,
  type DesktopCommandExecuteResult,
} from "@laundry/contracts";

export function offlineResourceFailure(): DesktopCommandExecuteResult {
  return Object.freeze({
    ok: false,
    error: createCommandError(
      "RESOURCE_UNAVAILABLE",
      Object.freeze({ kind: "reason", reason: "retry_later" }),
    ),
  });
}

export function offlineQueuedSuccess(
  body: Readonly<Record<string, unknown>>,
  queueId: string,
): DesktopCommandExecuteResult {
  return DesktopCommandExecuteResultSchema.parse({
    ok: true,
    data: {
      execution: "executed",
      result: { ...body, offline_queued: true, queue_id: queueId },
    },
  });
}

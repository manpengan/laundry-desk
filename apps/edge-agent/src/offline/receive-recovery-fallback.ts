import type { DesktopHttpTransport } from "../desktop/http-transport.js";
import type { OfflineCommandRuntime } from "./runtime.js";

const READ_ONLY = Object.freeze({
  ok: false,
  error: Object.freeze({
    code: "RECOVERY_UNAVAILABLE",
    message: "当前为只读模式，不能恢复或提交开单",
  }),
});

/** A receive submission whose answer never arrived: no receipt was recorded for it. */
function isUnansweredReceive(input: unknown, result: unknown): boolean {
  return (
    typeof input === "object" &&
    input !== null &&
    Reflect.get(input, "operation") === "submit" &&
    typeof result === "object" &&
    result !== null &&
    Reflect.get(result, "ok") === false &&
    Reflect.get(Reflect.get(result, "error") ?? {}, "code") === "RECOVERY_UNAVAILABLE"
  );
}

/**
 * The desktop receive path with its offline fallback. Only a local service that is down
 * hands an unanswered receive to the offline queue, under the key it was (or would have
 * been) sent with; while the service answers, the clerk keeps retrying that key.
 */
export function createOfflineReceiveRecovery(
  online: DesktopHttpTransport,
  offline: Pick<OfflineCommandRuntime, "queueCommand">,
  isMutationBlocked: () => boolean,
) {
  return Object.freeze({
    execute: async (input: unknown): Promise<unknown> => {
      const recovery = online.receiveRecovery;
      if (isMutationBlocked() || recovery === undefined) return READ_ONLY;
      const result = await recovery.execute(input);
      if (recovery.queueOffline === undefined || !isUnansweredReceive(input, result)) return result;
      if ((await online.health.get()).ok) return result;
      const queued = await recovery.queueOffline(input, (body, idempotencyKey) =>
        offline.queueCommand({ name: "order.receive", body }, { idempotencyKey }),
      );
      return queued ?? result;
    },
  });
}

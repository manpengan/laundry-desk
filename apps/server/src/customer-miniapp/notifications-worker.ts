import type { FastifyInstance } from "fastify";
import type { LocalRuntime } from "../local/runtime-types.js";
import type { ByokKmsPort } from "../ai/byok-kms.js";
import { LOCAL_PROFILE } from "../local/profile.js";
import { safeErrorContext } from "../http/local-logger.js";
import { createWechatNotificationDispatcher } from "./notifications-dispatch.js";
/** Sends only durable, human-confirmed rows. Unknown dispatches are never selected again. */
export function installWechatNotificationWorker(
  app: FastifyInstance,
  local: LocalRuntime,
  kms: ByokKmsPort | null,
) {
  if (local.pool === null || kms === null) return;
  const dispatcher = createWechatNotificationDispatcher(local, kms);
  const tenant = {
    orgId: LOCAL_PROFILE.orgId,
    storeId: LOCAL_PROFILE.storeId,
    staffId: LOCAL_PROFILE.adminStaffId,
  };
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let pending: Promise<void> | null = null;
  const run = async () => {
    for (const row of await dispatcher.due(tenant)) {
      if (stopped) return;
      try {
        await dispatcher.advance(tenant, row.id);
      } catch (error) {
        app.log.error(safeErrorContext(error), "WeChat notification worker failed");
      }
    }
  };
  const tick = () => {
    if (stopped || pending !== null) return;
    pending = run()
      .catch((error) =>
        app.log.error(safeErrorContext(error), "WeChat notification selection failed"),
      )
      .finally(() => {
        pending = null;
      });
  };
  app.addHook("onReady", async () => {
    timer = setInterval(tick, 10_000);
    timer.unref();
    tick();
  });
  app.addHook("onClose", async () => {
    stopped = true;
    if (timer !== undefined) clearInterval(timer);
    await pending;
  });
}

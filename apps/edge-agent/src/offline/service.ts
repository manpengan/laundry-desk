import {
  DesktopOfflineResolveInputSchema,
  DesktopSessionViewSchema,
  type DesktopSessionView,
} from "@laundry/contracts";

import type { DesktopHttpTransport } from "../desktop/http-transport.js";
import type { DesktopOperationService } from "../transport/handlers.js";
import type { OfflineCommandRuntime } from "./runtime.js";

function isUnavailable(
  result: Readonly<{ ok: boolean; error?: Readonly<{ code?: string }> }>,
): boolean {
  return result.ok === false && result.error?.code === "RESOURCE_UNAVAILABLE";
}

export function createOfflineDesktopService(
  online: DesktopHttpTransport,
  offline: OfflineCommandRuntime,
): DesktopOperationService {
  let session: DesktopSessionView | null = null;

  const rememberSession = async (value: unknown): Promise<void> => {
    const parsed = await DesktopSessionViewSchema.safeParseAsync(value);
    if (parsed.success) session = parsed.data;
  };

  const maintain = async (): Promise<void> => {
    const current = session;
    if (current === null) return;
    await offline.refreshAuthority(current);
    await offline.replay();
  };

  return Object.freeze({
    auth: Object.freeze({
      login: async (input: unknown) => {
        const result = await online.auth.login(input);
        if (result.ok) {
          session = result.data.session_view;
          await maintain();
        }
        return result;
      },
      refresh: async () => {
        const result = await online.auth.refresh();
        if (result.ok) {
          session = result.data;
          await maintain();
        }
        return result;
      },
      pinChallenge: (input: unknown) => online.auth.pinChallenge(input),
      pinVerify: async (input: unknown) => {
        const result = await online.auth.pinVerify(input);
        if (result.ok) {
          await rememberSession(result.data);
          await maintain();
        }
        return result;
      },
      logout: async () => {
        offline.invalidateContinuity();
        session = null;
        return online.auth.logout();
      },
    }),
    command: Object.freeze({
      execute: async (input: unknown) => {
        const result = await online.command.execute(input);
        if (isUnavailable(result)) {
          const health = await online.health.get();
          if (!health.ok) return offline.queueCommand(input);
        }
        if (result.ok) await maintain();
        return result;
      },
    }),
    query: Object.freeze({
      execute: async (input: unknown) => {
        const result = await online.query.execute(input);
        if (result.ok) await maintain();
        return result;
      },
    }),
    photo: Object.freeze({
      upload: async (input: unknown) => {
        const result = await online.photo.upload(input);
        if (result.ok) await maintain();
        return result;
      },
      read: (input: unknown) => online.photo.read(input),
      delete: async (input: unknown) => {
        const result = await online.photo.delete(input);
        if (result.ok) await maintain();
        return result;
      },
    }),
    offline: Object.freeze({
      status: async () => offline.status(),
      resolve: async (input: unknown) => {
        const parsed = await DesktopOfflineResolveInputSchema.parseAsync(input);
        offline.resolve(parsed);
        if (parsed.action === "retry") await offline.replay();
        return offline.status();
      },
    }),
    health: online.health,
  });
}

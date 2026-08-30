import {
  DesktopOfflineResolveInputSchema,
  DesktopOfflineResumeResultSchema,
  DesktopSessionViewSchema,
  createCommandError,
  type DesktopSessionView,
} from "@laundry/contracts";

import type { DesktopHttpTransport } from "../desktop/http-transport.js";
import type { DesktopOperationService } from "../transport/handlers.js";
import type { OfflineReadCache } from "./read-cache.js";
import type { OfflineCommandRuntime } from "./runtime.js";

export type OfflineDesktopServiceOptions = Readonly<{
  recoveryReadOnly?: boolean;
}>;

function isUnavailable(
  result: Readonly<{ ok: boolean; error?: Readonly<{ code?: string }> }>,
): boolean {
  return result.ok === false && result.error?.code === "RESOURCE_UNAVAILABLE";
}

export function createOfflineDesktopService(
  online: DesktopHttpTransport,
  offline: OfflineCommandRuntime,
  cache: OfflineReadCache,
  options: OfflineDesktopServiceOptions = {},
): DesktopOperationService {
  const recoveryReadOnly = options.recoveryReadOnly === true;
  let session: DesktopSessionView | null = null;
  let offlineReadOnly = false;
  let sessionRevision = 0;
  let maintenanceTail = Promise.resolve();
  const isMutationBlocked = (): boolean => recoveryReadOnly || offlineReadOnly;

  const replaceSession = (next: DesktopSessionView | null, readOnly: boolean): void => {
    session = next;
    offlineReadOnly = readOnly;
    sessionRevision += 1;
    offline.reconcileSession(next);
  };

  const unavailable = () =>
    Object.freeze({
      ok: false as const,
      error: createCommandError(
        "RESOURCE_UNAVAILABLE",
        Object.freeze({ kind: "reason", reason: "retry_later" }),
      ),
    });

  const rememberSession = async (value: unknown): Promise<void> => {
    const parsed = await DesktopSessionViewSchema.safeParseAsync(value);
    if (parsed.success) {
      replaceSession(parsed.data, false);
    }
  };

  const discardReadCache = (): void => {
    offline.invalidateContinuity();
    offline.clearReadAuthority();
    replaceSession(null, false);
    try {
      cache.clear();
    } catch (error) {
      console.error("[edge-agent] offline read cache clear failed", {
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
    }
  };

  const maintain = (): Promise<void> => {
    const current = session;
    const revision = sessionRevision;
    if (recoveryReadOnly || current === null) return Promise.resolve();
    const task = maintenanceTail.then(async () => {
      if (revision !== sessionRevision || session !== current) return;
      await offline.refreshAuthority(current);
      if (revision !== sessionRevision || session !== current) {
        offline.reconcileSession(session);
        return;
      }
      await offline.replay();
      if (revision !== sessionRevision || session !== current) {
        offline.reconcileSession(session);
        return;
      }
      const authority = offline.exportReadAuthority(current);
      if (authority === null) return;
      try {
        cache.bind(current, authority);
      } catch (error) {
        console.error("[edge-agent] offline read cache bind failed", {
          errorName: error instanceof Error ? error.name : "UnknownError",
        });
      }
    });
    maintenanceTail = task.catch(() => undefined);
    return task;
  };

  return Object.freeze({
    auth: Object.freeze({
      login: async (input: unknown) => {
        const result = await online.auth.login(input);
        if (result.ok) {
          replaceSession(result.data.session_view, false);
          await maintain();
        }
        return result;
      },
      refresh: async () => {
        const result = await online.auth.refresh();
        if (result.ok) {
          replaceSession(result.data, false);
          await maintain();
        } else if (!isUnavailable(result)) {
          discardReadCache();
        }
        return result;
      },
      staffDirectory: () => online.auth.staffDirectory(),
      pinChallenge: (input: unknown) =>
        isMutationBlocked() ? Promise.resolve(unavailable()) : online.auth.pinChallenge(input),
      pinVerify: async (input: unknown) => {
        if (isMutationBlocked()) return unavailable();
        const result = await online.auth.pinVerify(input);
        if (result.ok) {
          await rememberSession(result.data);
          await maintain();
        }
        return result;
      },
      credentialComplete: (input: unknown) =>
        isMutationBlocked()
          ? Promise.resolve(unavailable())
          : online.auth.credentialComplete(input),
      logout: async () => {
        discardReadCache();
        return online.auth.logout();
      },
    }),
    command: Object.freeze({
      execute: async (input: unknown) => {
        if (isMutationBlocked()) return unavailable();
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
        const querySession = session;
        const queryRevision = sessionRevision;
        const queryWasReadOnly = offlineReadOnly;
        const discardObservedReadOnlySession = (): void => {
          if (
            queryWasReadOnly &&
            offlineReadOnly &&
            session === querySession &&
            sessionRevision === queryRevision
          ) {
            discardReadCache();
          }
        };
        const result = await online.query.execute(input);
        if (result.ok) {
          if (
            queryWasReadOnly &&
            offlineReadOnly &&
            session === querySession &&
            sessionRevision === queryRevision &&
            querySession !== null
          ) {
            replaceSession(querySession, false);
          }
          await maintain();
          const current = session;
          if (!recoveryReadOnly && current !== null) {
            try {
              await cache.put(current, input, result);
            } catch (error) {
              console.error("[edge-agent] offline read cache update failed", {
                errorName: error instanceof Error ? error.name : "UnknownError",
              });
            }
          }
          return result;
        }
        if (!isUnavailable(result)) {
          discardObservedReadOnlySession();
          return result;
        }
        const health = await online.health.get();
        if (health.ok) {
          discardObservedReadOnlySession();
          return result;
        }
        const current = session;
        if (current !== null) {
          try {
            const cached = await cache.get(current, input);
            if (cached !== null) {
              return cached;
            }
          } catch (error) {
            console.error("[edge-agent] offline read cache lookup failed", {
              errorName: error instanceof Error ? error.name : "UnknownError",
            });
          }
        }
        return result;
      },
    }),
    photo: Object.freeze({
      upload: async (input: unknown) => {
        if (isMutationBlocked()) return unavailable();
        const result = await online.photo.upload(input);
        if (result.ok) await maintain();
        return result;
      },
      read: (input: unknown) =>
        offlineReadOnly && !recoveryReadOnly
          ? Promise.resolve(unavailable())
          : online.photo.read(input),
      delete: async (input: unknown) => {
        if (isMutationBlocked()) return unavailable();
        const result = await online.photo.delete(input);
        if (result.ok) await maintain();
        return result;
      },
    }),
    offline: Object.freeze({
      resume: async () => {
        const refreshed = await online.auth.refresh();
        if (refreshed.ok) {
          replaceSession(refreshed.data, false);
          await maintain();
          return DesktopOfflineResumeResultSchema.parse({
            ok: true,
            data: { mode: "online", session_view: refreshed.data },
          });
        }
        if (!isUnavailable(refreshed)) {
          discardReadCache();
          return refreshed;
        }
        const health = await online.health.get();
        if (health.ok) {
          discardReadCache();
          return refreshed;
        }
        const resumed = cache.resume();
        if (resumed === null) {
          replaceSession(null, false);
          return unavailable();
        }
        replaceSession(resumed.sessionView, true);
        offline.invalidateContinuity();
        return DesktopOfflineResumeResultSchema.parse({
          ok: true,
          data: {
            mode: "offline_read_only",
            session_view: resumed.sessionView,
            cached_query_count: resumed.cachedQueryCount,
            grant_not_after: resumed.grantNotAfter,
          },
        });
      },
      status: async () => offline.status(),
      resolve: async (input: unknown) => {
        if (isMutationBlocked()) return unavailable();
        const parsed = await DesktopOfflineResolveInputSchema.parseAsync(input);
        if (parsed.action === "discard") {
          const first = await online.command.execute({
            name: "edge.conflict.discard",
            body: {
              queue_id: parsed.queue_id,
              reason: parsed.reason,
              confirm: parsed.confirm,
            },
          });
          if (!first.ok) {
            const detail = "detail" in first.error ? first.error.detail : undefined;
            if (
              first.error.code !== "POLICY_CONFIRMATION_REQUIRED" ||
              detail?.kind !== "confirmation"
            ) {
              return first;
            }
            const confirmed = await online.command.execute({
              name: "edge.conflict.discard",
              confirm_ref: detail.confirm_ref,
            });
            if (!confirmed.ok) return confirmed;
          }
          offline.resolve(parsed);
        } else {
          offline.resolve(parsed);
          await offline.replay();
        }
        return offline.status();
      },
    }),
    health: Object.freeze({
      get: async () => {
        const result = await online.health.get();
        if (result.ok) return result;
        if (offlineReadOnly && session !== null) {
          return Object.freeze({ ok: true as const, data: Object.freeze({ status: "ready" }) });
        }
        return result;
      },
    }),
  });
}

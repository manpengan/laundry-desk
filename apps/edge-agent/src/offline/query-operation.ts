import type { DesktopQueryExecuteResult, DesktopSessionView } from "@laundry/contracts";

import type { DesktopHttpTransport } from "../desktop/http-transport.js";
import type { OfflineReadCache } from "./read-cache.js";

type QuerySessionScope = Readonly<{
  session: DesktopSessionView | null;
  isCurrent: () => boolean;
  promoteOnline: () => void;
  discardReadOnly: () => void;
}>;

type OfflineQueryOptions = Readonly<{
  recoveryReadOnly: boolean;
  captureSession: () => QuerySessionScope;
  maintain: () => Promise<void>;
  unavailable: () => DesktopQueryExecuteResult;
}>;

export function createOfflineQueryOperation(
  online: DesktopHttpTransport,
  cache: OfflineReadCache,
  options: OfflineQueryOptions,
): Readonly<{ execute: (input: unknown) => Promise<DesktopQueryExecuteResult> }> {
  return Object.freeze({
    execute: async (input: unknown) => {
      const scope = options.captureSession();
      const result = await online.query.execute(input);
      if (!scope.isCurrent()) return options.unavailable();
      if (result.ok) {
        scope.promoteOnline();
        await options.maintain();
        if (!scope.isCurrent()) return options.unavailable();
        if (!options.recoveryReadOnly && scope.session !== null) {
          try {
            await cache.put(scope.session, input, result);
          } catch (error) {
            console.error("[edge-agent] offline read cache update failed", {
              errorName: error instanceof Error ? error.name : "UnknownError",
            });
          }
        }
        return scope.isCurrent() ? result : options.unavailable();
      }
      if (result.error.code !== "RESOURCE_UNAVAILABLE") {
        scope.discardReadOnly();
        return result;
      }
      const health = await online.health.get();
      if (!scope.isCurrent()) return options.unavailable();
      if (health.ok) {
        scope.discardReadOnly();
        return result;
      }
      if (scope.session !== null) {
        try {
          const cached = await cache.get(scope.session, input);
          if (!scope.isCurrent()) return options.unavailable();
          if (cached !== null) return cached;
        } catch (error) {
          console.error("[edge-agent] offline read cache lookup failed", {
            errorName: error instanceof Error ? error.name : "UnknownError",
          });
        }
      }
      return scope.isCurrent() ? result : options.unavailable();
    },
  });
}

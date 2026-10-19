import type { DesktopQueryExecuteResult, DesktopSessionView } from "@laundry/contracts";

import type { DesktopHttpTransport } from "../desktop/http-transport.js";
import { authorityMatchesSession, bindAuthoritySession } from "./authority-session.js";
import type { VerifiedOfflineReadAuthority } from "./read-authority.js";
import type { OfflineReadCache } from "./read-cache.js";
import type { OfflineReadCacheWriter } from "./read-cache-writer.js";

type QuerySessionScope = Readonly<{
  session: DesktopSessionView | null;
  readOnly: boolean;
  isCurrent: () => boolean;
  promoteOnline: () => void;
  discardReadOnly: () => void;
}>;

async function queryOnline(
  online: DesktopHttpTransport,
  scope: QuerySessionScope,
  input: unknown,
  unavailable: () => DesktopQueryExecuteResult,
): Promise<DesktopQueryExecuteResult> {
  if (scope.readOnly) {
    if (scope.session === null) return unavailable();
    // Cold restart restores a verified cache session, never an in-memory access token.
    const refreshed = await online.auth.refresh();
    if (!scope.isCurrent()) return unavailable();
    if (!refreshed.ok) return refreshed;
    if (!authorityMatchesSession(bindAuthoritySession(scope.session), refreshed.data)) {
      // logout invalidates transport credentials synchronously, before clearing read-only mode.
      const loggedOut = online.auth.logout();
      scope.discardReadOnly();
      await loggedOut;
      return unavailable();
    }
  }
  return online.query.execute(input);
}

export type QueryCacheUpdate = (
  session: DesktopSessionView,
  authority: VerifiedOfflineReadAuthority | null,
) => Promise<void>;

type OfflineQueryOptions = Readonly<{
  recoveryReadOnly: boolean;
  captureSession: () => QuerySessionScope;
  maintain: (updateCache?: QueryCacheUpdate) => Promise<void>;
  unavailable: () => DesktopQueryExecuteResult;
}>;

export function createOfflineQueryOperation(
  online: DesktopHttpTransport,
  cache: OfflineReadCache,
  writer: OfflineReadCacheWriter,
  options: OfflineQueryOptions,
): Readonly<{ execute: (input: unknown) => Promise<DesktopQueryExecuteResult> }> {
  return Object.freeze({
    execute: async (input: unknown) => {
      const scope = options.captureSession();
      const result = await queryOnline(online, scope, input, options.unavailable);
      if (!scope.isCurrent()) return options.unavailable();
      if (result.ok) {
        scope.promoteOnline();
        await options.maintain(async (current, authority) => {
          if (
            options.recoveryReadOnly ||
            scope.session === null ||
            current !== scope.session ||
            !scope.isCurrent()
          )
            return;
          // The page's burst of queries shares one protected write (see OfflineReadCacheWriter).
          writer.enqueue({
            session: scope.session,
            authority,
            input,
            result,
            isSessionCurrent: scope.isCurrent,
          });
        });
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
          // Results still waiting for their batch must be readable once the service is gone.
          await writer.flush();
          if (!scope.isCurrent()) return options.unavailable();
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

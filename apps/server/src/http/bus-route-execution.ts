import type { FastifyReply } from "fastify";

import type { CommandErrorCode } from "@laundry/contracts";

import type { AuthorizedSession } from "../auth/session-view.js";
import { executeCommand } from "../bus/executor.js";
import { executeQuery } from "../bus/execute-query.js";
import { createRuntimeBus, permissionsForAuthority } from "../bus/runtime.js";
import type { ActorContext, CommandResult } from "../bus/types.js";
import { FakeSqlClient } from "../db/fake-client.js";
import { withPoolClient } from "../db/pg-sql-client.js";
import type { SqlClient, TenantContext } from "../db/types.js";
import type { LocalRuntime } from "../local/demo-seed.js";
import { fail, type RouteSecurityContext } from "./auth-route-support.js";
import { isRuntimeBusOperationAvailable } from "./runtime-surface-policy.js";

export function tenantFromSession(resolved: AuthorizedSession): TenantContext {
  return Object.freeze({
    orgId: resolved.session.org_id,
    storeId: resolved.session.store_id,
    staffId: resolved.session.staff_id,
  });
}

export function actorFromSession(resolved: AuthorizedSession): ActorContext {
  const { session, authority } = resolved;
  return Object.freeze({
    staffId: session.staff_id,
    deviceId: session.device_id,
    via: "ui" as const,
    permissions: permissionsForAuthority(authority),
  });
}

export function applyCommandErrorStatus(reply: FastifyReply, code: CommandErrorCode): void {
  if (code === "TRANSACTION_FAILED" || code === "EVENT_DISPATCH_FAILED") {
    reply.code(500);
    return;
  }
  const authorizationOutcome =
    code === "POLICY_STEP_UP_REQUIRED" ||
    code === "POLICY_CONFIRMATION_REQUIRED" ||
    code === "POLICY_APPROVAL_REQUIRED" ||
    code === "POLICY_DENIED" ||
    code === "PERMISSION_DENIED";
  reply.code(authorizationOutcome ? 403 : 400);
}

export function createSqlRunner(runtime: LocalRuntime) {
  const memorySql = new FakeSqlClient();
  return async <T>(operation: (sql: SqlClient) => Promise<T>): Promise<T> => {
    if (runtime.mode === "pg" && runtime.pool !== null) {
      return withPoolClient(runtime.pool, operation);
    }
    return operation(memorySql);
  };
}

export type SqlRunner = ReturnType<typeof createSqlRunner>;

export async function executeTrustedSessionCommand(
  context: RouteSecurityContext,
  resolved: AuthorizedSession,
  name: string,
  input: Readonly<Record<string, unknown>>,
  options: Readonly<{
    idempotencyKey?: string;
    onUnexpectedError?: (error: unknown) => void;
  }> = {},
): Promise<CommandResult> {
  if (!isRuntimeBusOperationAvailable(resolved, "command", name)) {
    return fail("RESOURCE_UNAVAILABLE");
  }
  const { registry, chainHooks } = createRuntimeBus(context.runtime);
  const runWithSql = createSqlRunner(context.runtime);
  return runWithSql((sql) =>
    executeCommand(sql, tenantFromSession(resolved), name, input, {
      registry,
      actor: actorFromSession(resolved),
      chainHooks,
      pendingStore: context.runtime.pendingStore,
      stepUpProofStore: context.runtime.stepUpProofStore,
      stepUpApproverAuthority: context.runtime.stepUpApproverAuthority,
      idempotencyStore: context.runtime.idempotencyStore,
      ...(options.onUnexpectedError === undefined
        ? {}
        : { onUnexpectedError: options.onUnexpectedError }),
      sessionBinding: Object.freeze({
        sessionId: resolved.session.session_id,
        sessionVersion: resolved.session.session_version,
      }),
      ...(options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey }),
    }),
  );
}

export async function executeTrustedSessionQuery(
  runtime: LocalRuntime,
  resolved: AuthorizedSession,
  name: string,
  input: Readonly<Record<string, unknown>>,
  onUnexpectedError?: (error: unknown) => void,
): Promise<CommandResult> {
  if (!isRuntimeBusOperationAvailable(resolved, "query", name)) {
    return fail("RESOURCE_UNAVAILABLE");
  }
  const { queryRegistry } = createRuntimeBus(runtime);
  const runWithSql = createSqlRunner(runtime);
  return runWithSql((sql) =>
    executeQuery(sql, tenantFromSession(resolved), name, input, {
      registry: queryRegistry,
      actor: actorFromSession(resolved),
      ...(onUnexpectedError === undefined ? {} : { onUnexpectedError }),
    }),
  );
}

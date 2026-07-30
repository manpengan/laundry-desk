import type { FastifyInstance, FastifyReply } from "fastify";

import { parseCommandWirePayload } from "@laundry/contracts";

import type { AuthorizedSession } from "../auth/session-view.js";
import { executeCommand } from "../bus/executor.js";
import { executeQuery } from "../bus/execute-query.js";
import type { ActorContext, CommandResult } from "../bus/types.js";
import { FakeSqlClient } from "../db/fake-client.js";
import { withPoolClient } from "../db/pg-sql-client.js";
import type { SqlClient, TenantContext } from "../db/types.js";
import { createRegisteredM1Bus } from "../handlers/register-m1.js";
import type { LocalRuntime } from "../local/demo-seed.js";
import {
  fail,
  isRecord,
  requireCsrf,
  resolveSession,
  type RouteSecurityContext,
} from "./auth-route-support.js";
import { safeErrorContext } from "./local-logger.js";

const ADMIN_PERMISSIONS = Object.freeze([
  "settings_admin",
  "staff_read",
  "staff_write",
  "order_write",
]);
const STAFF_PERMISSIONS = Object.freeze(["staff_read", "order_write"]);
const NO_PERMISSIONS = Object.freeze([] as string[]);
const INTERNAL_ONLY_COMMANDS: ReadonlySet<string> = new Set(["photo.register", "photo.delete"]);

function tenantFromSession(resolved: AuthorizedSession): TenantContext {
  return Object.freeze({
    orgId: resolved.session.org_id,
    storeId: resolved.session.store_id,
    staffId: resolved.session.staff_id,
  });
}

function actorFromSession(resolved: AuthorizedSession): ActorContext {
  const { session, authority } = resolved;
  return Object.freeze({
    staffId: session.staff_id,
    deviceId: session.device_id,
    via: "ui" as const,
    permissions:
      authority.role === "admin"
        ? ADMIN_PERMISSIONS
        : authority.role === "staff"
          ? STAFF_PERMISSIONS
          : NO_PERMISSIONS,
  });
}

function createBus(runtime: LocalRuntime) {
  return createRegisteredM1Bus({
    identity: runtime.identity,
    platform: runtime.platform,
    order: runtime.order,
    catalog: runtime.catalog,
    print: runtime.print,
    stats: runtime.stats,
    customer: runtime.customer,
    shift: runtime.shift,
    photo: runtime.photo,
    fulfillment: runtime.fulfillment,
  });
}

function routeName(params: unknown): string {
  if (!isRecord(params)) return "";
  return typeof params.name === "string" ? params.name : "";
}

function applyCommandErrorStatus(reply: FastifyReply, code: string): void {
  const authorizationOutcome =
    code === "POLICY_STEP_UP_REQUIRED" ||
    code === "POLICY_CONFIRMATION_REQUIRED" ||
    code === "POLICY_DENIED" ||
    code === "PERMISSION_DENIED";
  reply.code(authorizationOutcome ? 403 : 400);
}

function createSqlRunner(runtime: LocalRuntime) {
  const memorySql = new FakeSqlClient();
  return async <T>(operation: (sql: SqlClient) => Promise<T>): Promise<T> => {
    if (runtime.mode === "pg" && runtime.pool !== null) {
      return withPoolClient(runtime.pool, operation);
    }
    return operation(memorySql);
  };
}

type SqlRunner = ReturnType<typeof createSqlRunner>;

export async function executeTrustedSessionCommand(
  context: RouteSecurityContext,
  resolved: AuthorizedSession,
  name: string,
  input: Readonly<Record<string, unknown>>,
  options: Readonly<{ idempotencyKey?: string }> = {},
): Promise<CommandResult> {
  const { registry, chainHooks } = createBus(context.runtime);
  const runWithSql = createSqlRunner(context.runtime);
  return runWithSql((sql) =>
    executeCommand(sql, tenantFromSession(resolved), name, input, {
      registry,
      actor: actorFromSession(resolved),
      chainHooks,
      pendingStore: context.runtime.pendingStore,
      stepUpProofStore: context.runtime.stepUpProofStore,
      idempotencyStore: context.runtime.idempotencyStore,
      sessionBinding: Object.freeze({
        sessionId: resolved.session.session_id,
        sessionVersion: resolved.session.session_version,
      }),
      ...(options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey }),
    }),
  );
}

type RouteCommandPayload = Readonly<{
  input: Readonly<Record<string, unknown>>;
  version?: string;
  dryRun?: boolean;
  idempotencyKey?: string;
  confirmRef?: string;
}>;

/**
 * New callers use the branded A2 wire envelope. The direct-args fallback is
 * intentionally retained for already-installed local shells, but it cannot
 * opt into idempotency without the canonical envelope.
 */
function isBareConfirmation(
  body: Record<string, unknown>,
): body is Readonly<{ confirm_ref: string }> {
  const keys = Object.keys(body);
  return (
    keys.length === 1 &&
    keys[0] === "confirm_ref" &&
    typeof body.confirm_ref === "string" &&
    body.confirm_ref.length > 0
  );
}

function parseRouteCommandPayload(
  name: string,
  body: Record<string, unknown>,
): RouteCommandPayload | null {
  if (
    "command" in body ||
    "version" in body ||
    "idempotency_key" in body ||
    "mode" in body ||
    "dry_run" in body
  ) {
    try {
      const payload = parseCommandWirePayload(body);
      if (payload.command !== name) return null;
      if (payload.mode === "confirm") {
        return Object.freeze({
          input: Object.freeze({}),
          version: payload.version,
          dryRun: payload.dry_run,
          idempotencyKey: payload.idempotency_key,
          confirmRef: payload.confirm_ref,
        });
      }
      return Object.freeze({
        input: payload.args,
        version: payload.version,
        dryRun: payload.dry_run,
        idempotencyKey: payload.idempotency_key,
      });
    } catch {
      return null;
    }
  }
  // The direct-args client answers a confirmation with a bare { confirm_ref }
  // body — no envelope keys — so it never reaches the branded parse above. Left
  // as raw args it is validated against the command schema and fails, which
  // made every R3 confirmation unfinishable over HTTP.
  if (isBareConfirmation(body)) {
    return Object.freeze({ input: Object.freeze({}), confirmRef: body.confirm_ref });
  }
  return Object.freeze({ input: body });
}

async function executeCommandRoute(
  context: RouteSecurityContext,
  runWithSql: SqlRunner,
  resolved: AuthorizedSession,
  name: string,
  body: Record<string, unknown>,
) {
  const payload = parseRouteCommandPayload(name, body);
  if (payload === null) {
    return Object.freeze({
      ok: false,
      error: { code: "VALIDATION_FAILED", message: "Request validation failed" },
    }) as CommandResult;
  }
  const { registry, chainHooks } = createBus(context.runtime);
  return runWithSql((sql) =>
    executeCommand(sql, tenantFromSession(resolved), name, payload.input, {
      registry,
      actor: actorFromSession(resolved),
      chainHooks,
      pendingStore: context.runtime.pendingStore,
      stepUpProofStore: context.runtime.stepUpProofStore,
      idempotencyStore: context.runtime.idempotencyStore,
      sessionBinding: Object.freeze({
        sessionId: resolved.session.session_id,
        sessionVersion: resolved.session.session_version,
      }),
      ...(payload.version === undefined ? {} : { version: payload.version }),
      ...(payload.dryRun === undefined ? {} : { dryRun: payload.dryRun }),
      ...(payload.idempotencyKey === undefined ? {} : { idempotencyKey: payload.idempotencyKey }),
      ...(payload.confirmRef === undefined ? {} : { confirmRef: payload.confirmRef }),
    }),
  );
}

function registerCommandRoute(
  app: FastifyInstance,
  context: RouteSecurityContext,
  runWithSql: SqlRunner,
): void {
  app.post("/v1/commands/:name", async (request, reply) => {
    try {
      const resolved = await resolveSession(context.runtime, request);
      if (resolved === null) {
        reply.code(401);
        return fail("AUTHENTICATION_FAILED");
      }
      const csrf = await requireCsrf(context, request, reply, resolved.session);
      if (csrf !== true) return csrf;
      const name = routeName(request.params);
      if (name.length === 0) {
        reply.code(400);
        return fail("VALIDATION_FAILED");
      }
      if (INTERNAL_ONLY_COMMANDS.has(name)) {
        reply.code(404);
        return fail("RESOURCE_UNAVAILABLE");
      }
      const body = isRecord(request.body) ? request.body : {};
      const result = await executeCommandRoute(context, runWithSql, resolved, name, body);
      if (!result.ok) applyCommandErrorStatus(reply, result.error.code);
      return result;
    } catch (error) {
      request.log.error(safeErrorContext(error), "command request failed");
      reply.code(500);
      return fail("TRANSACTION_FAILED");
    }
  });
}

function registerQueryRoute(
  app: FastifyInstance,
  context: RouteSecurityContext,
  runWithSql: SqlRunner,
): void {
  app.post("/v1/queries/:name", async (request, reply) => {
    try {
      const resolved = await resolveSession(context.runtime, request);
      if (resolved === null) {
        reply.code(401);
        return fail("AUTHENTICATION_FAILED");
      }
      const name = routeName(request.params);
      if (name.length === 0) {
        reply.code(400);
        return fail("VALIDATION_FAILED");
      }
      const { queryRegistry } = createBus(context.runtime);
      const result = await runWithSql((sql) =>
        executeQuery(
          sql,
          tenantFromSession(resolved),
          name,
          isRecord(request.body) ? request.body : {},
          { registry: queryRegistry, actor: actorFromSession(resolved) },
        ),
      );
      if (!result.ok) reply.code(400);
      return result;
    } catch (error) {
      request.log.error(safeErrorContext(error), "query request failed");
      reply.code(500);
      return fail("TRANSACTION_FAILED");
    }
  });
}

export function registerBusRoutes(app: FastifyInstance, context: RouteSecurityContext): void {
  const runWithSql = createSqlRunner(context.runtime);
  registerCommandRoute(app, context, runWithSql);
  registerQueryRoute(app, context, runWithSql);
}

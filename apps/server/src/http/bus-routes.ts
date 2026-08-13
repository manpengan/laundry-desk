import type { FastifyInstance } from "fastify";

import {
  ConfirmReferenceSchema,
  AUTOMATION_COMMAND_NAMES,
  AUTOMATION_QUERY_NAMES,
  FACTORY_HANDOFF_COMMAND_NAMES,
  FACTORY_HANDOFF_QUERY_NAMES,
  IdempotencyKeySchema,
  parseCommandWirePayload,
} from "@laundry/contracts";

import type { AuthorizedSession } from "../auth/session-view.js";
import { executeCommand } from "../bus/executor.js";
import { createRuntimeBus } from "../bus/runtime.js";
import type { CommandResult } from "../bus/types.js";
import {
  fail,
  isRecord,
  requireCsrf,
  resolveSession,
  type RouteSecurityContext,
} from "./auth-route-support.js";
import {
  actorFromSession,
  applyCommandErrorStatus,
  createSqlRunner,
  executeTrustedSessionCommand,
  executeTrustedSessionQuery,
  tenantFromSession,
  type SqlRunner,
} from "./bus-route-execution.js";
import { safeErrorContext } from "./local-logger.js";
import {
  DELIVERY_COMMANDS,
  DELIVERY_QUERIES,
  MARKETING_COMMANDS,
  MARKETING_QUERIES,
  enforceMarketingOperationLimit,
} from "./bus-route-operation-limits.js";
import type { FactoryOperationRateLimiter } from "./factory-operation-rate-limit.js";
import type { DeliveryPolicyRateLimiter } from "./delivery-policy-rate-limit.js";
import type { MarketingOperationRateLimiter } from "./marketing-operation-rate-limit.js";
import type { NotificationCommandRateLimiter } from "./notification-command-rate-limit.js";
import { isRuntimeBusOperationAvailable } from "./runtime-surface-policy.js";

const INTERNAL_ONLY_COMMANDS: ReadonlySet<string> = new Set(["photo.register", "photo.delete"]);
const IDEMPOTENCY_HEADER_NAME = "idempotency-key";
const NOTIFICATION_ENQUEUE_COMMAND = "notification.delivery_batch.enqueue";
const FACTORY_COMMANDS: ReadonlySet<string> = new Set(FACTORY_HANDOFF_COMMAND_NAMES);
const FACTORY_QUERIES: ReadonlySet<string> = new Set(FACTORY_HANDOFF_QUERY_NAMES);
const AUTOMATION_COMMANDS: ReadonlySet<string> = new Set(AUTOMATION_COMMAND_NAMES);
const AUTOMATION_QUERIES: ReadonlySet<string> = new Set(AUTOMATION_QUERY_NAMES);

function routeName(params: unknown): string {
  if (!isRecord(params)) return "";
  return typeof params.name === "string" ? params.name : "";
}

export { applyCommandErrorStatus, executeTrustedSessionCommand };

type RouteCommandPayload = Readonly<{
  input: Readonly<Record<string, unknown>>;
  version?: string;
  dryRun?: boolean;
  idempotencyKey?: string;
  confirmRef?: string;
}>;

/**
 * New callers may use the branded A2 wire envelope. The direct-args fallback
 * remains for installed shells and binds its replay key through a validated
 * HTTP header so no idempotency metadata can collide with command arguments.
 */
function isBareConfirmation(
  body: Record<string, unknown>,
): body is Readonly<{ confirm_ref: string }> {
  const keys = Object.keys(body);
  return (
    keys.length === 1 &&
    keys[0] === "confirm_ref" &&
    typeof body.confirm_ref === "string" &&
    ConfirmReferenceSchema.safeParse(body.confirm_ref).success
  );
}

function parseRouteCommandPayload(
  name: string,
  body: Record<string, unknown>,
  headerIdempotencyKey: string | undefined,
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
      if (headerIdempotencyKey !== undefined && headerIdempotencyKey !== payload.idempotency_key) {
        return null;
      }
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
    return Object.freeze({
      input: Object.freeze({}),
      confirmRef: body.confirm_ref,
      ...(headerIdempotencyKey === undefined ? {} : { idempotencyKey: headerIdempotencyKey }),
    });
  }
  return Object.freeze({
    input: body,
    ...(headerIdempotencyKey === undefined ? {} : { idempotencyKey: headerIdempotencyKey }),
  });
}

function readIdempotencyHeader(
  value: string | readonly string[] | undefined,
): string | null | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !IdempotencyKeySchema.safeParse(value).success) return null;
  return value;
}

async function executeCommandRoute(
  context: RouteSecurityContext,
  runWithSql: SqlRunner,
  resolved: AuthorizedSession,
  name: string,
  body: Record<string, unknown>,
  headerIdempotencyKey: string | undefined,
  onUnexpectedError: (error: unknown) => void,
) {
  const payload = parseRouteCommandPayload(name, body, headerIdempotencyKey);
  if (payload === null) {
    return Object.freeze({
      ok: false,
      error: { code: "VALIDATION_FAILED", message: "Request validation failed" },
    }) as CommandResult;
  }
  const { registry, chainHooks } = createRuntimeBus(context.runtime);
  return runWithSql((sql) =>
    executeCommand(sql, tenantFromSession(resolved), name, payload.input, {
      registry,
      actor: actorFromSession(resolved),
      chainHooks,
      pendingStore: context.runtime.pendingStore,
      stepUpProofStore: context.runtime.stepUpProofStore,
      stepUpApproverAuthority: context.runtime.stepUpApproverAuthority,
      idempotencyStore: context.runtime.idempotencyStore,
      onUnexpectedError,
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
  notificationLimiter: NotificationCommandRateLimiter,
  factoryLimiter: FactoryOperationRateLimiter,
  deliveryLimiter: DeliveryPolicyRateLimiter,
  marketingLimiter: MarketingOperationRateLimiter,
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
      if (!isRuntimeBusOperationAvailable(resolved, "command", name)) {
        reply.code(404);
        return fail("RESOURCE_UNAVAILABLE");
      }
      if (MARKETING_COMMANDS.has(name)) {
        const limited = enforceMarketingOperationLimit(
          marketingLimiter,
          "command",
          resolved,
          reply,
        );
        if (limited !== null) return limited;
      }
      if (FACTORY_COMMANDS.has(name) || AUTOMATION_COMMANDS.has(name)) {
        const decision = factoryLimiter.check(
          "command",
          resolved.session.session_id,
          resolved.session.org_id,
          resolved.session.store_id,
        );
        if (!decision.allowed) {
          reply.header("Retry-After", String(decision.retryAfterSeconds));
          reply.code(429);
          return fail("RATE_LIMITED");
        }
      }
      if (DELIVERY_COMMANDS.has(name)) {
        const decision = deliveryLimiter.check(
          "command",
          resolved.session.session_id,
          resolved.session.org_id,
          resolved.session.store_id,
        );
        if (!decision.allowed) {
          reply.header("Retry-After", String(decision.retryAfterSeconds));
          reply.code(429);
          return fail("RATE_LIMITED");
        }
      }
      if (!isRecord(request.body)) {
        reply.code(400);
        return fail("VALIDATION_FAILED");
      }
      const headerIdempotencyKey = readIdempotencyHeader(request.headers[IDEMPOTENCY_HEADER_NAME]);
      if (headerIdempotencyKey === null) {
        reply.code(400);
        return fail("VALIDATION_FAILED");
      }
      if (name === NOTIFICATION_ENQUEUE_COMMAND) {
        const decision = notificationLimiter.check(
          resolved.session.session_id,
          resolved.session.org_id,
          resolved.session.store_id,
        );
        if (!decision.allowed) {
          reply.header("Retry-After", String(decision.retryAfterSeconds));
          reply.code(429);
          return fail("RATE_LIMITED");
        }
      }
      const body = request.body;
      const result = await executeCommandRoute(
        context,
        runWithSql,
        resolved,
        name,
        body,
        headerIdempotencyKey,
        (error) => request.log.error(safeErrorContext(error), "command execution failed"),
      );
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
  factoryLimiter: FactoryOperationRateLimiter,
  deliveryLimiter: DeliveryPolicyRateLimiter,
  marketingLimiter: MarketingOperationRateLimiter,
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
      if (!isRuntimeBusOperationAvailable(resolved, "query", name)) {
        reply.code(404);
        return fail("RESOURCE_UNAVAILABLE");
      }
      if (MARKETING_QUERIES.has(name)) {
        const limited = enforceMarketingOperationLimit(marketingLimiter, "query", resolved, reply);
        if (limited !== null) return limited;
      }
      if (FACTORY_QUERIES.has(name) || AUTOMATION_QUERIES.has(name)) {
        const decision = factoryLimiter.check(
          "query",
          resolved.session.session_id,
          resolved.session.org_id,
          resolved.session.store_id,
        );
        if (!decision.allowed) {
          reply.header("Retry-After", String(decision.retryAfterSeconds));
          reply.code(429);
          return fail("RATE_LIMITED");
        }
      }
      if (DELIVERY_QUERIES.has(name)) {
        const decision = deliveryLimiter.check(
          "query",
          resolved.session.session_id,
          resolved.session.org_id,
          resolved.session.store_id,
        );
        if (!decision.allowed) {
          reply.header("Retry-After", String(decision.retryAfterSeconds));
          reply.code(429);
          return fail("RATE_LIMITED");
        }
      }
      if (!isRecord(request.body)) {
        reply.code(400);
        return fail("VALIDATION_FAILED");
      }
      const result = await executeTrustedSessionQuery(
        context.runtime,
        resolved,
        name,
        request.body,
        (error) => request.log.error(safeErrorContext(error), "query execution failed"),
      );
      if (!result.ok) applyCommandErrorStatus(reply, result.error.code);
      return result;
    } catch (error) {
      request.log.error(safeErrorContext(error), "query request failed");
      reply.code(500);
      return fail("TRANSACTION_FAILED");
    }
  });
}

export function registerBusRoutes(
  app: FastifyInstance,
  context: RouteSecurityContext,
  notificationLimiter: NotificationCommandRateLimiter,
  factoryLimiter: FactoryOperationRateLimiter,
  deliveryLimiter: DeliveryPolicyRateLimiter,
  marketingLimiter: MarketingOperationRateLimiter,
): void {
  const runWithSql = createSqlRunner(context.runtime);
  registerCommandRoute(
    app,
    context,
    runWithSql,
    notificationLimiter,
    factoryLimiter,
    deliveryLimiter,
    marketingLimiter,
  );
  registerQueryRoute(app, context, runWithSql, factoryLimiter, deliveryLimiter, marketingLimiter);
}

/**
 * Fastify app factory for local web-server testing (memory identity + M1 bus).
 *
 * Auth lifecycle routes call C6 services (A5 lifecycle_http ingress).
 * Business commands go through C1 bus only.
 */

import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";

import { createCommandError, CSRF_HEADER_NAME, type CommandErrorCode } from "@laundry/contracts";
import { z } from "zod";

import {
  createAiService,
  createMemoryAiCredentialStore,
  createOpenAiCompatibleProvider,
  createPgAiCredentialStore,
  type AiProvider,
  type AiService,
  type KekProvider,
  writeAiEventStream,
} from "../ai/index.js";
import { executeCommand } from "../bus/executor.js";
import { executeQuery } from "../bus/execute-query.js";
import type { ActorContext } from "../bus/types.js";
import { FakeSqlClient } from "../db/fake-client.js";
import { withPoolClient } from "../db/pg-sql-client.js";
import { withTenantTransaction } from "../db/tenant-transaction.js";
import type { SqlClient, TenantContext } from "../db/types.js";
import { createRegisteredM1Bus } from "../handlers/register-m1.js";
import { createAccessTokenSigner } from "../identity/crypto-util.js";
import { loginWithPassword } from "../identity/login.js";
import { logoutSession, rotateRefresh } from "../identity/session.js";
import type { SessionIssueResult, SessionRecord } from "../identity/types.js";
import { IdentityError } from "../identity/types.js";
import type { LocalRuntime } from "../local/demo-seed.js";
import {
  csrfCookieOptions,
  refreshCookieOptions,
  resolveCookiePolicy,
  type CookiePolicy,
} from "./cookie-policy.js";
import { registerPinRoutes } from "./pin-routes.js";

export type CreateAppOptions = Readonly<{
  runtime: LocalRuntime;
  corsOrigin?: string | readonly string[];
  /** Override cookie Secure / __Host- policy (tests force non-secure). */
  cookiePolicy?: CookiePolicy;
  /** Optional BYOK runtime; absent means hard fail-closed until KMS/secret-store wiring exists. */
  aiService?: AiService;
  /** KMS/OS-secret backed KEK injected by the trusted server bootstrap; never an HTTP value. */
  aiKekProvider?: KekProvider;
  /** Injectable official-provider adapter (tests/bootstrap). */
  aiProvider?: AiProvider;
}>;

const AiCredentialCreateSchema = z.strictObject({
  provider: z.literal("openai"),
  api_key: z.string().min(1).max(8_192),
});
const AiChatSchema = z.strictObject({
  credential_id: z.uuid(),
  preset: z.enum(["business_readonly", "counter_readonly", "procedure_help"]),
  message: z.string().min(1).max(4_000),
});
const AiCredentialParamsSchema = z.strictObject({ credentialId: z.uuid() });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readBearer(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (typeof header !== "string") return null;
  const match = /^Bearer\s+(\S+)$/iu.exec(header.trim());
  return match?.[1] ?? null;
}

function fail(code: CommandErrorCode) {
  return Object.freeze({
    ok: false as const,
    error: createCommandError(code),
  });
}

function setAuthCookies(
  reply: FastifyReply,
  policy: CookiePolicy,
  refreshSecret: string,
  csrfToken: string,
): void {
  reply.setCookie(policy.refreshName, refreshSecret, { ...refreshCookieOptions(policy) });
  reply.setCookie(policy.csrfName, csrfToken, { ...csrfCookieOptions(policy) });
}

function clearAuthCookies(reply: FastifyReply, policy: CookiePolicy): void {
  reply.clearCookie(policy.refreshName, { path: policy.path });
  reply.clearCookie(policy.csrfName, { path: policy.path });
}

function publicAccessBody(issued: SessionIssueResult) {
  return Object.freeze({
    access_token: issued.access_token,
    token_type: issued.token_type,
    expires_in: issued.expires_in,
    storage: issued.storage,
    session: issued.session,
  });
}

function tenantFromSession(session: SessionRecord): TenantContext {
  return Object.freeze({
    orgId: session.org_id,
    storeId: session.store_id,
    staffId: session.staff_id,
  });
}

function actorFromSession(session: SessionRecord): ActorContext {
  const isAdmin = session.staff_id.endsWith("111103") || session.staff_id.includes("103");
  return Object.freeze({
    staffId: session.staff_id,
    deviceId: session.device_id,
    via: "ui" as const,
    // order_write: M2 counter receive/pickup (UI + local HTTP).
    permissions: isAdmin
      ? Object.freeze(["settings_admin", "staff_read", "staff_write", "order_write"])
      : Object.freeze(["staff_read", "order_write"]),
  });
}

function aiActorFromSession(session: SessionRecord): ActorContext {
  return Object.freeze({
    ...actorFromSession(session),
    via: "ai" as const,
    riskCap: "R2" as const,
  });
}

async function resolveSession(
  runtime: LocalRuntime,
  token: string | null,
): Promise<SessionRecord | null> {
  if (token === null || token.length === 0) return null;
  const signer = createAccessTokenSigner(runtime.accessTokenSecret);
  const claims = signer.verify(token);
  if (claims === null) return null;
  const session = await runtime.identity.sessions.sessions.get(claims.session_id);
  if (session === null || session.status !== "active") return null;
  if (session.session_version !== claims.session_version) return null;
  return session;
}

function mapIdentityHttpError(error: unknown, reply: FastifyReply) {
  if (error instanceof IdentityError) {
    if (error.code === "AUTHENTICATION_FAILED" || error.code === "SESSION_INVALID") {
      reply.code(401);
      return fail("AUTHENTICATION_FAILED");
    }
    if (error.code === "CSRF_REJECTED") {
      reply.code(403);
      return fail("CSRF_REJECTED");
    }
    if (error.code === "PIN_LOCKED") {
      reply.code(429);
      return fail("RATE_LIMITED");
    }
    if (error.code === "PIN_CHALLENGE_INVALID") {
      reply.code(400);
      return fail("RESOURCE_UNAVAILABLE");
    }
  }
  reply.code(500);
  return fail("TRANSACTION_FAILED");
}

function requireCsrf(
  request: FastifyRequest,
  reply: FastifyReply,
  policy: CookiePolicy,
): true | ReturnType<typeof fail> {
  const header = request.headers[CSRF_HEADER_NAME.toLowerCase()];
  const cookieVal = request.cookies[policy.csrfName];
  if (typeof header !== "string" || header.length === 0 || header !== cookieVal) {
    reply.code(403);
    return fail("CSRF_REJECTED");
  }
  return true;
}

function parseBody<T>(schema: z.ZodType<T>, body: unknown): T | null {
  const parsed = schema.safeParse(body);
  return parsed.success ? parsed.data : null;
}

function canManageAiCredentials(actor: ActorContext): boolean {
  return actor.permissions?.includes("settings_admin") ?? false;
}

/** Build a fully configured Fastify instance (no listen). Prefer inject() in tests. */
export async function createLocalApp(options: CreateAppOptions): Promise<FastifyInstance> {
  const { runtime } = options;
  const cookiePolicy = options.cookiePolicy ?? resolveCookiePolicy();
  const corsOriginList: string[] = Array.isArray(options.corsOrigin)
    ? [...options.corsOrigin]
    : typeof options.corsOrigin === "string"
      ? [options.corsOrigin]
      : ["http://127.0.0.1:5173", "http://localhost:5173"];

  const app = Fastify({ logger: false });
  await app.register(cors, {
    origin: corsOriginList,
    credentials: true,
  });
  await app.register(cookie);

  const memorySql = new FakeSqlClient();
  const runWithSql = async <T>(fn: (sql: SqlClient) => Promise<T>): Promise<T> => {
    if (runtime.mode === "pg") {
      if (runtime.pool === null) throw new Error("PostgreSQL runtime pool is required");
      return withPoolClient(runtime.pool, (sql) => fn(sql));
    }
    return fn(memorySql);
  };
  const aiCredentialStore =
    runtime.mode === "pg"
      ? createPgAiCredentialStore((tenant, operation) =>
          runWithSql((sql) => withTenantTransaction(sql, tenant, operation)),
        )
      : createMemoryAiCredentialStore();
  const aiService =
    options.aiService ??
    createAiService({
      credentialStore: aiCredentialStore,
      kekProvider: options.aiKekProvider ?? null,
      provider: options.aiProvider ?? createOpenAiCompatibleProvider(),
    });

  app.get("/health", async () =>
    Object.freeze({
      ok: true as const,
      data: Object.freeze({
        service: "@laundry/server",
        mode: runtime.mode === "pg" ? "local-pg" : "local-memory",
        platform: runtime.platform.persistence === "sql" ? "sql" : "memory",
        cookies: cookiePolicy.secure ? "host-secure" : "local-http",
        at: Date.now(),
      }),
    }),
  );

  app.get("/api/v2/local/staff", async () =>
    Object.freeze({ ok: true as const, data: runtime.staffDirectory }),
  );

  app.post("/api/v2/auth/login", async (request, reply) => {
    try {
      const issued = await loginWithPassword(runtime.identity.login, request.body);
      setAuthCookies(reply, cookiePolicy, issued.refresh.refresh_token, issued.csrf.csrf_token);
      return Object.freeze({ ok: true as const, data: publicAccessBody(issued) });
    } catch (error) {
      return mapIdentityHttpError(error, reply);
    }
  });

  app.post("/api/v2/auth/refresh", async (request, reply) => {
    const refreshSecret = request.cookies[cookiePolicy.refreshName];
    if (typeof refreshSecret !== "string" || refreshSecret.length === 0) {
      reply.code(401);
      return fail("AUTHENTICATION_FAILED");
    }
    try {
      const issued = await rotateRefresh(runtime.identity.sessions, refreshSecret);
      setAuthCookies(reply, cookiePolicy, issued.refresh.refresh_token, issued.csrf.csrf_token);
      return Object.freeze({ ok: true as const, data: publicAccessBody(issued) });
    } catch (error) {
      clearAuthCookies(reply, cookiePolicy);
      return mapIdentityHttpError(error, reply);
    }
  });

  app.post("/api/v2/auth/logout", async (request, reply) => {
    const accessToken = readBearer(request);
    const session = await resolveSession(runtime, accessToken);
    try {
      if (session !== null) {
        await logoutSession(runtime.identity.sessions, {
          session_id: session.session_id,
          family_id: session.family_id,
          session_version: session.session_version,
        });
      }
    } catch {
      // still clear cookies
    }
    clearAuthCookies(reply, cookiePolicy);
    return Object.freeze({ ok: true as const, data: Object.freeze({ logged_out: true as const }) });
  });

  registerPinRoutes(app, {
    runtime,
    cookiePolicy,
    readBearer,
    resolveSession,
    requireCsrf,
    mapIdentityHttpError,
    setAuthCookies,
    publicAccessBody,
    isRecord,
    fail,
  });

  app.post("/v1/commands/:name", async (request, reply) => {
    const session = await resolveSession(runtime, readBearer(request));
    if (session === null) {
      reply.code(401);
      return fail("AUTHENTICATION_FAILED");
    }
    const params = request.params as { name?: string };
    const name = typeof params.name === "string" ? params.name : "";
    if (name.length === 0) {
      reply.code(400);
      return fail("VALIDATION_FAILED");
    }
    const body = isRecord(request.body) ? request.body : {};
    // Confirm / step-up second hop: body may be { confirm_ref } only (WYSIWYS).
    const confirmRef =
      typeof body.confirm_ref === "string" && body.confirm_ref.length > 0
        ? body.confirm_ref
        : undefined;
    const input = confirmRef !== undefined ? Object.freeze({}) : body;
    const { registry, chainHooks } = createRegisteredM1Bus({
      identity: runtime.identity,
      platform: runtime.platform,
      order: runtime.order,
      catalog: runtime.catalog,
      print: runtime.print,
      stats: runtime.stats,
      customer: runtime.customer,
      shift: runtime.shift,
      photo: runtime.photo,
    });
    const tenant = tenantFromSession(session);
    const actor = actorFromSession(session);
    const result = await runWithSql((sql) =>
      executeCommand(sql, tenant, name, input, {
        registry,
        actor,
        chainHooks,
        pendingStore: runtime.pendingStore,
        stepUpProofStore: runtime.stepUpProofStore,
        ...(confirmRef !== undefined ? { confirmRef } : {}),
      }),
    );

    if (!result.ok) {
      // Policy gates are authorization outcomes, not bad requests.
      if (
        result.error.code === "POLICY_STEP_UP_REQUIRED" ||
        result.error.code === "POLICY_CONFIRMATION_REQUIRED" ||
        result.error.code === "POLICY_DENIED" ||
        result.error.code === "PERMISSION_DENIED"
      ) {
        reply.code(403);
      } else {
        reply.code(400);
      }
    }
    return result;
  });

  app.post("/v1/queries/:name", async (request, reply) => {
    const session = await resolveSession(runtime, readBearer(request));
    if (session === null) {
      reply.code(401);
      return fail("AUTHENTICATION_FAILED");
    }
    const params = request.params as { name?: string };
    const name = typeof params.name === "string" ? params.name : "";
    if (name.length === 0) {
      reply.code(400);
      return fail("VALIDATION_FAILED");
    }
    const body = isRecord(request.body) ? request.body : {};
    const { queryRegistry } = createRegisteredM1Bus({
      identity: runtime.identity,
      platform: runtime.platform,
      order: runtime.order,
      catalog: runtime.catalog,
      print: runtime.print,
      stats: runtime.stats,
      customer: runtime.customer,
      shift: runtime.shift,
      photo: runtime.photo,
    });
    const tenant = tenantFromSession(session);
    const actor = actorFromSession(session);
    const result = await runWithSql((sql) =>
      executeQuery(sql, tenant, name, body, {
        registry: queryRegistry,
        actor,
      }),
    );

    if (!result.ok) {
      reply.code(400);
    }
    return result;
  });

  app.get("/api/v2/ai/credentials", async (request, reply) => {
    const session = await resolveSession(runtime, readBearer(request));
    if (session === null) {
      reply.code(401);
      return fail("AUTHENTICATION_FAILED");
    }
    const actor = actorFromSession(session);
    if (!canManageAiCredentials(actor)) {
      reply.code(403);
      return fail("PERMISSION_DENIED");
    }
    return Object.freeze({
      ok: true as const,
      data: await aiService.listCredentials(tenantFromSession(session)),
    });
  });

  app.post("/api/v2/ai/credentials", async (request, reply) => {
    const session = await resolveSession(runtime, readBearer(request));
    if (session === null) {
      reply.code(401);
      return fail("AUTHENTICATION_FAILED");
    }
    const actor = actorFromSession(session);
    if (!canManageAiCredentials(actor)) {
      reply.code(403);
      return fail("PERMISSION_DENIED");
    }
    if (requireCsrf(request, reply, cookiePolicy) !== true) return fail("CSRF_REJECTED");
    const body = parseBody(AiCredentialCreateSchema, request.body);
    if (body === null || !aiService.isConfigured()) {
      reply.code(body === null ? 400 : 503);
      return fail(body === null ? "VALIDATION_FAILED" : "RESOURCE_UNAVAILABLE");
    }
    const credential = await aiService.saveCredential(tenantFromSession(session), body);
    if (credential === null) {
      reply.code(503);
      return fail("RESOURCE_UNAVAILABLE");
    }
    return Object.freeze({ ok: true as const, data: credential });
  });

  app.post("/api/v2/ai/credentials/:credentialId/verify", async (request, reply) => {
    const session = await resolveSession(runtime, readBearer(request));
    if (session === null) {
      reply.code(401);
      return fail("AUTHENTICATION_FAILED");
    }
    const actor = actorFromSession(session);
    if (!canManageAiCredentials(actor)) {
      reply.code(403);
      return fail("PERMISSION_DENIED");
    }
    if (requireCsrf(request, reply, cookiePolicy) !== true) return fail("CSRF_REJECTED");
    const params = parseBody(AiCredentialParamsSchema, request.params);
    if (params === null || !aiService.isConfigured()) {
      reply.code(params === null ? 400 : 503);
      return fail(params === null ? "VALIDATION_FAILED" : "RESOURCE_UNAVAILABLE");
    }
    const result = await aiService.verifyCredential(
      tenantFromSession(session),
      params.credentialId,
    );
    if (!result.found) {
      reply.code(404);
      return fail("RESOURCE_UNAVAILABLE");
    }
    return Object.freeze({ ok: true as const, data: Object.freeze({ verified: result.verified }) });
  });

  app.post("/api/v2/ai/chat", async (request, reply) => {
    const session = await resolveSession(runtime, readBearer(request));
    if (session === null) {
      reply.code(401);
      return fail("AUTHENTICATION_FAILED");
    }
    const body = parseBody(AiChatSchema, request.body);
    if (body === null || !aiService.isConfigured()) {
      reply.code(body === null ? 400 : 503);
      return fail(body === null ? "VALIDATION_FAILED" : "RESOURCE_UNAVAILABLE");
    }
    const tenant = tenantFromSession(session);
    const actor = aiActorFromSession(session);
    const { queryRegistry } = createRegisteredM1Bus({
      identity: runtime.identity,
      platform: runtime.platform,
      order: runtime.order,
      catalog: runtime.catalog,
      print: runtime.print,
      stats: runtime.stats,
      customer: runtime.customer,
      shift: runtime.shift,
      photo: runtime.photo,
    });
    const events = aiService.stream({
      tenant,
      actor,
      credential_id: body.credential_id,
      preset: body.preset,
      message: body.message,
      executeQuery: async ({ name, input }) => {
        const result = await runWithSql((sql) =>
          executeQuery(sql, tenant, name, input, { registry: queryRegistry, actor }),
        );
        if (!result.ok) throw new Error("AI query unavailable");
        return result.data.result;
      },
    });
    await writeAiEventStream(reply, events);
    return reply;
  });

  return app;
}

/**
 * Local Fastify composition root. Route behavior lives in focused auth and bus modules.
 */

import { randomBytes } from "node:crypto";

import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";

import type { LocalRuntime } from "../local/demo-seed.js";
import { registerAuthRoutes } from "./auth-routes.js";
import type { AuthRouteContext, RouteSecurityContext } from "./auth-route-support.js";
import { registerBusRoutes } from "./bus-routes.js";
import { registerEdgeAuthorityRoute } from "./edge-authority-route.js";
import {
  createDeliveryPolicyRateLimiter,
  type DeliveryPolicyRateLimiter,
} from "./delivery-policy-rate-limit.js";
import { registerEdgeReplayRoute } from "./edge-replay-route.js";
import {
  createFactoryOperationRateLimiter,
  type FactoryOperationRateLimiter,
} from "./factory-operation-rate-limit.js";
import { registerEdgePrintRoute } from "./edge-print-route.js";
import { createEdgePrintRateLimiter, type EdgePrintRateLimiter } from "./edge-print-rate-limit.js";
import { registerPhotoFileRoutes } from "./photo-file-routes.js";
import { registerPrintArtifactRoutes } from "./print-artifact-routes.js";
import type { FileSpool } from "../print/file-spool.js";
import type { CookiePolicy } from "./cookie-policy.js";
import { installPublicErrorHandlers } from "./error-policy.js";
import { createLocalLoggerOptions } from "./local-logger.js";
import { createLoginRateLimiter, type LoginRateLimiter } from "./login-rate-limit.js";
import {
  createNotificationCommandRateLimiter,
  type NotificationCommandRateLimiter,
} from "./notification-command-rate-limit.js";
import {
  registerRequestSecurityHooks,
  type LocalRequestSecurityPolicy,
} from "./request-security.js";
import { createSecurityEventSink, type SecurityEventSink } from "./security-events.js";
import { LOCAL_PROFILE } from "../local/profile.js";
import type { PendingActionStore } from "../pending-actions/types.js";

export type CreateAppOptions = Readonly<{
  runtime: LocalRuntime;
  /** Required at the composition root; never inferred from NODE_ENV. */
  cookiePolicy: CookiePolicy;
  hostAuthorities?: readonly string[];
  browserOrigin?: string;
  browserFetchSite?: "same-site" | "same-origin";
  desktopOrigin?: string;
  /** Deterministic limiter injection for focused tests. */
  loginRateLimiter?: LoginRateLimiter;
  /** Dedicated main-process print transport limiter. */
  edgePrintRateLimiter?: EdgePrintRateLimiter;
  /** Dedicated automatic-notification command limiter. */
  notificationCommandRateLimiter?: NotificationCommandRateLimiter;
  /** Dedicated factory handoff command/query limiter. */
  factoryOperationRateLimiter?: FactoryOperationRateLimiter;
  /** Dedicated delivery policy command/query limiter. */
  deliveryPolicyRateLimiter?: DeliveryPolicyRateLimiter;
  /** Mock print spool; when absent the artifact download route is not mounted. */
  printSpool?: FileSpool;
  /** Structured redacted auth-security events (tests may capture). */
  securityEventSink?: SecurityEventSink;
  /** Tests may silence request logs; runtime defaults to the redacted structured logger. */
  logger?: false;
}>;

const DEFAULT_HOST_AUTHORITIES = Object.freeze(["127.0.0.1:8787"]);
const DEFAULT_BROWSER_ORIGIN = "http://127.0.0.1:5173";
const DEFAULT_DESKTOP_ORIGIN = "http://127.0.0.1:8787";
const PENDING_ACTION_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

function installPendingActionCleanup(app: FastifyInstance, store: PendingActionStore): void {
  const tenant = Object.freeze({
    orgId: LOCAL_PROFILE.orgId,
    storeId: LOCAL_PROFILE.storeId,
    staffId: LOCAL_PROFILE.adminStaffId,
  });
  const prune =
    store.pruneExpiredGlobally !== undefined
      ? () => store.pruneExpiredGlobally?.() ?? 0
      : store.pruneExpired === undefined
        ? undefined
        : () => store.pruneExpired?.(Math.floor(Date.now() / 1000), { tenant }) ?? 0;
  if (prune === undefined) return;

  let timer: NodeJS.Timeout | null = null;
  app.addHook("onReady", async () => {
    await prune();
    timer = setInterval(() => {
      void Promise.resolve(prune()).catch((error: unknown) => {
        app.log.error(
          { error_type: error instanceof Error ? error.name : typeof error },
          "pending action cleanup failed",
        );
      });
    }, PENDING_ACTION_CLEANUP_INTERVAL_MS);
    timer.unref();
  });
  app.addHook("onClose", async () => {
    if (timer !== null) clearInterval(timer);
    timer = null;
  });
}

function createFastifyApp(options: CreateAppOptions): FastifyInstance {
  return Fastify({
    logger: options.logger === false ? false : createLocalLoggerOptions(),
    trustProxy: false,
  });
}

async function installCoreHttp(
  app: FastifyInstance,
  options: CreateAppOptions,
): Promise<LocalRequestSecurityPolicy> {
  const requestSecurity = registerRequestSecurityHooks(app, {
    allowedHosts: options.hostAuthorities ?? DEFAULT_HOST_AUTHORITIES,
    browserOrigin: options.browserOrigin ?? DEFAULT_BROWSER_ORIGIN,
    browserFetchSite: options.browserFetchSite ?? "same-site",
    desktopOrigin: options.desktopOrigin ?? DEFAULT_DESKTOP_ORIGIN,
  });
  await app.register(cors, {
    origin: requestSecurity.corsOrigin,
    credentials: true,
  });
  await app.register(cookie);
  app.addHook("onSend", async (request, reply, payload) => {
    if (
      request.url.startsWith("/api/v2/auth/") ||
      request.url.startsWith("/api/v2/local/staff") ||
      request.url.startsWith("/api/v2/edge/authority") ||
      request.url.startsWith("/api/v2/edge/print/") ||
      request.url.startsWith("/v1/commands/") ||
      request.url.startsWith("/v1/queries/")
    ) {
      reply.header("Cache-Control", "no-store");
    }
    return payload;
  });
  installPublicErrorHandlers(app);
  app.get("/health", async () =>
    Object.freeze({
      ok: true as const,
      data: Object.freeze({ status: "ready" as const }),
    }),
  );
  return requestSecurity;
}

function createRouteContext(
  options: CreateAppOptions,
  requestSecurity: LocalRequestSecurityPolicy,
): AuthRouteContext {
  const base = Object.freeze({
    runtime: options.runtime,
    cookiePolicy: options.cookiePolicy,
    requestSecurity,
    securityEvents: options.securityEventSink ?? createSecurityEventSink(randomBytes(32)),
  }) satisfies RouteSecurityContext;
  return Object.freeze({
    ...base,
    loginRateLimiter: options.loginRateLimiter ?? createLoginRateLimiter(),
  });
}

/** Build a fully configured Fastify instance (no listen). Prefer inject() in tests. */
export async function createLocalApp(options: CreateAppOptions): Promise<FastifyInstance> {
  const app = createFastifyApp(options);
  const requestSecurity = await installCoreHttp(app, options);
  const context = createRouteContext(options, requestSecurity);
  installPendingActionCleanup(app, options.runtime.pendingStore);
  registerAuthRoutes(app, context);
  registerBusRoutes(
    app,
    context,
    options.notificationCommandRateLimiter ?? createNotificationCommandRateLimiter(),
    options.factoryOperationRateLimiter ?? createFactoryOperationRateLimiter(),
    options.deliveryPolicyRateLimiter ?? createDeliveryPolicyRateLimiter(),
  );
  registerEdgeAuthorityRoute(app, context);
  registerEdgeReplayRoute(app, context);
  registerEdgePrintRoute(
    app,
    context,
    options.edgePrintRateLimiter ?? createEdgePrintRateLimiter(),
  );
  registerPhotoFileRoutes(app, context, options.runtime.photo);

  // Artifact download only exists when a spool is configured; the memory
  // runtime has nothing on disk to serve.
  // main.ts does not pass a spool; the runtime carries the configured one.
  const spool = options.printSpool ?? options.runtime.print.spool;
  const findArtifact = options.runtime.print.store.findArtifact;
  if (spool !== undefined && findArtifact !== undefined) {
    registerPrintArtifactRoutes(app, context, {
      spool,
      lookup: Object.freeze({
        // The store is already tenant-scoped; the route passes the session
        // tenant so a future multi-store store cannot be addressed cross-tenant.
        find: async (_orgId: string, _storeId: string, jobId: string) => {
          const artifact = await findArtifact(jobId);
          return artifact === null
            ? null
            : Object.freeze({ artifact_path: artifact.path, artifact_sha256: artifact.sha256 });
        },
      }),
    });
  }
  return app;
}

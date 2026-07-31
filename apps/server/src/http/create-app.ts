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
import { registerEdgeReplayRoute } from "./edge-replay-route.js";
import { registerPhotoFileRoutes } from "./photo-file-routes.js";
import { registerPrintArtifactRoutes } from "./print-artifact-routes.js";
import type { FileSpool } from "../print/file-spool.js";
import type { CookiePolicy } from "./cookie-policy.js";
import { installPublicErrorHandlers } from "./error-policy.js";
import { createLocalLoggerOptions } from "./local-logger.js";
import { createLoginRateLimiter, type LoginRateLimiter } from "./login-rate-limit.js";
import {
  registerRequestSecurityHooks,
  type LocalRequestSecurityPolicy,
} from "./request-security.js";
import { createSecurityEventSink, type SecurityEventSink } from "./security-events.js";

export type CreateAppOptions = Readonly<{
  runtime: LocalRuntime;
  /** Required at the composition root; never inferred from NODE_ENV. */
  cookiePolicy: CookiePolicy;
  hostAuthorities?: readonly string[];
  browserOrigin?: string;
  desktopOrigin?: string;
  /** Deterministic limiter injection for focused tests. */
  loginRateLimiter?: LoginRateLimiter;
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
      request.url.startsWith("/api/v2/edge/authority")
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
  registerAuthRoutes(app, context);
  registerBusRoutes(app, context);
  registerEdgeAuthorityRoute(app, context);
  registerEdgeReplayRoute(app, context);
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

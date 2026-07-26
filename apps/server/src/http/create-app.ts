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
import { resolveCookiePolicy, type CookiePolicy } from "./cookie-policy.js";
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
  hostAuthorities?: readonly string[];
  browserOrigin?: string;
  desktopOrigin?: string;
  /** Override cookie Secure / __Host- policy (tests force non-secure). */
  cookiePolicy?: CookiePolicy;
  /** Deterministic limiter injection for focused tests. */
  loginRateLimiter?: LoginRateLimiter;
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
    if (request.url.startsWith("/api/v2/auth/")) {
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
    cookiePolicy: options.cookiePolicy ?? resolveCookiePolicy(),
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
  return app;
}

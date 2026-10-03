import type { FastifyInstance } from "fastify";
import { ZodError } from "zod";
import {
  NotificationProviderSettingsRequestSchema,
  NotificationProviderSettingsViewSchema,
} from "@laundry/contracts";
import {
  createNotificationSettingsService,
  NotificationSettingsError,
} from "../notification/providers/settings-store.js";
import { fail, requireCsrf, resolveSession, type AuthRouteContext } from "./auth-route-support.js";
import { createByokMutationRateLimiter } from "./byok-rate-limit.js";
import { safeErrorContext } from "./local-logger.js";

export function registerNotificationSettingsRoutes(
  app: FastifyInstance,
  context: AuthRouteContext,
): void {
  const settings = context.runtime.notification.externalSettings;
  if (settings === undefined) return;
  const service = createNotificationSettingsService(
    context.runtime,
    settings.kms,
    settings.reload,
    settings.tenant,
  );
  const limiter = createByokMutationRateLimiter({ maxAttempts: 5, windowSeconds: 60 });
  for (const method of ["GET", "POST"] as const)
    app.route({
      method,
      url: "/api/v2/notification/provider-settings",
      bodyLimit: 4096,
      async handler(request, reply) {
        try {
          const auth = await resolveSession(context.runtime, request);
          if (auth === null) {
            reply.code(401);
            return fail("AUTHENTICATION_FAILED");
          }
          if (auth.authority.role !== "admin") {
            reply.code(403);
            return fail("PERMISSION_DENIED");
          }
          const rate = limiter.consume(auth.session.staff_id);
          if (!rate.allowed) {
            reply.code(429).header("Retry-After", String(rate.retryAfterSeconds));
            return fail("RATE_LIMITED");
          }
          if (method === "POST") {
            const csrf = await requireCsrf(context, request, reply, auth.session);
            if (csrf !== true) return csrf;
            const input = NotificationProviderSettingsRequestSchema.parse(request.body);
            return {
              ok: true,
              data: NotificationProviderSettingsViewSchema.parse(await service.save(auth, input)),
            };
          }
          return {
            ok: true,
            data: NotificationProviderSettingsViewSchema.parse(await service.read(auth)),
          };
        } catch (error) {
          if (error instanceof ZodError) {
            reply.code(400);
            return fail("VALIDATION_FAILED");
          }
          if (error instanceof NotificationSettingsError) {
            reply.code(error.code === "POLICY_DENIED" ? 403 : 409);
            return fail(error.code);
          }
          request.log.error(safeErrorContext(error), "Notification configuration failed");
          reply.code(500);
          return fail("TRANSACTION_FAILED");
        }
      },
    });
}

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  fail,
  rateLimited,
  recordLoginFailure,
  requireCsrf,
  resolveSession,
  type AuthRouteContext,
} from "../http/auth-route-support.js";
import { cleanupExpiredImportRequests } from "./import-cleanup.js";
import { LOCAL_PROFILE } from "../local/profile.js";
import { safeErrorContext } from "../http/local-logger.js";
import { isConfiguredRuntimeTenant } from "../http/runtime-surface-policy.js";
import { createPhotoUploadLimiter } from "../http/photo-file-routes.js";
import { createByokMutationRateLimiter } from "../http/byok-rate-limit.js";
import { approveMigrationRequest, migrationApprovalSchema } from "./import-requests.js";
import {
  MAX_IMPORT_PHOTO_BYTES,
  MAX_IMPORT_SOURCE_BYTES,
  type ImportDraftStore,
} from "./import-drafts.js";

const draftParams = z.object({ draftId: z.uuid() }).strict();
const photoParams = draftParams.extend({ photoId: z.uuid() });

export function registerV1MigrationRoutes(
  app: FastifyInstance,
  context: AuthRouteContext,
  drafts: ImportDraftStore,
): void {
  const pool = context.runtime.pool;
  if (!pool) return;
  const allowRequest = createPhotoUploadLimiter();
  const photoUploads = createByokMutationRateLimiter({
    maxAttempts: 1100,
    windowSeconds: 60,
    maxSessions: 100,
  });
  const authorized = async (request: FastifyRequest, reply: FastifyReply) => {
    const resolved = await resolveSession(context.runtime, request);
    if (!resolved) {
      reply.code(401).send(fail("AUTHENTICATION_FAILED"));
      return null;
    }
    if (
      !isConfiguredRuntimeTenant(resolved) ||
      resolved.authority.role !== "admin" ||
      !resolved.authority.is_privacy_admin
    ) {
      reply.code(403).send(fail("PERMISSION_DENIED"));
      return null;
    }
    const upload =
      request.routeOptions.url === "/api/v2/migrations/v1/drafts/:draftId/photos/:photoId";
    const allowed = upload
      ? photoUploads.consume(resolved.session.session_id).allowed
      : allowRequest(resolved.session.session_id, Date.now());
    if (!allowed) {
      reply.code(429).header("Retry-After", "60").send(fail("RATE_LIMITED"));
      return null;
    }
    if (request.method !== "GET") {
      const csrf = await requireCsrf(context, request, reply, resolved.session);
      if (csrf !== true) {
        reply.send(csrf);
        return null;
      }
    }
    return resolved;
  };
  const failure = (error: unknown, request: FastifyRequest, reply: FastifyReply) => {
    request.log.error(safeErrorContext(error), "v1 migration preparation failed");
    reply.code(error instanceof z.ZodError ? 400 : 409);
    return fail(error instanceof z.ZodError ? "VALIDATION_FAILED" : "RESOURCE_UNAVAILABLE");
  };
  // Private custom media type prevents this parser from changing existing routes.
  app.addContentTypeParser(
    "application/vnd.laundry.v1-migration",
    {
      parseAs: "buffer",
      bodyLimit: MAX_IMPORT_SOURCE_BYTES,
    },
    (_request, body, done) => done(null, body),
  );
  app.post(
    "/api/v2/migrations/v1/drafts",
    { bodyLimit: MAX_IMPORT_SOURCE_BYTES },
    async (request, reply) => {
      try {
        const auth = await authorized(request, reply);
        if (!auth) return;
        if (!Buffer.isBuffer(request.body)) {
          reply.code(400);
          return fail("VALIDATION_FAILED");
        }
        const data = await drafts.create(auth.session.session_id, request.body);
        return { ok: true, data };
      } catch (error) {
        return failure(error, request, reply);
      }
    },
  );
  app.post(
    "/api/v2/migrations/v1/drafts/:draftId/photos/:photoId",
    { bodyLimit: MAX_IMPORT_PHOTO_BYTES },
    async (request, reply) => {
      try {
        const auth = await authorized(request, reply);
        if (!auth) return;
        const { draftId, photoId } = photoParams.parse(request.params);
        if (!Buffer.isBuffer(request.body)) {
          reply.code(400);
          return fail("VALIDATION_FAILED");
        }
        await drafts.uploadPhoto(auth.session.session_id, draftId, photoId, request.body);
        return { ok: true, data: { uploaded: true } };
      } catch (error) {
        return failure(error, request, reply);
      }
    },
  );
  app.get("/api/v2/migrations/v1/drafts/:draftId/review", async (request, reply) => {
    try {
      const auth = await authorized(request, reply);
      if (!auth) return;
      const { draftId } = draftParams.parse(request.params);
      return { ok: true, data: await drafts.review(auth.session.session_id, draftId) };
    } catch (error) {
      return failure(error, request, reply);
    }
  });
  app.post(
    "/api/v2/migrations/v1/drafts/:draftId/authorize",
    { bodyLimit: 4096 },
    async (request, reply) => {
      try {
        const auth = await authorized(request, reply);
        if (!auth) return;
        const { draftId } = draftParams.parse(request.params);
        const input = migrationApprovalSchema.parse(request.body);
        const staff = await context.runtime.identity.login.staff.findById(
          auth.session.org_id,
          auth.session.staff_id,
        );
        if (!staff || !staff.is_active) {
          reply.code(401);
          return fail("AUTHENTICATION_FAILED");
        }
        const limitInput = {
          org_code: auth.session.org_id,
          store_code: auth.session.store_id,
          username: staff.username,
          ip: request.ip,
        };
        const attempt = context.loginRateLimiter.beginAttempt(limitInput);
        if (!attempt.allowed) {
          return rateLimited(
            request,
            reply,
            context.securityEvents,
            limitInput,
            attempt.retryAfterSeconds,
          );
        }
        let passwordOk = false;
        try {
          passwordOk = await context.runtime.identity.login.passwordPort.verifyPassword(
            input.password,
            staff.password_hash,
          );
        } catch (error) {
          attempt.reservation.release();
          throw error;
        }
        if (!passwordOk) {
          attempt.reservation.fail();
          recordLoginFailure(request, context.securityEvents, limitInput);
          reply.code(401);
          return fail("AUTHENTICATION_FAILED");
        }
        attempt.reservation.succeed();
        const data = await drafts.approve(auth.session.session_id, draftId, async (review) => {
          if (
            review.source_sha256 !== input.source_sha256 ||
            review.plan_sha256 !== input.plan_sha256 ||
            review.photos_sha256 !== input.photos_sha256
          )
            throw new Error("V1_MIGRATION_REVIEW_MISMATCH");
          return approveMigrationRequest(pool, auth, draftId, {
            source_sha256: input.source_sha256,
            plan_sha256: input.plan_sha256,
            photos_sha256: input.photos_sha256,
          });
        });
        return { ok: true, data };
      } catch (error) {
        return failure(error, request, reply);
      }
    },
  );
  const timer = setInterval(() => {
    void drafts
      .prune()
      .then(() =>
        cleanupExpiredImportRequests(
          pool,
          {
            orgId: LOCAL_PROFILE.orgId,
            storeId: LOCAL_PROFILE.storeId,
            staffId: LOCAL_PROFILE.adminStaffId,
          },
          drafts.root,
        ),
      )
      .catch((error) => {
        app.log.error(safeErrorContext(error), "v1 migration draft cleanup failed");
      });
  }, 60_000);
  timer.unref();
  app.addHook("onClose", async () => {
    clearInterval(timer);
  });
}

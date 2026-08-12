/** Authenticated local photo upload/download routes. */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { DEFAULT_MAX_PHOTO_BYTES, PhotoFileError } from "../photo/file-store.js";
import type { PhotoHandlerDeps } from "../photo/handlers.js";
import { createPhotoThumbnail, normalizePhoto } from "../photo/image-processing.js";
import type { PhotoRecord } from "../photo/types.js";
import {
  fail,
  requireCsrf,
  resolveSession,
  type RouteSecurityContext,
} from "./auth-route-support.js";
import { applyCommandErrorStatus, executeTrustedSessionCommand } from "./bus-routes.js";
import { safeErrorContext } from "./local-logger.js";
import { isConfiguredRuntimeTenant } from "./runtime-surface-policy.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CONTENT_TYPES = Object.freeze(["image/jpeg", "image/png", "image/webp"] as const);
const UPLOADS_PER_MINUTE = 20;
const MAX_LIMITER_SESSIONS = 5_000;
const UPLOAD_WINDOW_MS = 60_000;

const UploadQuerySchema = z
  .object({
    upload_id: z.string().regex(UUID_RE),
    order_id: z.string().regex(UUID_RE),
    garment_id: z.string().regex(UUID_RE),
    kind: z.enum(["receive", "defect", "ready", "other"]),
    taken_at: z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  })
  .strict();
const DeleteBodySchema = z
  .object({
    delete_id: z.string().regex(UUID_RE),
  })
  .strict();

type UploadWindow = Readonly<{ startedAt: number; count: number }>;

export function createPhotoUploadLimiter() {
  const windows = new Map<string, UploadWindow>();
  return (sessionId: string, now: number): boolean => {
    let current = windows.get(sessionId);
    if (current === undefined && windows.size >= MAX_LIMITER_SESSIONS) {
      for (const [candidateId, candidate] of windows) {
        if (now - candidate.startedAt >= UPLOAD_WINDOW_MS) windows.delete(candidateId);
      }
      if (windows.size >= MAX_LIMITER_SESSIONS) return false;
      current = windows.get(sessionId);
    }
    if (current === undefined || now - current.startedAt >= UPLOAD_WINDOW_MS) {
      windows.set(sessionId, Object.freeze({ startedAt: now, count: 1 }));
      return true;
    }
    if (current.count >= UPLOADS_PER_MINUTE) return false;
    windows.set(sessionId, Object.freeze({ ...current, count: current.count + 1 }));
    return true;
  };
}

function requestContentType(request: FastifyRequest): string {
  return request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function applyPhotoError(reply: FastifyReply, error: PhotoFileError) {
  if (error.code === "PHOTO_SIZE_INVALID") {
    reply.code(413);
    return fail("VALIDATION_FAILED");
  }
  if (error.code === "PHOTO_TYPE_INVALID" || error.code === "PHOTO_DECODE_INVALID") {
    reply.code(415);
    return fail("VALIDATION_FAILED");
  }
  if (error.code === "PHOTO_QUOTA_EXCEEDED") {
    reply.code(507);
    return fail("RESOURCE_UNAVAILABLE");
  }
  reply.code(409);
  return fail("RESOURCE_UNAVAILABLE");
}

async function findAuthorizedPhoto(
  request: FastifyRequest,
  reply: FastifyReply,
  context: RouteSecurityContext,
  photo: PhotoHandlerDeps,
): Promise<Readonly<{ record: PhotoRecord & Readonly<{ content_sha256: string }> }> | null> {
  const resolved = await resolveSession(context.runtime, request);
  if (resolved === null) {
    reply.code(401);
    void reply.send(fail("AUTHENTICATION_FAILED"));
    return null;
  }
  if (!isConfiguredRuntimeTenant(resolved)) {
    reply.code(404);
    void reply.send(fail("RESOURCE_UNAVAILABLE"));
    return null;
  }
  const params = request.params as Readonly<{ photoId?: unknown }>;
  const photoId = typeof params.photoId === "string" ? params.photoId : "";
  if (!UUID_RE.test(photoId)) {
    reply.code(400);
    void reply.send(fail("VALIDATION_FAILED"));
    return null;
  }
  const record = await photo.store.findById(
    resolved.session.org_id,
    resolved.session.store_id,
    photoId,
  );
  if (record === null || record.content_sha256 === null) {
    reply.code(404);
    void reply.send(fail("RESOURCE_UNAVAILABLE"));
    return null;
  }
  return Object.freeze({
    record: Object.freeze({ ...record, content_sha256: record.content_sha256 }),
  });
}

function sendPrivateImage(reply: FastifyReply, contentType: string, bytes: Buffer): FastifyReply {
  reply.header("content-type", contentType);
  reply.header("content-length", String(bytes.byteLength));
  reply.header("x-content-type-options", "nosniff");
  reply.header("cache-control", "private, no-store");
  reply.header("content-disposition", "inline");
  return reply.send(bytes);
}

export function registerPhotoFileRoutes(
  app: FastifyInstance,
  context: RouteSecurityContext,
  photo: PhotoHandlerDeps,
): void {
  if (photo.files === undefined) return;
  const files = photo.files;
  const allowMutation = createPhotoUploadLimiter();

  app.addContentTypeParser(
    [...CONTENT_TYPES],
    { parseAs: "buffer", bodyLimit: DEFAULT_MAX_PHOTO_BYTES },
    (_request, body, done) => done(null, body),
  );

  app.post("/api/v2/photos", async (request, reply) => {
    let installed: Awaited<ReturnType<typeof files.write>> | null = null;
    try {
      const resolved = await resolveSession(context.runtime, request);
      if (resolved === null) {
        reply.code(401);
        return fail("AUTHENTICATION_FAILED");
      }
      const csrf = await requireCsrf(context, request, reply, resolved.session);
      if (csrf !== true) return csrf;
      if (!isConfiguredRuntimeTenant(resolved)) {
        reply.code(404);
        return fail("RESOURCE_UNAVAILABLE");
      }
      if (!allowMutation(resolved.session.session_id, Date.now())) {
        reply.code(429);
        return fail("RATE_LIMITED");
      }
      const query = UploadQuerySchema.safeParse(request.query);
      if (!query.success || !Buffer.isBuffer(request.body)) {
        reply.code(400);
        return fail("VALIDATION_FAILED");
      }

      const declaredType = requestContentType(request);
      if (
        declaredType !== "image/jpeg" &&
        declaredType !== "image/png" &&
        declaredType !== "image/webp"
      ) {
        reply.code(415);
        return fail("VALIDATION_FAILED");
      }
      const normalized = await normalizePhoto(request.body, declaredType);
      installed = await files.write(
        normalized.bytes,
        normalized.content_type,
        query.data.upload_id,
      );
      const result = await executeTrustedSessionCommand(
        context,
        resolved,
        "photo.register",
        Object.freeze({
          order_id: query.data.order_id,
          garment_id: query.data.garment_id,
          kind: query.data.kind,
          storage_key: installed.storage_key,
          content_type: installed.content_type,
          content_sha256: installed.content_sha256,
          byte_size: installed.byte_size,
          ...(query.data.taken_at === undefined ? {} : { taken_at: query.data.taken_at }),
        }),
        Object.freeze({
          idempotencyKey: query.data.upload_id,
          onUnexpectedError: (error: unknown) =>
            request.log.error(safeErrorContext(error), "photo register execution failed"),
        }),
      );
      if (!result.ok) {
        await files.remove(installed.storage_key, installed.content_sha256);
        installed = null;
        applyCommandErrorStatus(reply, result.error.code);
      }
      return result;
    } catch (error) {
      if (installed !== null) {
        await files.remove(installed.storage_key, installed.content_sha256).catch(() => undefined);
      }
      if (error instanceof PhotoFileError) return applyPhotoError(reply, error);
      request.log.error(safeErrorContext(error), "photo upload failed");
      reply.code(500);
      return fail("TRANSACTION_FAILED");
    }
  });

  app.post("/api/v2/photos/:photoId/delete", async (request, reply) => {
    try {
      const resolved = await resolveSession(context.runtime, request);
      if (resolved === null) {
        reply.code(401);
        return fail("AUTHENTICATION_FAILED");
      }
      const csrf = await requireCsrf(context, request, reply, resolved.session);
      if (csrf !== true) return csrf;
      if (!isConfiguredRuntimeTenant(resolved)) {
        reply.code(404);
        return fail("RESOURCE_UNAVAILABLE");
      }
      if (!allowMutation(resolved.session.session_id, Date.now())) {
        reply.code(429);
        return fail("RATE_LIMITED");
      }
      const params = request.params as Readonly<{ photoId?: unknown }>;
      const photoId = typeof params.photoId === "string" ? params.photoId : "";
      const body = DeleteBodySchema.safeParse(request.body);
      if (!UUID_RE.test(photoId) || !body.success) {
        reply.code(400);
        return fail("VALIDATION_FAILED");
      }
      const privateRecord = await photo.store.findById(
        resolved.session.org_id,
        resolved.session.store_id,
        photoId,
      );
      const result = await executeTrustedSessionCommand(
        context,
        resolved,
        "photo.delete",
        Object.freeze({ photo_id: photoId }),
        Object.freeze({
          idempotencyKey: body.data.delete_id,
          onUnexpectedError: (error: unknown) =>
            request.log.error(safeErrorContext(error), "photo delete execution failed"),
        }),
      );
      if (!result.ok) {
        applyCommandErrorStatus(reply, result.error.code);
        return result;
      }
      if (privateRecord !== null && privateRecord.content_sha256 !== null) {
        await files
          .remove(privateRecord.storage_key, privateRecord.content_sha256)
          .catch((error) => {
            request.log.error(safeErrorContext(error), "photo delete cleanup deferred");
          });
      }
      return result;
    } catch (error) {
      if (error instanceof PhotoFileError) return applyPhotoError(reply, error);
      request.log.error(safeErrorContext(error), "photo delete failed");
      reply.code(500);
      return fail("TRANSACTION_FAILED");
    }
  });

  app.get("/api/v2/photos/:photoId/thumbnail", async (request, reply) => {
    try {
      const authorized = await findAuthorizedPhoto(request, reply, context, photo);
      if (authorized === null) return reply;
      const record = authorized.record;
      const file = await files.read({
        storage_key: record.storage_key,
        content_type: record.content_type,
        content_sha256: record.content_sha256,
        byte_size: record.byte_size,
      });
      const thumbnail = await createPhotoThumbnail(file.bytes);
      return sendPrivateImage(reply, thumbnail.content_type, thumbnail.bytes);
    } catch (error) {
      if (error instanceof PhotoFileError) return applyPhotoError(reply, error);
      request.log.error(safeErrorContext(error), "photo thumbnail failed");
      reply.code(500);
      return fail("TRANSACTION_FAILED");
    }
  });

  app.get("/api/v2/photos/:photoId", async (request, reply) => {
    try {
      const authorized = await findAuthorizedPhoto(request, reply, context, photo);
      if (authorized === null) return reply;
      const record = authorized.record;
      const file = await files.read({
        storage_key: record.storage_key,
        content_type: record.content_type,
        content_sha256: record.content_sha256,
        byte_size: record.byte_size,
      });
      return sendPrivateImage(reply, file.content_type, file.bytes);
    } catch (error) {
      if (error instanceof PhotoFileError) return applyPhotoError(reply, error);
      request.log.error(safeErrorContext(error), "photo download failed");
      reply.code(500);
      return fail("TRANSACTION_FAILED");
    }
  });
}

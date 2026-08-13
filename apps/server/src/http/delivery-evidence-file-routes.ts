/** Authenticated private media boundary for delivery evidence. */

import { createHash } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import {
  DeliveryEvidenceUploadResponseSchema,
  type DeliveryEvidenceAttachment,
} from "@laundry/contracts";

import { permissionsForAuthority } from "../bus/runtime.js";
import type { DeliveryEvidenceHandlerDeps } from "../delivery-evidence/handlers.js";
import { publicAttachment, type StoredDeliveryAttachment } from "../delivery-evidence/types.js";
import { DEFAULT_MAX_PHOTO_BYTES, PhotoFileError } from "../photo/file-store.js";
import { normalizePhoto } from "../photo/image-processing.js";
import {
  fail,
  requireCsrf,
  resolveSession,
  type RouteSecurityContext,
} from "./auth-route-support.js";
import { safeErrorContext } from "./local-logger.js";
import { isConfiguredRuntimeTenant } from "./runtime-surface-policy.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MEDIA_TYPES = Object.freeze(["image/jpeg", "image/png", "image/webp"] as const);
const UploadQuerySchema = z
  .object({
    attachment_id: z.string().regex(UUID_RE),
    delivery_order_id: z.string().regex(UUID_RE),
    delivery_task_id: z.string().regex(UUID_RE),
    leg: z.enum(["pickup", "return"]),
    expected_delivery_task_version: z.coerce.number().int().positive().max(2_147_483_647),
    kind: z.enum(["photo", "signature"]),
    captured_at: z.coerce.number().int().nonnegative().max(4_294_967_295),
  })
  .strict();

type Window = Readonly<{ startedAt: number; reads: number; writes: number }>;

export function createDeliveryEvidenceMediaLimiter() {
  const windows = new Map<string, Window>();
  return (sessionId: string, mode: "read" | "write", now: number): boolean => {
    const previous = windows.get(sessionId);
    const current =
      previous === undefined || now - previous.startedAt >= 60_000
        ? Object.freeze({ startedAt: now, reads: 0, writes: 0 })
        : previous;
    if ((mode === "write" ? current.writes : current.reads) >= (mode === "write" ? 20 : 60)) {
      return false;
    }
    if (windows.size >= 5_000 && previous === undefined) return false;
    windows.set(
      sessionId,
      Object.freeze({
        ...current,
        reads: current.reads + (mode === "read" ? 1 : 0),
        writes: current.writes + (mode === "write" ? 1 : 0),
      }),
    );
    return true;
  };
}

const digest = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
const contentType = (request: FastifyRequest): string =>
  request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() ?? "";

function sameUpload(
  existing: StoredDeliveryAttachment,
  query: z.infer<typeof UploadQuerySchema>,
  contentSha256: string,
): boolean {
  return (
    existing.delivery_order_id === query.delivery_order_id &&
    existing.delivery_task_id === query.delivery_task_id &&
    existing.leg === query.leg &&
    existing.delivery_task_version === query.expected_delivery_task_version &&
    existing.kind === query.kind &&
    existing.captured_at === query.captured_at &&
    existing.content_sha256 === contentSha256
  );
}

function sendAttachment(attachment: DeliveryEvidenceAttachment) {
  return DeliveryEvidenceUploadResponseSchema.parse({ ok: true, data: { attachment } });
}

function sendPrivateImage(reply: FastifyReply, contentTypeValue: string, bytes: Buffer) {
  reply.header("content-type", contentTypeValue);
  reply.header("content-length", String(bytes.byteLength));
  reply.header("x-content-type-options", "nosniff");
  reply.header("cache-control", "private, no-store");
  reply.header("content-disposition", "inline");
  return reply.send(bytes);
}

export function registerDeliveryEvidenceFileRoutes(
  app: FastifyInstance,
  context: RouteSecurityContext,
  evidence: DeliveryEvidenceHandlerDeps,
): void {
  if (evidence.files === undefined) return;
  const files = evidence.files;
  const allow = createDeliveryEvidenceMediaLimiter();
  const missingParsers = MEDIA_TYPES.filter((type) => !app.hasContentTypeParser(type));
  if (missingParsers.length > 0) {
    app.addContentTypeParser(
      missingParsers,
      { parseAs: "buffer", bodyLimit: DEFAULT_MAX_PHOTO_BYTES },
      (_request, body, done) => done(null, body),
    );
  }

  app.post("/api/v2/delivery-evidence/attachments", async (request, reply) => {
    let installed: Awaited<ReturnType<typeof files.write>> | null = null;
    try {
      const resolved = await resolveSession(context.runtime, request);
      if (resolved === null) {
        reply.code(401);
        return fail("AUTHENTICATION_FAILED");
      }
      const csrf = await requireCsrf(context, request, reply, resolved.session);
      if (csrf !== true) return csrf;
      if (
        !isConfiguredRuntimeTenant(resolved) ||
        !permissionsForAuthority(resolved.authority).includes("delivery_write")
      ) {
        reply.code(404);
        return fail("RESOURCE_UNAVAILABLE");
      }
      if (!allow(resolved.session.session_id, "write", Date.now())) {
        reply.code(429);
        return fail("RATE_LIMITED");
      }
      const query = UploadQuerySchema.safeParse(request.query);
      const declaredType = contentType(request);
      if (!query.success || !Buffer.isBuffer(request.body)) {
        reply.code(400);
        return fail("VALIDATION_FAILED");
      }
      if (!MEDIA_TYPES.includes(declaredType as (typeof MEDIA_TYPES)[number])) {
        reply.code(415);
        return fail("VALIDATION_FAILED");
      }
      const normalized = await normalizePhoto(
        request.body,
        declaredType as "image/jpeg" | "image/png" | "image/webp",
      );
      const existing = await evidence.store.uploadedAttachment(
        resolved.session.org_id,
        resolved.session.store_id,
        resolved.session.staff_id,
        query.data.attachment_id,
      );
      if (existing !== null) {
        if (!sameUpload(existing, query.data, digest(normalized.bytes))) {
          reply.code(409);
          return fail("IDEMPOTENCY_CONFLICT");
        }
        return sendAttachment(publicAttachment(existing));
      }
      installed = await files.write(normalized.bytes, normalized.content_type);
      const registered = await evidence.store.registerAttachment({
        ...query.data,
        org_id: resolved.session.org_id,
        store_id: resolved.session.store_id,
        staff_id: resolved.session.staff_id,
        storage_key: installed.storage_key,
        content_type: installed.content_type,
        content_sha256: installed.content_sha256,
        byte_size: installed.byte_size,
        at: Math.floor(Date.now() / 1_000),
      });
      if (!registered.ok) {
        await files.remove(installed.storage_key, installed.content_sha256);
        installed = null;
        reply.code(registered.reason === "conflict" ? 409 : 403);
        return fail(
          registered.reason === "conflict" ? "IDEMPOTENCY_CONFLICT" : "PERMISSION_DENIED",
        );
      }
      if (registered.replay) {
        await files.remove(installed.storage_key, installed.content_sha256);
        installed = null;
      }
      return sendAttachment(publicAttachment(registered.attachment));
    } catch (error) {
      if (installed !== null) {
        await files.remove(installed.storage_key, installed.content_sha256).catch(() => undefined);
      }
      if (error instanceof PhotoFileError) {
        reply.code(error.code === "PHOTO_SIZE_INVALID" ? 413 : 415);
        return fail("VALIDATION_FAILED");
      }
      request.log.error(safeErrorContext(error), "delivery evidence upload failed");
      reply.code(500);
      return fail("TRANSACTION_FAILED");
    }
  });

  app.get("/api/v2/delivery-evidence/attachments/:attachmentId", async (request, reply) => {
    try {
      const resolved = await resolveSession(context.runtime, request);
      if (resolved === null) {
        reply.code(401);
        return fail("AUTHENTICATION_FAILED");
      }
      if (
        !isConfiguredRuntimeTenant(resolved) ||
        !permissionsForAuthority(resolved.authority).includes("delivery_read")
      ) {
        reply.code(404);
        return fail("RESOURCE_UNAVAILABLE");
      }
      if (!allow(resolved.session.session_id, "read", Date.now())) {
        reply.code(429);
        return fail("RATE_LIMITED");
      }
      const params = request.params as Readonly<{ attachmentId?: unknown }>;
      const attachmentId = typeof params.attachmentId === "string" ? params.attachmentId : "";
      if (!UUID_RE.test(attachmentId)) {
        reply.code(400);
        return fail("VALIDATION_FAILED");
      }
      const attachment = await evidence.store.authorizedAttachment(
        resolved.session.org_id,
        resolved.session.store_id,
        resolved.session.staff_id,
        attachmentId,
      );
      if (attachment === null) {
        reply.code(404);
        return fail("RESOURCE_UNAVAILABLE");
      }
      const file = await files.read({
        storage_key: attachment.storage_key,
        content_type: attachment.content_type,
        content_sha256: attachment.content_sha256,
        byte_size: attachment.byte_size,
      });
      return sendPrivateImage(reply, file.content_type, file.bytes);
    } catch (error) {
      request.log.error(safeErrorContext(error), "delivery evidence download failed");
      reply.code(500);
      return fail("TRANSACTION_FAILED");
    }
  });
}

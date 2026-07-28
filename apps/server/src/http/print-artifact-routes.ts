/**
 * Authenticated mock print artifact download (product design §7).
 *
 * The artifact is addressed by job id only — a caller never supplies a path.
 * The stored name is re-validated before use, the bytes are verified against
 * the recorded hash, and the response is marked non-sniffable and non-cacheable
 * so a receipt cannot be re-interpreted as script or linger in a shared cache.
 */

import { lstat, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isAbsolute, join, relative, sep } from "node:path";

import type { FastifyInstance } from "fastify";

import type { FileSpool } from "../print/file-spool.js";
import { fail, resolveSession, type RouteSecurityContext } from "./auth-route-support.js";
import { safeErrorContext } from "./local-logger.js";

/** Must match what the spool produces and what 0022 allows to be stored. */
const ARTIFACT_NAME = /^[0-9a-f-]{36}-[a-z0-9]{1,16}-[0-9]{4}\.txt$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-9a-f][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export type PrintArtifactLookup = Readonly<{
  /** Resolve the stored artifact for a job within the caller's tenant. */
  find: (
    orgId: string,
    storeId: string,
    jobId: string,
  ) => Promise<Readonly<{ artifact_path: string; artifact_sha256: string }> | null>;
}>;

export type PrintArtifactRouteDeps = Readonly<{
  spool: FileSpool;
  lookup: PrintArtifactLookup;
}>;

function withinRoot(rootPath: string, candidate: string): boolean {
  const rel = relative(rootPath, candidate);
  return rel !== "" && !rel.startsWith("..") && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export function registerPrintArtifactRoutes(
  app: FastifyInstance,
  context: RouteSecurityContext,
  deps: PrintArtifactRouteDeps,
): void {
  app.get("/api/v2/print/artifacts/:jobId", async (request, reply) => {
    try {
      const resolved = await resolveSession(context.runtime, request);
      if (resolved === null) {
        reply.code(401);
        return fail("AUTHENTICATION_FAILED");
      }

      const params = request.params as Readonly<{ jobId?: unknown }>;
      const jobId = typeof params.jobId === "string" ? params.jobId : "";
      if (!UUID.test(jobId)) {
        reply.code(400);
        return fail("VALIDATION_FAILED");
      }

      // Tenant comes from the server-side session, never from the request.
      const found = await deps.lookup.find(
        resolved.session.org_id,
        resolved.session.store_id,
        jobId,
      );
      if (found === null) {
        reply.code(404);
        return fail("RESOURCE_UNAVAILABLE");
      }

      // Re-validate the stored name: a row written before a constraint, or by
      // any future path, must still not be able to walk out of the spool.
      if (!ARTIFACT_NAME.test(found.artifact_path)) {
        reply.code(404);
        return fail("RESOURCE_UNAVAILABLE");
      }
      const artifactPath = join(deps.spool.rootPath, found.artifact_path);
      if (!withinRoot(deps.spool.rootPath, artifactPath)) {
        reply.code(404);
        return fail("RESOURCE_UNAVAILABLE");
      }

      const meta = await lstat(artifactPath).catch(() => null);
      if (meta === null || meta.isSymbolicLink() || !meta.isFile()) {
        reply.code(404);
        return fail("RESOURCE_UNAVAILABLE");
      }

      const bytes = await readFile(artifactPath);
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (digest !== found.artifact_sha256) {
        // The spool no longer matches what was recorded; serving it would hand
        // back content nobody vouched for.
        request.log.error({ job_id: jobId }, "print artifact hash mismatch");
        reply.code(409);
        return fail("RESOURCE_UNAVAILABLE");
      }

      reply.header("content-type", "text/plain; charset=utf-8");
      reply.header("x-content-type-options", "nosniff");
      reply.header("cache-control", "no-store");
      reply.header("content-disposition", `attachment; filename="${found.artifact_path}"`);
      return reply.send(bytes);
    } catch (error) {
      request.log.error(safeErrorContext(error), "print artifact request failed");
      reply.code(500);
      return fail("TRANSACTION_FAILED");
    }
  });
}

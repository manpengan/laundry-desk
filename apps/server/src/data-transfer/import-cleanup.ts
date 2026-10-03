import { readFile, rm, lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { inspectPrivateDirectory, inspectPrivateFile } from "@laundry/platform-fs";
import type { PgPool } from "../db/pg-pool.js";
import { withPoolClient } from "../db/pg-sql-client.js";
import { withTenantTransaction } from "../db/tenant-transaction.js";
import type { TenantContext } from "../db/types.js";
import { importRequestPaths, openImportRequestRoot } from "./import-drafts.js";

export const IMPORT_REQUEST_MARKER = ".laundry-v1-request";
export const importRequestMarker = (id: string) => `laundry-v1-request:${id}\n`;

/** Lost process-local previews and expired approvals never retain source PII
 * indefinitely after a crash. Draft 30m plus approval 10m is below this 1h floor. */
export async function cleanupStaleImportMaterials(root: string, now = Date.now()): Promise<void> {
  for (const name of await readdir(root)) {
    if (!/^[0-9a-f-]{36}$/u.test(name)) continue;
    const path = importRequestPaths(root, name).directory;
    const marker = join(path, IMPORT_REQUEST_MARKER);
    const info = await lstat(marker).catch(() => null);
    if (info === null || now - info.mtimeMs <= 60 * 60_000) continue;
    await cleanupImportRequest(root, name);
  }
}

/** Cleanup only a private, marked directory created for this exact request. */
export async function cleanupImportRequest(root: string, id: string): Promise<void> {
  await openImportRequestRoot(root);
  const path = importRequestPaths(root, id).directory;
  try {
    await lstat(path);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
      return;
    throw error;
  }
  await inspectPrivateDirectory(path);
  const marker = join(path, IMPORT_REQUEST_MARKER);
  await inspectPrivateFile(marker);
  if ((await readFile(marker, "utf8")) !== importRequestMarker(id))
    throw new Error("V1_MIGRATION_CLEANUP_OWNERSHIP");
  await rm(path, { recursive: true });
}

export async function cleanupExpiredImportRequests(
  pool: PgPool,
  tenant: TenantContext,
  root: string,
): Promise<void> {
  const ids = await withPoolClient(pool, (client) =>
    withTenantTransaction(client, tenant, async () => {
      const result = await client.query<{ id: string }>(`SELECT id FROM v1_import_requests
      WHERE materials_deleted_at IS NULL AND (consumed_at IS NOT NULL OR expires_at<=now())
      ORDER BY expires_at LIMIT 32`);
      return result.rows.map((row) => row.id);
    }),
  );
  for (const id of ids) {
    await cleanupImportRequest(root, id);
    await markMigrationMaterialsDeleted(pool, tenant, id);
  }
}

export async function markMigrationMaterialsDeleted(
  pool: PgPool,
  tenant: TenantContext,
  id: string,
) {
  await withPoolClient(pool, (client) =>
    withTenantTransaction(client, tenant, () =>
      client.query(
        "UPDATE v1_import_requests SET materials_deleted_at=now() WHERE id=$1 AND (consumed_at IS NOT NULL OR expires_at<=now())",
        [id],
      ),
    ),
  );
}

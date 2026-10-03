import { inspectPrivateDirectory, inspectPrivateFile } from "@laundry/platform-fs";
import {
  loadV2Migration,
  reconcileMigration,
  transformV1Snapshot,
  validateMigrationPlan,
} from "@laundry/migrate-v1/plan";
import { cleanupImportRequest, markMigrationMaterialsDeleted } from "./import-cleanup.js";
import type { TenantContext } from "../db/types.js";
import { importRequestPaths, openImportRequestRoot } from "./import-drafts.js";
import { readApprovedMigrationRequest } from "./import-requests.js";
import { createPgV1MigrationLoader, type PgV1MigrationOptions } from "./pg-v1-import.js";

export type ApprovedV1ImportOptions = Omit<PgV1MigrationOptions, "authorize" | "photoSourceRoot"> &
  Readonly<{
    requestRoot: string;
    requestId: string;
    /** Runtime-owned local profile. Never accept these fields as CLI/HTTP arguments. */
    configuredTenant: TenantContext;
  }>;

/** Called by the existing Windows maintenance owner while it holds its operation
 * lock and the counter/service are stopped. Only requestId is operator input. */
export async function runApprovedV1Import(options: ApprovedV1ImportOptions) {
  await openImportRequestRoot(options.requestRoot);
  const paths = importRequestPaths(options.requestRoot, options.requestId);
  await inspectPrivateDirectory(paths.directory);
  await inspectPrivateDirectory(paths.photos);
  await inspectPrivateFile(paths.source);
  const { extractV1Snapshot } = await import("@laundry/migrate-v1");
  const source = await extractV1Snapshot(paths.source);
  const plan = transformV1Snapshot(source);
  const report = reconcileMigration(source, plan);
  validateMigrationPlan(plan, report);
  const authorize = () =>
    readApprovedMigrationRequest(options.pool, options.configuredTenant, options.requestId);
  const loader = createPgV1MigrationLoader({
    ...options,
    authorize,
    photoSourceRoot: paths.photos,
  });
  await loadV2Migration(loader, options.targetDatabaseUrl, plan, report);
  let cleanupPending = false;
  try {
    await cleanupImportRequest(options.requestRoot, options.requestId);
    await markMigrationMaterialsDeleted(options.pool, options.configuredTenant, options.requestId);
  } catch {
    cleanupPending = true;
  }
  // No source paths, secrets, names, phones or note text leave the worker.
  return Object.freeze({
    applied: true,
    cleanup_pending: cleanupPending,
    request_id: options.requestId,
    source_sha256: source.sourceBackupSha256,
    totals: report.target,
  });
}

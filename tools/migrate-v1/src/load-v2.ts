import type { ReconciliationReport, V2MigrationPlan } from "./types.js";

export type V2MigrationLoadRequest = Readonly<{
  targetDatabaseUrl: string;
  sourceBackupSha256: string;
}>;

export type V2MigrationApplyRequest = Readonly<{
  backupPointId: string;
  plan: V2MigrationPlan;
  report: ReconciliationReport;
}>;

/**
 * The schema-dependent implementation belongs with Task 6's PG transaction
 * runtime. It must inject org/store/actor from a trusted server-side migration
 * session; the CLI never accepts tenant IDs from the legacy SQLite source.
 */
export type V2PostgresMigrationLoader = Readonly<{
  kind: "v2-postgresql";
  createBackupPoint: (request: V2MigrationLoadRequest) => Promise<Readonly<{ id: string }>>;
  applyIdempotently: (request: V2MigrationApplyRequest) => Promise<void>;
}>;

function isLoader(value: unknown): value is V2PostgresMigrationLoader {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.kind === "v2-postgresql" &&
    typeof candidate.createBackupPoint === "function" &&
    typeof candidate.applyIdempotently === "function"
  );
}

export function assertV2PostgresMigrationLoader(value: unknown): V2PostgresMigrationLoader {
  if (!isLoader(value)) {
    throw new TypeError(
      "loader must be a v2-postgresql loader with backup and idempotent apply methods",
    );
  }
  return value;
}

/**
 * No direct pg client or in-memory fallback exists here. A supplied production
 * loader owns the current M2 schema, one DB transaction, RLS context, and audit.
 */
export async function loadV2Migration(
  loader: V2PostgresMigrationLoader,
  targetDatabaseUrl: string,
  plan: V2MigrationPlan,
  report: ReconciliationReport,
): Promise<void> {
  if (!report.isZeroDifference) {
    throw new Error("refusing to apply a migration with reconciliation differences");
  }
  const backupPoint = await loader.createBackupPoint({
    targetDatabaseUrl,
    sourceBackupSha256: plan.sourceBackupSha256,
  });
  if (backupPoint.id.length === 0) throw new Error("v2 loader did not create a backup point");
  await loader.applyIdempotently({ backupPointId: backupPoint.id, plan, report });
}

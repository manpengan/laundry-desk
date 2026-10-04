import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { v1SnapshotSchema } from "./validate-source.js";

import { reconcileMigration } from "./reconcile.js";
import { transformV1Snapshot } from "./transform.js";
import type { ReconciliationReport, V2MigrationPlan } from "./types.js";

/** Stable object-key ordering; arrays retain their reviewed row order. */
export function canonicalMigrationJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalMigrationJson).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b, "en"))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalMigrationJson(item)}`)
    .join(",")}}`;
}

export function validateMigrationPlan(
  planInput: unknown,
  reportInput: unknown,
): Readonly<{
  plan: V2MigrationPlan;
  report: ReconciliationReport;
  planSha256: string;
}> {
  const boundary = z.object({ sourceSnapshot: v1SnapshotSchema }).passthrough().parse(planInput);
  const snapshot = boundary.sourceSnapshot;
  const plan = transformV1Snapshot(snapshot);
  const report = reconcileMigration(snapshot, plan);
  if (!isDeepStrictEqual(planInput, plan) || !isDeepStrictEqual(reportInput, report)) {
    throw new Error("V1_MIGRATION_PLAN_MISMATCH");
  }
  if (!report.isZeroDifference) throw new Error("V1_MIGRATION_RECONCILIATION_FAILED");
  const planSha256 = createHash("sha256").update(canonicalMigrationJson(plan)).digest("hex");
  return Object.freeze({ plan, report, planSha256 });
}

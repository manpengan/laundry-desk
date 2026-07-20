import type { SupportMatrix, UpgradeState } from "./types.js";

export type RollbackDecision = {
  allowed: boolean;
  reason: string;
};

/**
 * Support-matrix rollback gate (ADR-08 §3/§8).
 * Old binary may only return if matrix says it can still read current schema.
 */
export function decideRollback(
  state: UpgradeState,
  matrix: SupportMatrix,
  targetVersion: string,
): RollbackDecision {
  const activeVersion = state.slots[state.activeSlot].version;
  if (!activeVersion) {
    return { allowed: false, reason: "active_version_missing" };
  }

  const row = matrix.rows.find((r) => r.edge === activeVersion);
  if (!row) {
    if (state.contractPhaseDone) {
      return {
        allowed: false,
        reason: "contract_phase_done_no_matrix_row",
      };
    }
    return {
      allowed: true,
      reason: "no_matrix_row_assume_expand_only",
    };
  }

  if (row.rollbackToEdge !== targetVersion) {
    return {
      allowed: false,
      reason: `matrix_rollback_target_mismatch want=${row.rollbackToEdge}`,
    };
  }

  if (row.rollbackReadsSchema !== true) {
    return {
      allowed: false,
      reason: row.notes ?? "rollback_reads_schema_false",
    };
  }

  return { allowed: true, reason: row.notes ?? "matrix_allows_rollback" };
}

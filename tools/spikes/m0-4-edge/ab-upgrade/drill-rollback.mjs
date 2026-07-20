import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  cmpVersion,
  log,
  saveState,
  slotPath,
  standbyName,
} from "./drill-state.mjs";

function matrixAllowsRollback(matrixPath, state, targetVersion) {
  const matrix = JSON.parse(readFileSync(matrixPath, "utf8"));
  const row = matrix.rows.find(
    (r) => r.edge === state.slots[state.activeSlot].version,
  );
  if (!row) {
    return {
      allowed: !state.contractPhaseDone,
      reason: state.contractPhaseDone
        ? "contract_phase_done_no_matrix_row"
        : "no_matrix_row_assume_expand_only",
    };
  }
  if (row.rollbackToEdge !== targetVersion) {
    return {
      allowed: false,
      reason: `matrix_rollback_target_mismatch want=${row.rollbackToEdge}`,
    };
  }
  return {
    allowed: row.rollbackReadsSchema === true,
    reason: row.notes,
  };
}

function resolveDecision(matrixPath, state, targetVersion, flags) {
  const forced = flags["matrix-compatible"];
  if (forced === "true") {
    return { allowed: true, reason: "flag_matrix_compatible_true" };
  }
  if (forced === "false") {
    return { allowed: false, reason: "flag_matrix_compatible_false" };
  }
  return matrixAllowsRollback(matrixPath, state, targetVersion);
}

function enterRecovery(state, statePath, decision, targetVersion) {
  state.mode = "RECOVERY_MODE";
  log(state, "rollback_blocked_enter_recovery", {
    reason: decision.reason,
    targetVersion,
  });
  saveState(statePath, state);
  console.log(
    JSON.stringify({
      ok: false,
      mode: "RECOVERY_MODE",
      capabilities: ["print_only", "read_only"],
      reason: decision.reason,
    }, null, 2),
  );
  process.exitCode = 2;
}

function switchRollback(slotsDir, state, statePath, other, targetVersion) {
  if (!state.slots[other].version) {
    state.slots[other] = { version: targetVersion, healthy: true };
    writeFileSync(join(slotPath(slotsDir, other), "VERSION"), targetVersion);
  }
  state.activeSlot = other;
  state.mode = "ACTIVE";
  log(state, "rollback_switch", {
    active: state.activeSlot,
    version: state.slots[other].version,
  });
  saveState(statePath, state);
  console.log(
    JSON.stringify({
      ok: true,
      mode: "ACTIVE",
      activeSlot: state.activeSlot,
      version: state.slots[state.activeSlot].version,
    }, null, 2),
  );
}

/** Rollback via support matrix; otherwise recovery mode (ADR-08). */
export function cmdRollback(ctx, flags) {
  const { slotsDir, statePath, matrixPath, state } = ctx;
  const other = standbyName(state);
  const targetVersion = flags.to || state.slots[other].version || "1.9.0";

  if (cmpVersion(targetVersion, state.minSecureVersion) < 0) {
    console.log(
      JSON.stringify({ ok: false, error: "anti_rollback_min_secure_version" }),
    );
    process.exitCode = 1;
    return;
  }

  const decision = resolveDecision(matrixPath, state, targetVersion, flags);
  if (!decision.allowed) {
    return enterRecovery(state, statePath, decision, targetVersion);
  }
  return switchRollback(slotsDir, state, statePath, other, targetVersion);
}

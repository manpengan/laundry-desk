import { decideRollback, type RollbackDecision } from "./matrix.js";
import { appendHistory, standbySlot } from "./state.js";
import type { RollbackInput, RollbackResult, UpgradeState } from "./types.js";
import { isBelowMinSecure } from "./version.js";

const RECOVERY_CAPS = ["print_only", "read_only"] as const;

type Clock = () => string;

function resolveDecision(
  state: UpgradeState,
  input: RollbackInput,
  targetVersion: string,
): RollbackDecision {
  if (input.forceMatrixAllowed === true) {
    return { allowed: true, reason: "flag_matrix_compatible_true" };
  }
  if (input.forceMatrixAllowed === false) {
    return { allowed: false, reason: "flag_matrix_compatible_false" };
  }
  return decideRollback(state, input.matrix, targetVersion);
}

function enterRecovery(
  state: UpgradeState,
  reason: string,
  targetVersion: string,
  now: Clock,
): RollbackResult {
  let next: UpgradeState = { ...state, mode: "RECOVERY_MODE" };
  next = appendHistory(
    next,
    "rollback_blocked_enter_recovery",
    {
      reason,
      targetVersion,
    },
    now,
  );
  return {
    ok: false,
    mode: "RECOVERY_MODE",
    error: reason,
    state: next,
    capabilities: RECOVERY_CAPS,
  };
}

function switchToOther(
  state: UpgradeState,
  other: "A" | "B",
  targetVersion: string,
  now: Clock,
): RollbackResult {
  let next: UpgradeState = {
    ...state,
    activeSlot: other,
    mode: "ACTIVE",
    slots: {
      ...state.slots,
      [other]: {
        version: state.slots[other].version ?? targetVersion,
        healthy: true,
      },
    },
  };
  next = appendHistory(
    next,
    "rollback_switch",
    {
      active: next.activeSlot,
      version: next.slots[other].version,
    },
    now,
  );
  return { ok: true, mode: "ACTIVE", state: next };
}

/**
 * Rollback to the other slot only when support matrix allows schema read-back.
 * Otherwise enter RECOVERY_MODE (no blind downgrade) — ADR-08 §8.
 */
export function rollbackSlot(state: UpgradeState, input: RollbackInput): RollbackResult {
  const now = input.now ?? (() => new Date().toISOString());
  const other = standbySlot(state.activeSlot);
  const targetVersion = input.targetVersion ?? state.slots[other].version ?? "1.9.0";

  if (isBelowMinSecure(targetVersion, state.minSecureVersion)) {
    const next = appendHistory(
      state,
      "rollback_rejected_anti_rollback",
      {
        targetVersion,
      },
      now,
    );
    return {
      ok: false,
      mode: "REJECTED",
      error: "anti_rollback_min_secure_version",
      state: next,
    };
  }

  const decision = resolveDecision(state, input, targetVersion);
  if (!decision.allowed) {
    return enterRecovery(state, decision.reason, targetVersion, now);
  }
  return switchToOther(state, other, targetVersion, now);
}

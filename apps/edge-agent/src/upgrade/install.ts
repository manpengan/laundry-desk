import { isHealthPassing } from "./health.js";
import { appendHistory, standbySlot } from "./state.js";
import type { HealthReport, InstallInput, InstallResult, UpgradeState } from "./types.js";
import { isBelowMinSecure } from "./version.js";

type Clock = () => string;

function rejectInstall(
  state: UpgradeState,
  error: string,
  event: string,
  detail: Record<string, unknown> | undefined,
  now: Clock,
): InstallResult {
  const next = appendHistory(state, event, detail, now);
  return { ok: false, error, state: next };
}

function placeOnStandby(
  state: UpgradeState,
  standby: "A" | "B",
  version: string,
  health: HealthReport,
  now: Clock,
): UpgradeState {
  let next: UpgradeState = {
    ...state,
    primaryLeaseIssuanceBlocked: true,
    mode: "INSTALL_STANDBY",
    slots: {
      ...state.slots,
      [standby]: { version, healthy: isHealthPassing(health) },
    },
  };
  next = appendHistory(
    next,
    "snapshot_before_install",
    {
      active: state.activeSlot,
    },
    now,
  );
  return appendHistory(next, "install_standby", { standby, version, health }, now);
}

function revertStandby(state: UpgradeState, standby: "A" | "B", now: Clock): InstallResult {
  let next: UpgradeState = {
    ...state,
    mode: "REVERT_STANDBY",
    primaryLeaseIssuanceBlocked: false,
    slots: {
      ...state.slots,
      [standby]: { version: null, healthy: false },
    },
  };
  next = appendHistory(
    next,
    "health_fail_keep_active",
    {
      active: next.activeSlot,
    },
    now,
  );
  return {
    ok: true,
    switched: false,
    reason: "health_check_failed",
    state: { ...next, mode: "ACTIVE" },
  };
}

function promoteStandby(
  state: UpgradeState,
  standby: "A" | "B",
  version: string,
  applyContract: boolean | undefined,
  now: Clock,
): InstallResult {
  let next: UpgradeState = {
    ...state,
    activeSlot: standby,
    mode: "ACTIVE",
    primaryLeaseIssuanceBlocked: false,
  };
  if (applyContract) {
    next = {
      ...next,
      localSchema: next.localSchema + 1,
      contractPhaseDone: true,
    };
    next = appendHistory(
      next,
      "schema_contract_applied",
      {
        localSchema: next.localSchema,
      },
      now,
    );
  }
  next = appendHistory(
    next,
    "switch_active",
    {
      active: next.activeSlot,
      version,
    },
    now,
  );
  return { ok: true, switched: true, state: next };
}

/**
 * Install candidate into standby slot, run health gate, switch or revert.
 * Pure state transition (D5 skeleton; no autoUpdater I/O).
 */
export function installStandby(state: UpgradeState, input: InstallInput): InstallResult {
  const now = input.now ?? (() => new Date().toISOString());

  if (isBelowMinSecure(input.version, state.minSecureVersion)) {
    return rejectInstall(
      state,
      "below_min_secure_version",
      "install_rejected_anti_rollback",
      { version: input.version },
      now,
    );
  }
  if (!state.queueEmpty) {
    return rejectInstall(
      state,
      "queue_not_empty",
      "install_rejected_queue_not_empty",
      undefined,
      now,
    );
  }

  const standby = standbySlot(state.activeSlot);
  const staged = placeOnStandby(state, standby, input.version, input.health, now);
  if (!isHealthPassing(input.health)) {
    return revertStandby(staged, standby, now);
  }
  return promoteStandby(staged, standby, input.version, input.applyContract, now);
}

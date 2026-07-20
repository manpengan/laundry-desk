import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  cmpVersion,
  log,
  saveState,
  slotPath,
  standbyName,
  takeSnapshot,
} from "./drill-state.mjs";

function reject(state, statePath, event, body) {
  log(state, event, body);
  saveState(statePath, state);
  console.log(JSON.stringify({ ok: false, ...body }));
  process.exitCode = 1;
}

function writeStandby(slotsDir, state, standby, version) {
  writeFileSync(join(slotPath(slotsDir, standby), "VERSION"), version);
  writeFileSync(
    join(slotPath(slotsDir, standby), "db.spike"),
    readFileSync(join(slotPath(slotsDir, state.activeSlot), "db.spike")),
  );
}

function onHealthFail(slotsDir, state, statePath, standby) {
  state.mode = "REVERT_STANDBY";
  state.slots[standby].version = null;
  state.slots[standby].healthy = false;
  rmSync(join(slotPath(slotsDir, standby), "VERSION"), { force: true });
  state.primaryLeaseIssuanceBlocked = false;
  log(state, "health_fail_keep_active", { active: state.activeSlot });
  saveState(statePath, state);
  console.log(
    JSON.stringify({
      ok: true,
      switched: false,
      activeSlot: state.activeSlot,
      reason: "health_check_failed",
    }, null, 2),
  );
}

function onHealthPass(slotsDir, state, statePath, standby, version, flags) {
  if (flags.migrate === "contract") {
    state.localSchema += 1;
    state.contractPhaseDone = true;
    writeFileSync(
      join(slotPath(slotsDir, standby), "db.spike"),
      `schema=${state.localSchema};queue_envelope_version=1;encrypted=1;contract=1\n`,
    );
  }
  state.activeSlot = standby;
  state.mode = "ACTIVE";
  state.primaryLeaseIssuanceBlocked = false;
  log(state, "switch_active", { active: state.activeSlot, version });
  saveState(statePath, state);
  console.log(
    JSON.stringify({
      ok: true,
      switched: true,
      activeSlot: state.activeSlot,
      version,
      localSchema: state.localSchema,
      contractPhaseDone: state.contractPhaseDone,
    }, null, 2),
  );
}

/** Install into standby; health fail keeps active (ADR-08). */
export function cmdInstall(ctx, flags) {
  const { slotsDir, statePath, state } = ctx;
  const version = flags.version || "2.0.0";
  const health = (flags.health || "pass") === "pass";

  if (cmpVersion(version, state.minSecureVersion) < 0) {
    return reject(state, statePath, "install_rejected_anti_rollback", {
      error: "below_min_secure_version",
      version,
      minSecureVersion: state.minSecureVersion,
    });
  }
  if (!state.queueEmpty) {
    return reject(state, statePath, "install_rejected_queue_not_empty", {
      error: "queue_not_empty",
    });
  }

  state.primaryLeaseIssuanceBlocked = true;
  const standby = standbyName(state);
  takeSnapshot(slotsDir, state);
  writeStandby(slotsDir, state, standby, version);
  state.slots[standby] = { version, healthy: health };
  log(state, "install_standby", { standby, version, health });

  if (!health) return onHealthFail(slotsDir, state, statePath, standby);
  return onHealthPass(slotsDir, state, statePath, standby, version, flags);
}

#!/usr/bin/env node
/**
 * A/B slot + snapshot + support-matrix rollback drill (filesystem simulation).
 * No production autoUpdater — pure state machine evidence for M0-4.
 */
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  cpSync,
  readdirSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const root = dirname(fileURLToPath(import.meta.url));
const slotsDir = join(root, "slots");
const statePath = join(slotsDir, "state.json");
const matrixPath = join(root, "support-matrix.sample.json");
const MIN_SECURE_VERSION = "1.8.0";

function defaultState() {
  return {
    activeSlot: "A",
    slots: {
      A: { version: "1.9.0", healthy: true },
      B: { version: null, healthy: false },
    },
    queueEmpty: true,
    primaryLeaseIssuanceBlocked: false,
    localSchema: 3,
    contractPhaseDone: false,
    minSecureVersion: MIN_SECURE_VERSION,
    mode: "ACTIVE",
    history: [],
  };
}

function loadState() {
  if (!existsSync(statePath)) return defaultState();
  return JSON.parse(readFileSync(statePath, "utf8"));
}

function saveState(state) {
  mkdirSync(slotsDir, { recursive: true });
  writeFileSync(statePath, JSON.stringify(state, null, 2));
}

function log(state, event, detail = {}) {
  state.history.push({ at: new Date().toISOString(), event, ...detail });
}

function slotPath(name) {
  return join(slotsDir, name);
}

function ensureLayout() {
  mkdirSync(join(slotsDir, "A"), { recursive: true });
  mkdirSync(join(slotsDir, "B"), { recursive: true });
  mkdirSync(join(slotsDir, "snapshots"), { recursive: true });
  if (!existsSync(statePath)) {
    const s = defaultState();
    writeFileSync(join(slotPath("A"), "VERSION"), s.slots.A.version);
    writeFileSync(
      join(slotPath("A"), "db.spike"),
      "schema=3;queue_envelope_version=1;encrypted=1\n",
    );
    saveState(s);
  }
}

function cmpVersion(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

function parseArgs(argv) {
  const cmd = argv[2] || "status";
  const flags = {};
  for (let i = 3; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
      flags[key] = val;
    }
  }
  return { cmd, flags };
}

function standbyName(state) {
  return state.activeSlot === "A" ? "B" : "A";
}

function cmdInit() {
  if (existsSync(slotsDir)) {
    rmSync(slotsDir, { recursive: true, force: true });
  }
  ensureLayout();
  const state = loadState();
  log(state, "init");
  saveState(state);
  console.log(JSON.stringify({ ok: true, state }, null, 2));
}

function cmdSnapshot() {
  ensureLayout();
  const state = loadState();
  const active = state.activeSlot;
  const src = join(slotPath(active), "db.spike");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = join(slotsDir, "snapshots", `${stamp}-${active}.db.spike`);
  cpSync(src, dest);
  const hash = createHash("sha256").update(readFileSync(dest)).digest("hex");
  log(state, "snapshot", { dest, hash });
  saveState(state);
  console.log(JSON.stringify({ ok: true, dest, hash }, null, 2));
}

function cmdRestore() {
  ensureLayout();
  const state = loadState();
  const snaps = readdirSync(join(slotsDir, "snapshots")).sort();
  if (snaps.length === 0) {
    console.log(JSON.stringify({ ok: false, error: "no_snapshot" }));
    process.exitCode = 1;
    return;
  }
  const latest = snaps[snaps.length - 1];
  const src = join(slotsDir, "snapshots", latest);
  const active = state.activeSlot;
  cpSync(src, join(slotPath(active), "db.spike"));
  log(state, "restore_snapshot", { latest, active });
  saveState(state);
  console.log(JSON.stringify({ ok: true, restored: latest, active }, null, 2));
}

function cmdInstall(flags) {
  ensureLayout();
  const state = loadState();
  const version = flags.version || "2.0.0";
  const health = (flags.health || "pass") === "pass";

  if (cmpVersion(version, state.minSecureVersion) < 0) {
    log(state, "install_rejected_anti_rollback", { version });
    saveState(state);
    console.log(
      JSON.stringify({
        ok: false,
        error: "below_min_secure_version",
        version,
        minSecureVersion: state.minSecureVersion,
      }),
    );
    process.exitCode = 1;
    return;
  }

  if (!state.queueEmpty) {
    log(state, "install_rejected_queue_not_empty");
    saveState(state);
    console.log(JSON.stringify({ ok: false, error: "queue_not_empty" }));
    process.exitCode = 1;
    return;
  }

  state.primaryLeaseIssuanceBlocked = true;
  const standby = standbyName(state);
  // snapshot first
  cmdSnapshotInternal(state);
  writeFileSync(join(slotPath(standby), "VERSION"), version);
  writeFileSync(
    join(slotPath(standby), "db.spike"),
    readFileSync(join(slotPath(state.activeSlot), "db.spike")),
  );
  state.slots[standby] = { version, healthy: health };
  log(state, "install_standby", { standby, version, health });

  if (!health) {
    state.mode = "REVERT_STANDBY";
    state.slots[standby].version = null;
    state.slots[standby].healthy = false;
    rmSync(join(slotPath(standby), "VERSION"), { force: true });
    state.primaryLeaseIssuanceBlocked = false;
    log(state, "health_fail_keep_active", { active: state.activeSlot });
    saveState(state);
    console.log(
      JSON.stringify({
        ok: true,
        switched: false,
        activeSlot: state.activeSlot,
        reason: "health_check_failed",
      }, null, 2),
    );
    return;
  }

  // optional schema expand (not contract) on success path demo
  if (flags.migrate === "contract") {
    state.localSchema += 1;
    state.contractPhaseDone = true;
    writeFileSync(
      join(slotPath(standby), "db.spike"),
      `schema=${state.localSchema};queue_envelope_version=1;encrypted=1;contract=1\n`,
    );
  }

  state.activeSlot = standby;
  state.mode = "ACTIVE";
  state.primaryLeaseIssuanceBlocked = false;
  log(state, "switch_active", { active: state.activeSlot, version });
  saveState(state);
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

function cmdSnapshotInternal(state) {
  const active = state.activeSlot;
  const src = join(slotPath(active), "db.spike");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = join(slotsDir, "snapshots", `${stamp}-${active}.db.spike`);
  mkdirSync(join(slotsDir, "snapshots"), { recursive: true });
  cpSync(src, dest);
  log(state, "snapshot", { dest });
}

function matrixAllowsRollback(state, targetVersion) {
  const matrix = JSON.parse(readFileSync(matrixPath, "utf8"));
  const row = matrix.rows.find(
    (r) => r.edge === state.slots[state.activeSlot].version,
  );
  if (!row) {
    // Fall back to explicit flag semantics
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

function cmdRollback(flags) {
  ensureLayout();
  const state = loadState();
  const other = standbyName(state);
  const targetVersion =
    flags.to || state.slots[other].version || "1.9.0";

  if (cmpVersion(targetVersion, state.minSecureVersion) < 0) {
    console.log(
      JSON.stringify({ ok: false, error: "anti_rollback_min_secure_version" }),
    );
    process.exitCode = 1;
    return;
  }

  const forced = flags["matrix-compatible"];
  let decision;
  if (forced === "true") {
    decision = { allowed: true, reason: "flag_matrix_compatible_true" };
  } else if (forced === "false") {
    decision = { allowed: false, reason: "flag_matrix_compatible_false" };
  } else {
    decision = matrixAllowsRollback(state, targetVersion);
  }

  if (!decision.allowed) {
    state.mode = "RECOVERY_MODE";
    log(state, "rollback_blocked_enter_recovery", {
      reason: decision.reason,
      targetVersion,
    });
    saveState(state);
    console.log(
      JSON.stringify({
        ok: false,
        mode: "RECOVERY_MODE",
        capabilities: ["print_only", "read_only"],
        reason: decision.reason,
      }, null, 2),
    );
    process.exitCode = 2;
    return;
  }

  // perform slot switch back
  if (!state.slots[other].version) {
    state.slots[other] = { version: targetVersion, healthy: true };
    writeFileSync(join(slotPath(other), "VERSION"), targetVersion);
  }
  state.activeSlot = other;
  state.mode = "ACTIVE";
  log(state, "rollback_switch", {
    active: state.activeSlot,
    version: state.slots[other].version,
  });
  saveState(state);
  console.log(
    JSON.stringify({
      ok: true,
      mode: "ACTIVE",
      activeSlot: state.activeSlot,
      version: state.slots[state.activeSlot].version,
    }, null, 2),
  );
}

function cmdStatus() {
  ensureLayout();
  const state = loadState();
  console.log(JSON.stringify(state, null, 2));
}

function cmdSetQueue(flags) {
  ensureLayout();
  const state = loadState();
  state.queueEmpty = flags.empty !== "false";
  log(state, "set_queue_empty", { queueEmpty: state.queueEmpty });
  saveState(state);
  console.log(JSON.stringify({ ok: true, queueEmpty: state.queueEmpty }));
}

function main() {
  const { cmd, flags } = parseArgs(process.argv);
  switch (cmd) {
    case "init":
      return cmdInit();
    case "status":
      return cmdStatus();
    case "snapshot":
      return cmdSnapshot();
    case "restore-snapshot":
      return cmdRestore();
    case "install-standby":
      return cmdInstall(flags);
    case "rollback":
      return cmdRollback(flags);
    case "set-queue":
      return cmdSetQueue(flags);
    default:
      console.error(
        "usage: drill.mjs <init|status|snapshot|restore-snapshot|install-standby|rollback|set-queue>",
      );
      process.exitCode = 1;
  }
}

main();

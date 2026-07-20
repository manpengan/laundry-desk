#!/usr/bin/env node
/**
 * A/B slot + snapshot + support-matrix rollback drill (filesystem simulation).
 * No production autoUpdater — pure state machine evidence for M0-4 / D5.
 * Install/rollback bodies split (function ≤50 line redline).
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cmdInstall } from "./drill-install.mjs";
import { cmdRollback } from "./drill-rollback.mjs";
import {
  ensureLayout,
  loadState,
  log,
  resetSlotsDir,
  restoreLatestSnapshot,
  saveState,
  takeSnapshot,
} from "./drill-state.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const slotsDir = join(root, "slots");
const statePath = join(slotsDir, "state.json");
const matrixPath = join(root, "support-matrix.sample.json");

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

function loadCtx() {
  ensureLayout(slotsDir, statePath);
  return {
    slotsDir,
    statePath,
    matrixPath,
    state: loadState(statePath),
  };
}

function cmdInit() {
  resetSlotsDir(slotsDir);
  ensureLayout(slotsDir, statePath);
  const state = loadState(statePath);
  log(state, "init");
  saveState(statePath, state);
  console.log(JSON.stringify({ ok: true, state }, null, 2));
}

function cmdSnapshot() {
  const ctx = loadCtx();
  const snap = takeSnapshot(ctx.slotsDir, ctx.state);
  saveState(ctx.statePath, ctx.state);
  console.log(JSON.stringify({ ok: true, ...snap }, null, 2));
}

function cmdRestore() {
  const ctx = loadCtx();
  const result = restoreLatestSnapshot(ctx.slotsDir, ctx.state);
  if (!result.ok) {
    console.log(JSON.stringify(result));
    process.exitCode = 1;
    return;
  }
  saveState(ctx.statePath, ctx.state);
  console.log(JSON.stringify(result, null, 2));
}

function cmdStatus() {
  const ctx = loadCtx();
  console.log(JSON.stringify(ctx.state, null, 2));
}

function cmdSetQueue(flags) {
  const ctx = loadCtx();
  ctx.state.queueEmpty = flags.empty !== "false";
  log(ctx.state, "set_queue_empty", { queueEmpty: ctx.state.queueEmpty });
  saveState(ctx.statePath, ctx.state);
  console.log(JSON.stringify({ ok: true, queueEmpty: ctx.state.queueEmpty }));
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
      return cmdInstall(loadCtx(), flags);
    case "rollback":
      return cmdRollback(loadCtx(), flags);
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

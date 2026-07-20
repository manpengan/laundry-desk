/**
 * Shared FS state helpers for A/B drill CLI (M0-4 spike / M1 tech-debt split).
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
import { createHash } from "node:crypto";

export const MIN_SECURE_VERSION = "1.8.0";

export function defaultState() {
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

export function loadState(statePath) {
  if (!existsSync(statePath)) return defaultState();
  return JSON.parse(readFileSync(statePath, "utf8"));
}

export function saveState(statePath, state) {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify(state, null, 2));
}

export function log(state, event, detail = {}) {
  state.history.push({ at: new Date().toISOString(), event, ...detail });
}

export function slotPath(slotsDir, name) {
  return join(slotsDir, name);
}

export function ensureLayout(slotsDir, statePath) {
  mkdirSync(join(slotsDir, "A"), { recursive: true });
  mkdirSync(join(slotsDir, "B"), { recursive: true });
  mkdirSync(join(slotsDir, "snapshots"), { recursive: true });
  if (!existsSync(statePath)) {
    const s = defaultState();
    writeFileSync(join(slotPath(slotsDir, "A"), "VERSION"), s.slots.A.version);
    writeFileSync(
      join(slotPath(slotsDir, "A"), "db.spike"),
      "schema=3;queue_envelope_version=1;encrypted=1\n",
    );
    saveState(statePath, s);
  }
}

export function cmpVersion(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

export function standbyName(state) {
  return state.activeSlot === "A" ? "B" : "A";
}

export function takeSnapshot(slotsDir, state) {
  const active = state.activeSlot;
  const src = join(slotPath(slotsDir, active), "db.spike");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = join(slotsDir, "snapshots", `${stamp}-${active}.db.spike`);
  mkdirSync(join(slotsDir, "snapshots"), { recursive: true });
  cpSync(src, dest);
  const hash = createHash("sha256").update(readFileSync(dest)).digest("hex");
  log(state, "snapshot", { dest, hash });
  return { dest, hash };
}

export function restoreLatestSnapshot(slotsDir, state) {
  const snaps = readdirSync(join(slotsDir, "snapshots")).sort();
  if (snaps.length === 0) return { ok: false, error: "no_snapshot" };
  const latest = snaps[snaps.length - 1];
  const src = join(slotsDir, "snapshots", latest);
  cpSync(src, join(slotPath(slotsDir, state.activeSlot), "db.spike"));
  log(state, "restore_snapshot", { latest, active: state.activeSlot });
  return { ok: true, restored: latest, active: state.activeSlot };
}

export function resetSlotsDir(slotsDir) {
  if (existsSync(slotsDir)) {
    rmSync(slotsDir, { recursive: true, force: true });
  }
}

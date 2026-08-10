import { fail } from "./hk-vps-release-core.mjs";
import { persistTransition, updateTransition } from "./hk-vps-release-remote-support.mjs";
import {
  activateDatabaseWriteGate,
  inspectDatabaseWriteGate,
  releaseDatabaseWriteGate,
} from "./hk-vps-release-write-gate.mjs";

export async function persistWriteGateIntent(record, signal, dependencies = {}) {
  if (
    record.phase !== "staged" ||
    record.write_gate_state !== null ||
    record.app_role_original_can_login !== null
  ) {
    fail("CLOUD_RELEASE_WRITE_GATE_PHASE_INVALID");
  }
  await (dependencies.inspectWriteGate ?? inspectDatabaseWriteGate)(signal);
  const next = updateTransition(record, {
    app_role_original_can_login: true,
    write_gate_state: "intent",
  });
  await (dependencies.persistTransition ?? persistTransition)(next);
  return next;
}

export async function releasePersistedWriteGate(record, signal, dependencies = {}) {
  if (record.write_gate_state === null) return record;
  if (record.app_role_original_can_login !== true) {
    fail("CLOUD_RELEASE_WRITE_GATE_PHASE_INVALID");
  }
  await (dependencies.releaseWriteGate ?? releaseDatabaseWriteGate)(signal);
  const phase = ["write_frozen", "recovery_ready", "migrating"].includes(record.phase)
    ? "recovery_required"
    : record.phase;
  const next = updateTransition(record, { phase, write_gate_state: "released" });
  await (dependencies.persistTransition ?? persistTransition)(next);
  return next;
}

export async function activatePersistedRecoveryWriteGate(record, signal, dependencies = {}) {
  if (record.app_role_original_can_login !== true) {
    fail("CLOUD_RELEASE_WRITE_GATE_PHASE_INVALID");
  }
  const persist = dependencies.persistTransition ?? persistTransition;
  const intent = updateTransition(record, {
    phase: "recovery_required",
    verification_evidence_authoritative: record.verification_evidence_path === null ? null : false,
    write_gate_state: "intent",
  });
  await persist(intent);
  await (dependencies.activateWriteGate ?? activateDatabaseWriteGate)(signal);
  const active = updateTransition(intent, { write_gate_state: "active" });
  await persist(active);
  return active;
}

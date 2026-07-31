import { isAbsolute } from "node:path";

import { readManagedJson } from "./support-bundle-safety.mjs";

const PRIVATE_SOURCE_BYTES = 512 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-9a-f][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const HASH = /^[0-9a-f]{64}$/u;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const SEMVER = /^(?:0|[1-9]\d{0,12})\.(?:0|[1-9]\d{0,12})\.(?:0|[1-9]\d{0,12})$/u;
const ARTIFACT =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-9a-f][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-(?:xp58|dl206|gp3120)-[0-9]{4}\.txt$/u;
const CUPS_JOB = /^[A-Za-z0-9_.-]{1,128}-\d+$/u;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;
const UPDATE_EVENTS = new Set([
  "state_initialized",
  "slot_activated",
  "security_floor_raised",
  "activation_confirmed",
  "activation_rolled_back",
  "security_floor_recovery_required",
]);

const unavailable = (code) => Object.freeze({ status: "unavailable", code });

const isPlainObject = (value) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

function hasExactKeys(value, expected) {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

const isNonnegativeInteger = (value) => Number.isSafeInteger(value) && value >= 0;

function parseQueue(value) {
  if (
    !hasExactKeys(value, ["version", "rows"]) ||
    value.version !== 1 ||
    !Array.isArray(value.rows) ||
    value.rows.length > 10_000
  ) {
    throw new Error("invalid queue");
  }
  const ids = new Set();
  const sequences = new Set();
  let pending = 0;
  let inflight = 0;
  for (const row of value.rows) {
    if (
      !hasExactKeys(row, ["id", "seq", "sealed_payload", "aad", "state"]) ||
      typeof row.id !== "string" ||
      !UUID.test(row.id) ||
      !Number.isSafeInteger(row.seq) ||
      row.seq < 1 ||
      typeof row.sealed_payload !== "string" ||
      row.sealed_payload.length > PRIVATE_SOURCE_BYTES ||
      !BASE64.test(row.sealed_payload) ||
      Buffer.from(row.sealed_payload, "base64").toString("base64") !== row.sealed_payload ||
      typeof row.aad !== "string" ||
      row.aad.length < 1 ||
      row.aad.length > 512 ||
      (row.state !== "pending" && row.state !== "inflight") ||
      ids.has(row.id) ||
      sequences.has(row.seq)
    ) {
      throw new Error("invalid queue");
    }
    ids.add(row.id);
    sequences.add(row.seq);
    if (row.state === "pending") pending += 1;
    else inflight += 1;
  }
  return Object.freeze({
    status: "ok",
    file_status: "valid",
    pending_count: pending,
    inflight_count: inflight,
  });
}

export async function collectEdgeQueue(context) {
  try {
    return parseQueue(
      await readManagedJson(context.edgeStateRoot, "offline-queue.json", PRIVATE_SOURCE_BYTES),
    );
  } catch {
    return unavailable("EDGE_QUEUE_UNAVAILABLE");
  }
}

function parseCups(value) {
  if (
    !hasExactKeys(value, ["version", "records"]) ||
    value.version !== 1 ||
    !Array.isArray(value.records) ||
    value.records.length > 2_000
  ) {
    throw new Error("invalid CUPS state");
  }
  let submitted = 0;
  let uncertain = 0;
  const artifacts = new Set();
  for (const record of value.records) {
    if (
      !hasExactKeys(record, ["artifact", "sha256", "state", "cups_job_id", "updated_at"]) ||
      typeof record.artifact !== "string" ||
      !ARTIFACT.test(record.artifact) ||
      typeof record.sha256 !== "string" ||
      !HASH.test(record.sha256) ||
      (record.state !== "submitting" && record.state !== "submitted") ||
      (record.cups_job_id !== null &&
        (typeof record.cups_job_id !== "string" || !CUPS_JOB.test(record.cups_job_id))) ||
      !isNonnegativeInteger(record.updated_at) ||
      artifacts.has(record.artifact)
    ) {
      throw new Error("invalid CUPS state");
    }
    artifacts.add(record.artifact);
    if (record.state === "submitting") uncertain += 1;
    else submitted += 1;
  }
  return Object.freeze({
    status: "ok",
    file_status: "valid",
    submitted_count: submitted,
    uncertain_count: uncertain,
    uncertain: uncertain > 0,
  });
}

export async function collectCups(context) {
  try {
    return parseCups(
      await readManagedJson(
        context.edgeUserDataRoot,
        "cups-worker-state.json",
        PRIVATE_SOURCE_BYTES,
      ),
    );
  } catch {
    return unavailable("CUPS_STATE_UNAVAILABLE");
  }
}

function validSlot(slot) {
  return (
    hasExactKeys(slot, ["version", "app_path", "artifact_sha256", "healthy"]) &&
    (slot.version === null || (typeof slot.version === "string" && SEMVER.test(slot.version))) &&
    (slot.app_path === null ||
      (typeof slot.app_path === "string" &&
        isAbsolute(slot.app_path) &&
        slot.app_path.length <= 4_096)) &&
    (slot.artifact_sha256 === null ||
      (typeof slot.artifact_sha256 === "string" && HASH.test(slot.artifact_sha256))) &&
    typeof slot.healthy === "boolean"
  );
}

function validPending(pending) {
  return (
    pending === null ||
    (hasExactKeys(pending, ["slot", "previous_slot", "nonce", "started_at", "launch_started"]) &&
      ["A", "B"].includes(pending.slot) &&
      ["A", "B"].includes(pending.previous_slot) &&
      pending.slot !== pending.previous_slot &&
      typeof pending.nonce === "string" &&
      UUID.test(pending.nonce) &&
      typeof pending.started_at === "string" &&
      ISO_TIMESTAMP.test(pending.started_at) &&
      Number.isFinite(Date.parse(pending.started_at)) &&
      typeof pending.launch_started === "boolean")
  );
}

function validHistory(history) {
  return (
    Array.isArray(history) &&
    history.length <= 200 &&
    history.every(
      (entry) =>
        isPlainObject(entry) &&
        Object.keys(entry).every((key) => ["at", "event", "slot", "version"].includes(key)) &&
        Object.keys(entry).includes("at") &&
        Object.keys(entry).includes("event") &&
        typeof entry.at === "string" &&
        ISO_TIMESTAMP.test(entry.at) &&
        Number.isFinite(Date.parse(entry.at)) &&
        typeof entry.event === "string" &&
        UPDATE_EVENTS.has(entry.event) &&
        (!("slot" in entry) || ["A", "B"].includes(entry.slot)) &&
        (!("version" in entry) ||
          (typeof entry.version === "string" && SEMVER.test(entry.version))),
    )
  );
}

function parseUpdateState(value) {
  if (
    !hasExactKeys(value, [
      "version",
      "active_slot",
      "slots",
      "minimum_secure_version",
      "pending_activation",
      "history",
    ]) ||
    value.version !== 1 ||
    !["A", "B"].includes(value.active_slot) ||
    !hasExactKeys(value.slots, ["A", "B"]) ||
    !validSlot(value.slots.A) ||
    !validSlot(value.slots.B) ||
    typeof value.minimum_secure_version !== "string" ||
    !SEMVER.test(value.minimum_secure_version) ||
    !validPending(value.pending_activation) ||
    !validHistory(value.history)
  ) {
    throw new Error("invalid update state");
  }
  return Object.freeze({
    status: "ok",
    version: value.version,
    active_slot: value.active_slot,
    slots: Object.freeze({
      A: Object.freeze({ version: value.slots.A.version, healthy: value.slots.A.healthy }),
      B: Object.freeze({ version: value.slots.B.version, healthy: value.slots.B.healthy }),
    }),
    minimum_secure_version: value.minimum_secure_version,
    pending_activation: value.pending_activation !== null,
    history_events: Object.freeze(value.history.map((entry) => entry.event)),
  });
}

export async function collectUpdateState(context) {
  try {
    return parseUpdateState(
      await readManagedJson(context.updateRoot, "update-state.json", PRIVATE_SOURCE_BYTES),
    );
  } catch {
    return unavailable("UPDATE_STATE_UNAVAILABLE");
  }
}

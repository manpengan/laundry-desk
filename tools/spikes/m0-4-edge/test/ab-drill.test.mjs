import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const drill = join(root, "ab-upgrade/drill.mjs");

function run(args) {
  const r = spawnSync(process.execPath, [drill, ...args], {
    encoding: "utf8",
    cwd: root,
  });
  return {
    status: r.status,
    json: JSON.parse(r.stdout || "null"),
    stderr: r.stderr,
  };
}

describe("A/B upgrade drill", () => {
  before(() => {
    run(["init"]);
  });

  it("rejects install when queue not empty", () => {
    run(["set-queue", "--empty", "false"]);
    const r = run(["install-standby", "--health", "pass", "--version", "2.0.0"]);
    assert.equal(r.status, 1);
    assert.equal(r.json.error, "queue_not_empty");
    run(["set-queue", "--empty", "true"]);
  });

  it("keeps active slot when health check fails", () => {
    run(["init"]);
    const r = run(["install-standby", "--health", "fail", "--version", "2.0.0"]);
    assert.equal(r.status, 0);
    assert.equal(r.json.switched, false);
    assert.equal(r.json.activeSlot, "A");
  });

  it("switches on health pass", () => {
    run(["init"]);
    const r = run(["install-standby", "--health", "pass", "--version", "2.0.0"]);
    assert.equal(r.status, 0);
    assert.equal(r.json.switched, true);
    assert.equal(r.json.activeSlot, "B");
  });

  it("blocks rollback when matrix incompatible → recovery mode", () => {
    run(["init"]);
    run(["install-standby", "--health", "pass", "--version", "2.1.0", "--migrate", "contract"]);
    const r = run(["rollback", "--matrix-compatible", "false"]);
    assert.equal(r.status, 2);
    assert.equal(r.json.mode, "RECOVERY_MODE");
    assert.deepEqual(r.json.capabilities, ["print_only", "read_only"]);
  });

  it("allows rollback when matrix compatible (forced flag)", () => {
    run(["init"]);
    run(["install-standby", "--health", "pass", "--version", "2.0.0"]);
    const r = run(["rollback", "--matrix-compatible", "true", "--to", "1.9.0"]);
    assert.equal(r.status, 0);
    assert.equal(r.json.mode, "ACTIVE");
  });

  it("bare rollback uses support-matrix row (2.0.0 → 1.9.0 allowed)", () => {
    run(["init"]);
    run(["install-standby", "--health", "pass", "--version", "2.0.0"]);
    // no --matrix-compatible flag — must read support-matrix.sample.json
    const r = run(["rollback"]);
    assert.equal(r.status, 0);
    assert.equal(r.json.mode, "ACTIVE");
    assert.equal(r.json.version, "1.9.0");
  });

  it("bare rollback enters recovery when matrix forbids (2.1.0 contract)", () => {
    run(["init"]);
    run([
      "install-standby",
      "--health",
      "pass",
      "--version",
      "2.1.0",
      "--migrate",
      "contract",
    ]);
    const r = run(["rollback"]);
    assert.equal(r.status, 2);
    assert.equal(r.json.mode, "RECOVERY_MODE");
  });

  it("anti-rollback rejects below min secure version", () => {
    run(["init"]);
    const r = run(["install-standby", "--health", "pass", "--version", "1.0.0"]);
    assert.equal(r.status, 1);
    assert.equal(r.json.error, "below_min_secure_version");
  });

  it("snapshot restore returns matching bytes after corruption", () => {
    run(["init"]);
    const snap = run(["snapshot"]);
    assert.equal(snap.status, 0);
    const slots = join(root, "ab-upgrade/slots");
    const activeDb = join(slots, "A/db.spike");
    const before = createHash("sha256")
      .update(readFileSync(activeDb))
      .digest("hex");
    writeFileSync(activeDb, "CORRUPTED-BY-TEST");
    const restored = run(["restore-snapshot"]);
    assert.equal(restored.status, 0);
    const after = createHash("sha256")
      .update(readFileSync(activeDb))
      .digest("hex");
    assert.equal(after, before);
    assert.notEqual(readFileSync(activeDb, "utf8"), "CORRUPTED-BY-TEST");
    assert.ok(readdirSync(join(slots, "snapshots")).length >= 1);
  });
});

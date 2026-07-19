import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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

  it("allows rollback when matrix compatible", () => {
    run(["init"]);
    run(["install-standby", "--health", "pass", "--version", "2.0.0"]);
    const r = run(["rollback", "--matrix-compatible", "true", "--to", "1.9.0"]);
    assert.equal(r.status, 0);
    assert.equal(r.json.mode, "ACTIVE");
  });

  it("anti-rollback rejects below min secure version", () => {
    run(["init"]);
    const r = run(["install-standby", "--health", "pass", "--version", "1.0.0"]);
    assert.equal(r.status, 1);
    assert.equal(r.json.error, "below_min_secure_version");
  });
});

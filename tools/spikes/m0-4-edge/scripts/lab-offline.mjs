#!/usr/bin/env node
/**
 * Offline / no-Windows lab entry: tests + cert + A/B drills + snapshot restore.
 * Does not launch Electron or require a physical Windows host.
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const drill = join(root, "ab-upgrade/drill.mjs");

function run(label, args, opts = {}) {
  console.log(`\n>> ${label}`);
  const r = spawnSync(process.execPath, args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.status !== 0 && !opts.allowFail) {
    console.error(`FAIL: ${label} exit=${r.status}`);
    process.exit(r.status ?? 1);
  }
  return r;
}

function sha(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

console.log("=== M0-4 offline lab (no Windows required) ===");
console.log(`platform=${process.platform} node=${process.version}`);

run("unit tests", [
  "--test",
  join(root, "test/ab-drill.test.mjs"),
  join(root, "test/channel-validate.test.mjs"),
]);

run("generate cert", [join(root, "channel/generate-localhost-cert.mjs")]);

run("ab init", [drill, "init"]);
run("ab health-fail keep slot", [drill, "install-standby", "--health", "fail"]);
run("ab init2", [drill, "init"]);
run("ab health-pass switch", [drill, "install-standby", "--health", "pass"]);
run("ab bare matrix rollback", [drill, "rollback"]);

run("ab init3", [drill, "init"]);
run("snapshot", [drill, "snapshot"]);
const db = join(root, "ab-upgrade/slots/A/db.spike");
const before = sha(db);
writeFileSync(db, "CORRUPTED-BY-LAB");
run("restore", [drill, "restore-snapshot"]);
const after = sha(db);
if (before !== after) {
  console.error("snapshot restore hash mismatch", { before, after });
  process.exit(1);
}
console.log(`snapshot restore sha256 match: ${before.slice(0, 16)}…`);

run("ab init4", [drill, "init"]);
run("install 2.1 contract", [
  drill,
  "install-standby",
  "--health",
  "pass",
  "--version",
  "2.1.0",
  "--migrate",
  "contract",
]);
const blocked = run("bare rollback expect recovery", [drill, "rollback"], {
  allowFail: true,
});
if (blocked.status !== 2) {
  console.error("expected recovery mode exit 2, got", blocked.status);
  process.exit(1);
}

console.log("\n=== offline lab PASS ===");
console.log(
  "Deferred without Windows: firewall UX, enterprise AV, OS power-cycle cold start.",
);
console.log("Optional on this Mac: npm run wss + browser L1; Electron cold-start shell.");
console.log(
  `slots snaps: ${readdirSync(join(root, "ab-upgrade/slots/snapshots")).length}`,
);

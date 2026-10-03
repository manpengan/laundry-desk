import assert from "node:assert/strict";
import { link, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { backupFixture, release } from "./backup-test-fixture.mjs";
import { collectDiagnosticBundle } from "./diagnostic-bundle.mjs";
import { exportDiagnosticBundle, MAX_DIAGNOSTIC_EXPORTS } from "./diagnostic-export.mjs";
import { digest } from "./companion-contract.mjs";

async function fixture(t, phase = "running") {
  return {
    ...(await backupFixture(t)),
    state: {
      schema: 1,
      assurance: "development_only",
      phase,
      current: release,
      previous: null,
      controller: release,
      pending: null,
      releases: [release],
    },
    probe: async () => ({ api: true, postgres: true, task: true }),
  };
}

test("one-click export contains bounded metadata and a verifiable receipt without raw data", async (t) => {
  const context = await fixture(t);
  const secret = "SECRET_13800138000_customer@example.invalid";
  await writeFile(join(context.root, "unrelated-customer.json"), secret);
  await mkdir(join(context.root, "logs"), { mode: 0o700 });
  await writeFile(join(context.root, "logs/postgres.log"), secret);
  const reads = [];
  const receipt = await exportDiagnosticBundle({
    ...context,
    io: {
      ...context.io,
      read: async (path) => {
        reads.push(path);
        return context.io.read(path);
      },
    },
    probe: async () => ({ api: true, postgres: true, task: true, unsafe_detail: secret }),
  });
  const bytes = await readFile(receipt.path);
  const bundle = JSON.parse(bytes);
  assert.equal(receipt.status, "diagnostic_exported");
  assert.equal(receipt.sha256, digest(bytes));
  assert.equal(receipt.bytes, bytes.length);
  assert.ok(bytes.length < 256 * 1024);
  assert.equal(bytes.includes(Buffer.from(secret)), false);
  assert.equal(bytes.includes(Buffer.from(context.root)), false);
  assert.deepEqual(reads, []);
  assert.deepEqual(bundle.services.data, {
    api_port_open: true,
    postgres_port_open: true,
    task_present: true,
  });
  assert.equal(bundle.runtime.current.source, release.source);
  assert.equal(bundle.privacy.raw_logs, "excluded");
  await context.platform.inspectPrivateFile(receipt.path);
});

test("interrupted maintenance and unavailable services remain diagnosable without copying errors", async (t) => {
  const context = await fixture(t, "staged");
  await context.io.write(join(context.root, "maintenance.json"), "private-malformed-input");
  const receipt = await exportDiagnosticBundle({
    ...context,
    probe: async () => {
      throw new Error("postgres://secret@customer-host");
    },
  });
  const bytes = await readFile(receipt.path, "utf8");
  const bundle = JSON.parse(bytes);
  assert.deepEqual(bundle.services, { status: "unavailable" });
  assert.deepEqual(bundle.maintenance, { status: "unavailable" });
  assert.equal(bundle.runtime.phase, "staged");
  assert.doesNotMatch(bytes, /private-malformed|postgres:\/\//u);
  assert.equal(
    await readFile(join(context.root, "maintenance.json"), "utf8"),
    "private-malformed-input",
  );
});

test("backup metadata failures produce counts, without reading dump/photo contents", async (t) => {
  const context = await fixture(t);
  const directory = join(context.root, "backups", `b_${"a".repeat(32)}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, "backup.json"), "PII-secret", { mode: 0o600 });
  const bundle = await collectDiagnosticBundle(context);
  assert.deepEqual(bundle.backups, {
    status: "available",
    data: { count: 1, metadata_valid: 0, incomplete: 1 },
  });
  await writeFile(join(context.root, "backups", "customer-secret"), "anything");
  const invalid = await collectDiagnosticBundle(context);
  assert.deepEqual(invalid.backups, { status: "unavailable" });
  assert.doesNotMatch(JSON.stringify(invalid), /customer-secret|PII-secret/u);
});

test("diagnostic exports never overlay existing user files and stop at the bounded limit", async (t) => {
  const context = await fixture(t);
  const directory = join(context.root, "diagnostics");
  await context.io.directory(directory);
  for (let index = 0; index < MAX_DIAGNOSTIC_EXPORTS; index++)
    await writeFile(join(directory, `d_${index.toString(16).padStart(32, "0")}.json`), "existing", {
      mode: 0o600,
    });
  await assert.rejects(exportDiagnosticBundle(context), /DIAGNOSTIC_RETENTION_FULL/u);
  assert.equal((await readdir(directory)).length, MAX_DIAGNOSTIC_EXPORTS);
  assert.equal(await readFile(join(directory, `d_${"0".repeat(32)}.json`), "utf8"), "existing");
});

test("foreign names and hardlinks in export directories fail closed", async (t) => {
  const context = await fixture(t);
  const directory = join(context.root, "diagnostics");
  await context.io.directory(directory);
  await link(
    join(context.root, "secrets/access-token-secret"),
    join(directory, `d_${"a".repeat(32)}.json`),
  );
  await assert.rejects(exportDiagnosticBundle(context), /PRIVATE_FILE_INVALID/u);
  const other = await fixture(t);
  await other.io.directory(join(other.root, "diagnostics"));
  await writeFile(join(other.root, "diagnostics/foreign.json"), "preserve", { mode: 0o600 });
  await assert.rejects(exportDiagnosticBundle(other), /DIAGNOSTIC_DIRECTORY_INVALID/u);
});

test(
  "linked output directories cannot redirect diagnostic writes",
  { skip: process.platform === "win32" },
  async (t) => {
    const context = await fixture(t);
    const target = await fixture(t);
    await symlink(target.root, join(context.root, "diagnostics"));
    await assert.rejects(exportDiagnosticBundle(context), /DIRECTORY_INVALID/u);
    assert.deepEqual(await readdir(target.root), ["secrets"]);
  },
);

test("collection rejects unvalidated runtime state and non-boolean service claims", async (t) => {
  const context = await fixture(t);
  await assert.rejects(
    collectDiagnosticBundle({ ...context, state: { ...context.state, arbitrary: "PII" } }),
    /STATE_INVALID/u,
  );
  const bundle = await collectDiagnosticBundle({
    ...context,
    probe: async () => ({ api: "secret", postgres: true, task: true }),
  });
  assert.deepEqual(bundle.services, { status: "unavailable" });
});

import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

import { parseBackupArguments } from "./backup.mjs";
import {
  createDatabaseBackup,
  postgresDumpCommand,
  postgresRestoreCommand,
  verifyBackupFile,
} from "./data-tools.mjs";
import { parseRestoreArguments, runRestore } from "./restore.mjs";

const roots = [];
after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

test("backup and restore CLI arguments are closed and explicit", () => {
  assert.equal(parseBackupArguments([]), undefined);
  assert.throws(() => parseBackupArguments(["--output", "/tmp/x"]), /LOCAL_BACKUP_ARGS_INVALID/u);
  assert.deepEqual(
    parseRestoreArguments([
      "--file",
      "/private/backups/laundry.dump",
      "--confirm-sha256",
      "a".repeat(64),
    ]),
    {
      file: "/private/backups/laundry.dump",
      sha256: "a".repeat(64),
    },
  );
  assert.throws(() => parseRestoreArguments(["--file", "/tmp/x"]), /LOCAL_RESTORE_ARGS_INVALID/u);
});

test("PostgreSQL data commands use fixed argv and never carry a password", () => {
  const dump = postgresDumpCommand("laundry-ci-test");
  const restore = postgresRestoreCommand("laundry-ci-test");
  assert.equal(dump.file, "docker");
  assert.ok(dump.args.includes("pg_dump"));
  assert.ok(restore.args.includes("pg_restore"));
  assert.ok(restore.args.includes("--single-transaction"));
  assert.equal(dump.args.includes("--no-privileges"), false);
  assert.equal(restore.args.includes("--no-privileges"), false);
  assert.ok(dump.args.includes("--no-owner"));
  assert.ok(restore.args.includes("--no-owner"));
  assert.doesNotMatch(JSON.stringify([dump, restore]), /password|secret/iu);
});

test("creates a private dump with a bound manifest and verifies only that file", async () => {
  const root = await mkdtemp(join(tmpdir(), "laundry-data-tools-"));
  roots.push(root);
  const backupDirectory = join(root, "backups");
  await mkdir(backupDirectory, { mode: 0o700 });
  const context = Object.freeze({
    project: "laundry-ci-test",
    config: Object.freeze({ instanceId: "0123456789abcdefghijklmn" }),
    env: Object.freeze({ PATH: "/bin" }),
    backupDirectory,
  });
  const dependencies = Object.freeze({
    randomUUID: () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    now: () => new Date("2026-07-29T12:34:56.000Z"),
    stream: async (_command, options) => {
      writeSync(options.outputFd, Buffer.from("private-custom-dump"));
    },
  });

  const backup = await createDatabaseBackup(
    context,
    { cwd: "/workspace", kind: "backup" },
    dependencies,
  );

  assert.match(backup.path, /laundry-v2-backup-20260729T123456Z-aaaaaaaa\.dump$/u);
  assert.equal(backup.bytes, Buffer.byteLength("private-custom-dump"));
  assert.deepEqual(await verifyBackupFile(context, backup.path, backup.sha256), backup);
  await assert.rejects(
    () => verifyBackupFile(context, backup.path, "0".repeat(64)),
    /LOCAL_RESTORE_CHECKSUM_MISMATCH/u,
  );
  await assert.rejects(
    () => verifyBackupFile(context, join(root, "outside.dump"), backup.sha256),
    /LOCAL_RESTORE_FILE_FORBIDDEN/u,
  );
});

test("restore reconciles migrations and grants before restarting the server", async () => {
  const root = await mkdtemp(join(tmpdir(), "laundry-restore-order-"));
  roots.push(root);
  const sourcePath = join(root, "laundry-v2-backup-20260729T123456Z-aaaaaaaa.dump");
  await writeFile(sourcePath, "private-custom-dump", { mode: 0o600 });
  const calls = [];
  const context = Object.freeze({
    project: "laundry-ci-test",
    config: Object.freeze({ instanceId: "0123456789abcdefghijklmn" }),
    env: Object.freeze({ PATH: "/bin" }),
    backupDirectory: root,
  });
  const source = Object.freeze({ path: sourcePath, sha256: "a".repeat(64), bytes: 19 });
  const safetyBackup = Object.freeze({
    path: join(root, "pre-restore.dump"),
    sha256: "b".repeat(64),
    bytes: 19,
  });
  const dependencies = Object.freeze({
    prepareLocalDataContext: async () => context,
    verifyBackupFile: async () => source,
    createDatabaseBackup: async () => safetyBackup,
    run: async (command) => calls.push(command),
    stream: async (command) => calls.push(command),
  });

  await runRestore(
    {
      argv: ["--file", source.path, "--confirm-sha256", source.sha256],
      env: Object.freeze({}),
      cwd: "/workspace",
      stdout: () => undefined,
    },
    dependencies,
  );

  assert.deepEqual(
    calls.map((command) => {
      if (command.args.includes("pg_restore")) return "restore";
      if (command.args.includes("migrate")) return "migrate";
      if (command.args.includes("stop")) return "stop";
      if (command.args.includes("up")) return "up";
      return "unknown";
    }),
    ["stop", "restore", "migrate", "up"],
  );
  assert.ok(calls[2].args.includes("migrate"));
});

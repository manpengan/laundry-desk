import test from "node:test";
import assert from "node:assert/strict";
import {
  chmod,
  link,
  mkdir,
  open,
  readFile,
  readdir,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { digest } from "./companion-contract.mjs";
import { databaseTools } from "./backup-database.mjs";
import { backupFixture, release } from "./backup-test-fixture.mjs";
import {
  MAX_BACKUPS,
  MAX_DUMP_BYTES,
  requireBackupOptions,
  requireMaintenance,
} from "./backup-contract.mjs";
import {
  createBackup,
  readBackup,
  listBackups,
  withBackupDump,
  readMaintenance,
} from "./backup-files.mjs";

const bytes = Buffer.from("synthetic PostgreSQL custom dump");
const make = (context) => createBackup(context, (file) => file.writeFile(bytes));

test("private backups bind bytes, instance, migration and confirmation and contain no credentials", async (t) => {
  const context = await backupFixture(t);
  const backup = await make(context);
  assert.deepEqual(backup.manifest.database, { size: bytes.length, sha256: digest(bytes) });
  assert.deepEqual(await readdir(join(context.root, "backups", backup.id)), [
    "backup.json",
    "database.dump",
  ]);
  assert.equal((await readBackup(context, backup.id, backup.digest)).digest, backup.digest);
  assert.equal((await listBackups(context))[0].status, "verified");
  assert.equal(
    (await readFile(join(context.root, "backups", backup.id, "backup.json"), "utf8")).includes(
      "synthetic-instance-key",
    ),
    false,
  );
  await assert.rejects(readBackup(context, backup.id, "f".repeat(64)), /CONFIRMATION_MISMATCH/u);
  await assert.rejects(
    readBackup({ ...context, instance: "f".repeat(64) }, backup.id),
    /INSTANCE_MISMATCH/u,
  );
  for (const mutation of [{ migrations: "f".repeat(64) }, { migrationHead: "0070_other.sql" }])
    await assert.rejects(
      readBackup({ ...context, entry: { ...release, ...mutation } }, backup.id),
      /VERSION_MISMATCH/u,
    );
  await assert.rejects(
    readBackup({ ...context, postgresVersion: "16.16" }, backup.id),
    /VERSION_MISMATCH/u,
  );
});

test("corrupt dumps, unknown manifest fields, extra files and path escapes fail closed", async (t) => {
  const context = await backupFixture(t);
  const backup = await make(context);
  const directory = join(context.root, "backups", backup.id);
  await writeFile(backup.path, "tampered");
  await assert.rejects(readBackup(context, backup.id), /DUMP_MISMATCH/u);
  await writeFile(backup.path, bytes);
  await context.io.write(
    join(directory, "backup.json"),
    JSON.stringify({ ...backup.manifest, arbitrary_path: "escape" }),
  );
  await assert.rejects(readBackup(context, backup.id), /BACKUP_INVALID/u);
  await context.io.write(join(directory, "backup.json"), JSON.stringify(backup.manifest));
  await writeFile(join(directory, "extra.txt"), "extra");
  await assert.rejects(readBackup(context, backup.id), /FILE_SET_INVALID/u);
  for (const id of ["../escape", "B_" + "a".repeat(32), "b_" + "a".repeat(32) + ":stream"])
    await assert.rejects(readBackup(context, id), /ARGS_INVALID/u);
});

test("links and broad file permissions are rejected before reading a dump", async (t) => {
  const context = await backupFixture(t);
  const backup = await make(context);
  const original = join(context.root, "original");
  await writeFile(original, bytes, { mode: 0o600 });
  await unlink(backup.path);
  await link(original, backup.path);
  await assert.rejects(readBackup(context, backup.id), /PRIVATE_FILE_INVALID/u);
  await unlink(backup.path);
  if (process.platform !== "win32") {
    await symlink(original, backup.path);
    await assert.rejects(readBackup(context, backup.id), /PRIVATE_FILE_INVALID/u);
    await unlink(backup.path);
    await writeFile(backup.path, bytes, { mode: 0o644 });
    await assert.rejects(readBackup(context, backup.id), /PRIVATE_FILE_INVALID/u);
    await chmod(backup.path, 0o600);
  }
});

test("held dump handles detect replacement and in-place mutation during native restore", async (t) => {
  const context = await backupFixture(t);
  const backup = await make(context);
  await assert.rejects(
    withBackupDump(backup.path, context.platform, backup.manifest.database, async () => {
      await writeFile(backup.path, Buffer.alloc(bytes.length, 65));
    }),
    /DUMP_CHANGED/u,
  );
  await writeFile(backup.path, bytes);
  await assert.rejects(
    withBackupDump(backup.path, context.platform, backup.manifest.database, async () => {
      await unlink(backup.path);
      await writeFile(backup.path, bytes, { mode: 0o600 });
    }),
    /DUMP_CHANGED/u,
  );
});

test("incomplete backups remain visible; bounded retention never deletes an existing backup", async (t) => {
  const context = await backupFixture(t);
  const backup = await make(context);
  for (let index = 1; index < MAX_BACKUPS; index++)
    await mkdir(join(context.root, "backups", `b_${index.toString(16).padStart(32, "0")}`), {
      mode: 0o700,
    });
  const listed = await listBackups(context);
  assert.equal(listed.filter((item) => item.status === "incomplete").length, MAX_BACKUPS - 1);
  await assert.rejects(make(context), /RETENTION_FULL/u);
  assert.deepEqual(await readFile(backup.path), bytes);
});

test("oversized dumps are not published, including sparse files", async (t) => {
  const context = await backupFixture(t);
  await assert.rejects(
    createBackup(context, (file) => file.truncate(MAX_DUMP_BYTES + 1)),
    /DUMP_INVALID/u,
  );
  assert.equal((await listBackups(context))[0].status, "incomplete");
});

test("unknown backup directory entries and linked ancestors are never followed", async (t) => {
  const context = await backupFixture(t);
  const backup = await make(context);
  await writeFile(join(context.root, "backups", "unknown"), "extra");
  await assert.rejects(listBackups(context), /SET_INVALID/u);
  await unlink(join(context.root, "backups", "unknown"));
  await assert.rejects(readBackup(context, "b_" + "0".repeat(32)), /ENOENT/u);
  if (process.platform !== "win32") {
    const linked = join(context.root, "linked");
    await symlink(join(context.root, "backups"), linked);
    await assert.rejects(
      withBackupDump(join(linked, backup.id, "database.dump"), context.platform),
      /DIRECTORY_INVALID/u,
    );
  }
});

test("maintenance arguments and journals reject surplus authority and malformed identifiers", async (t) => {
  const id = "b_" + "a".repeat(32);
  const confirmation = "b".repeat(64);
  assert.doesNotThrow(() => requireBackupOptions("restore", { backupId: id, confirmation }));
  for (const [action, options] of [
    ["backup", { backupId: id }],
    ["restore", { backupId: id }],
    ["restore", { backupId: "../evil", confirmation }],
    ["backup-verify", { backupId: id, confirmation }],
    ["restore", { backupId: id, confirmation, target: "external" }],
  ])
    assert.throws(() => requireBackupOptions(action, options), /ARGS_INVALID/u);
  const context = await backupFixture(t);
  assert.equal(await readMaintenance(context.io, context.root), null);
  const journal = {
    version: 1,
    operation: "restore",
    phase: "quiescing",
    was_running: true,
    release,
    target: { id, digest: confirmation },
    safety: null,
    candidate: null,
  };
  assert.equal(requireMaintenance(journal), journal);
  for (const changed of [
    { ...journal, phase: "verified" },
    { ...journal, target: null },
    { ...journal, candidate: { name: "../evil" } },
    { ...journal, url: "secret" },
  ])
    assert.throws(() => requireMaintenance(changed), /MAINTENANCE_STATE_INVALID/u);
  await context.io.write(join(context.root, "maintenance.json"), '{"version":1,"phase":"idle"}');
  assert.equal(await readMaintenance(context.io, context.root), null);
  await context.io.write(join(context.root, "maintenance.json"), "broken");
  await assert.rejects(readMaintenance(context.io, context.root), /MAINTENANCE_STATE_INVALID/u);
});

test("failed manifest publication leaves only an incomplete backup", async (t) => {
  const context = await backupFixture(t);
  await assert.rejects(
    createBackup(
      {
        ...context,
        io: {
          ...context.io,
          write: async () => {
            throw new Error("FLUSH_FAILED");
          },
        },
      },
      (file) => file.writeFile(bytes),
    ),
    /FLUSH_FAILED/u,
  );
  assert.equal((await listBackups(context))[0].status, "incomplete");
});

test("native dump readers receive bytes from offset zero after verification", async (t) => {
  const context = await backupFixture(t);
  const backup = await make(context);
  await withBackupDump(backup.path, context.platform, backup.manifest.database, async (file) => {
    const buffer = Buffer.alloc(bytes.length);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
    assert.equal(bytesRead, bytes.length);
    assert.deepEqual(buffer, bytes);
  });
  const file = await open(backup.path);
  await file.close();
});

test("an enabled photo directory blocks database-only backup before any native operation", async (t) => {
  const context = await backupFixture(t);
  await mkdir(join(context.root, "photos"), { mode: 0o700 });
  const database = databaseTools(
    { ...context, payload: "unused", env: {} },
    {
      run: async () => assert.fail("photo refusal must precede native commands"),
      kit: async () => assert.fail("photo refusal must precede verification"),
    },
  );
  await assert.rejects(database.verify(), /PHOTO_BACKUP_REQUIRED/u);
});

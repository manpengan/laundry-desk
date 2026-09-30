// Windows CI only. Runs with the checkout absent and only System32 on PATH.
import assert from "node:assert/strict";
import { readFile, writeFile, link, unlink } from "node:fs/promises";
import { join } from "node:path";

export async function backupAcceptance(context) {
  const {
    scenario,
    command,
    root,
    payload,
    expectedDigest,
    io,
    platform,
    sql,
    secretDigest,
    beforeSecrets,
    load,
  } = context;
  const { digest } = await load("companion-contract.mjs");
  const { readState } = await load("lifecycle-storage.mjs");
  const { runtimeEnvironment } = await load("lifecycle-environment.mjs");
  const { pgControl } = await load("lifecycle-process.mjs");
  const { databaseTools } = await load("backup-database.mjs");
  const { createBackup } = await load("backup-files.mjs");
  let saved;
  let savedManifest;
  const run = (action, options = {}) => command(action, payload, expectedDigest, options);
  const rejected = (action, options, pattern) =>
    assert.rejects(run(action, options), (error) => pattern.test(error.stderr ?? ""));
  await scenario("managed-backup-and-database-restore", async () => {
    saved = await run("backup");
    const verified = await run("backup-verify", { backupId: saved.backup_id });
    assert.equal(verified.manifest_sha256, saved.manifest_sha256);
    assert.equal((await run("backup-list")).backups.length, 1);
    savedManifest = await readFile(join(root, "backups", saved.backup_id, "backup.json"));
    const metadata = JSON.parse(savedManifest);
    assert.equal(metadata.photos, "disabled_empty");
    await sql(
      "INSERT INTO public.runtime_acceptance_probe VALUES (3); CREATE TABLE public.post_backup_probe (id integer)",
    );
    const result = await run("restore", {
      backupId: saved.backup_id,
      confirmation: saved.manifest_sha256,
    });
    assert.equal(result.status, "running");
    assert.equal(await sql("SELECT count(*) FROM public.runtime_acceptance_probe"), "2");
    assert.equal(await sql("SELECT to_regclass('public.post_backup_probe') IS NULL"), "t");
    assert.equal(await secretDigest(), beforeSecrets);
    // Prove the automatically-created safety point contains the pre-restore state.
    await run("restore", {
      backupId: result.safety_backup.id,
      confirmation: result.safety_backup.digest,
    });
    assert.equal(await sql("SELECT count(*) FROM public.runtime_acceptance_probe"), "3");
    assert.equal(await sql("SELECT to_regclass('public.post_backup_probe') IS NOT NULL"), "t");
    await run("restore", { backupId: saved.backup_id, confirmation: saved.manifest_sha256 });
    assert.equal(await sql("SELECT count(*) FROM public.runtime_acceptance_probe"), "2");
  });
  await scenario("backup-corruption-confirmation-instance-and-version-rejection", async () => {
    const directory = join(root, "backups", saved.backup_id);
    const dumpPath = join(directory, "database.dump");
    const bytes = await readFile(dumpPath);
    const changed = Buffer.from(bytes);
    changed[changed.length - 1] ^= 1;
    await writeFile(dumpPath, changed);
    await rejected("backup-verify", { backupId: saved.backup_id }, /BACKUP_DUMP_MISMATCH/u);
    await writeFile(dumpPath, bytes);
    await rejected(
      "restore",
      { backupId: saved.backup_id, confirmation: "f".repeat(64) },
      /CONFIRMATION_MISMATCH/u,
    );
    for (const [field, value, code] of [
      ["instance_sha256", "f".repeat(64), /INSTANCE_MISMATCH/u],
      ["postgres_version", "16.16", /VERSION_MISMATCH/u],
    ]) {
      const metadata = { ...JSON.parse(savedManifest), [field]: value };
      const contents = JSON.stringify(metadata);
      await io.write(join(directory, "backup.json"), contents);
      await rejected(
        "restore",
        { backupId: saved.backup_id, confirmation: digest(contents) },
        code,
      );
    }
    await io.write(join(directory, "backup.json"), savedManifest.toString());
    const alias = join(root, "acceptance-hardlink");
    await link(dumpPath, alias);
    try {
      await rejected("backup-verify", { backupId: saved.backup_id }, /WINDOWS_COMPANION_/u);
    } finally {
      await unlink(alias);
    }
    assert.equal((await run("status")).status, "running");
    assert.equal(await sql("SELECT count(*) FROM public.runtime_acceptance_probe"), "2");
  });
  await scenario("reject-raw-restored-ledger-before-publication", async () => {
    await run("stop");
    const state = await readState(io, root);
    const selected = join(root, "releases", state.current.digest);
    const manifest = JSON.parse(await readFile(join(selected, "runtime-payload.json")));
    const runtimeEnv = await runtimeEnvironment(root, selected, manifest, io);
    const settings = {
      root,
      payload: selected,
      env: runtimeEnv,
      io,
      platform,
      entry: state.current,
      instance: digest(await io.read(join(root, "secrets/access-token-secret"))),
      postgresVersion: manifest.sources.postgres.version,
    };
    const database = databaseTools(settings);
    await pgControl("start", root, selected, runtimeEnv);
    const head = state.current.migrationHead;
    const checksum = await sql(
      `SELECT checksum FROM public.laundry_schema_migrations WHERE filename = '${head}'`,
    );
    assert.match(checksum, /^[a-f0-9]{64}$/u);
    let invalid;
    try {
      await sql(
        `UPDATE public.laundry_schema_migrations SET checksum = '${"0".repeat(64)}' WHERE filename = '${head}'`,
      );
      invalid = await createBackup(settings, (file) => database.dump(file));
    } finally {
      await sql(
        `UPDATE public.laundry_schema_migrations SET checksum = '${checksum}' WHERE filename = '${head}'`,
      );
      await pgControl("stop", root, selected, runtimeEnv);
    }
    await run("start");
    await rejected(
      "restore",
      { backupId: invalid.id, confirmation: invalid.digest },
      /RUNTIME_MIGRATION_LEDGER_MISMATCH/u,
    );
    await rejected("start", {}, /MAINTENANCE_RECOVERY_REQUIRED/u);
    await run("maintenance-recover");
    assert.equal(await sql("SELECT count(*) FROM public.runtime_acceptance_probe"), "2");
    assert.equal(
      await sql(`SELECT checksum FROM public.laundry_schema_migrations WHERE filename = '${head}'`),
      checksum,
    );
  });
  async function interrupted(phase) {
    await sql("INSERT INTO public.runtime_acceptance_probe VALUES (3), (4)");
    await run("stop");
    const state = await readState(io, root);
    const selected = join(root, "releases", state.current.digest);
    const manifest = JSON.parse(await readFile(join(selected, "runtime-payload.json")));
    const runtimeEnv = await runtimeEnvironment(root, selected, manifest, io);
    await pgControl("start", root, selected, runtimeEnv);
    const settings = {
      root,
      payload: selected,
      env: runtimeEnv,
      io,
      platform,
      entry: state.current,
      instance: digest(await io.read(join(root, "secrets/access-token-secret"))),
      postgresVersion: manifest.sources.postgres.version,
    };
    const database = databaseTools(settings);
    const point = await createBackup(settings, (file) => database.dump(file));
    let candidate = await database.candidate();
    const record = {
      version: 1,
      operation: "restore",
      phase: "restoring",
      was_running: true,
      release: state.current,
      target: { id: saved.backup_id, digest: saved.manifest_sha256 },
      safety: { id: point.id, digest: point.digest },
      candidate,
    };
    await io.write(join(root, "maintenance.json"), JSON.stringify(record));
    candidate = await database.create(candidate);
    await io.write(join(root, "maintenance.json"), JSON.stringify({ ...record, candidate }));
    const target = {
      path: join(root, "backups", saved.backup_id, "database.dump"),
      manifest: JSON.parse(savedManifest),
    };
    await database.restore(candidate, target);
    await io.write(
      join(root, "maintenance.json"),
      JSON.stringify({ ...record, phase: "switching", candidate }),
    );
    await database.swap(candidate);
    if (phase === "verified") {
      await database.verify();
      await io.write(
        join(root, "maintenance.json"),
        JSON.stringify({ ...record, phase, candidate }),
      );
      await database.finish(candidate); // Simulate death after cleanup, before idle publication.
    }
    // Leave PostgreSQL running just as a dead maintenance process would.
    await rejected("start", {}, /MAINTENANCE_RECOVERY_REQUIRED/u);
    assert.equal((await run("status")).status, "maintenance_required");
    const recovered = await run("maintenance-recover");
    assert.equal(recovered.recovered, true);
    assert.equal(
      await sql("SELECT count(*) FROM public.runtime_acceptance_probe"),
      phase === "verified" ? "2" : "4",
    );
    assert.equal(await secretDigest(), beforeSecrets);
    if (phase !== "verified") await sql("DELETE FROM public.runtime_acceptance_probe WHERE id > 2");
  }
  await scenario("recover-interrupted-database-switch", () => interrupted("switching"));
  await scenario("finish-verified-restore-after-cleanup-interruption", () =>
    interrupted("verified"),
  );
}

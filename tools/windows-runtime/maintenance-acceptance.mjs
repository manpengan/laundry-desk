// Synthetic Windows acceptance only; this harness is never shipped as a payload tool.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function maintenanceAcceptance(context) {
  const {
    scenario,
    command,
    root,
    payload,
    expectedDigest,
    variant,
    sql,
    digest,
    canonicalManifest,
    secretDigest,
    beforeSecrets,
    load,
    io,
    platform,
  } = context;
  const config = {
    version: 1,
    enabled: true,
    hour: 3,
    minute: 7,
    retain_count: 24,
    retain_days: 365,
    minimum_free_mib: 512,
    drill_days: 7,
  };
  await scenario("fixed-private-backup-task-and-shadow-drill", async () => {
    const before = await sql("SELECT count(*) FROM public.runtime_acceptance_probe");
    const registered = await command("backup-schedule", undefined, undefined, config);
    assert.equal(registered.config.enabled, true);
    assert.equal(registered.alerts.includes("task_missing"), false);
    assert.equal(registered.alerts.includes("task_unavailable"), false);
    const result = await command("scheduled-backup");
    assert.equal(result.latest.status, "succeeded");
    assert.equal(result.latest.drilled, true);
    assert.equal(await sql("SELECT count(*) FROM public.runtime_acceptance_probe"), before);
    assert.equal(await secretDigest(), beforeSecrets);
  });
  await scenario("cross-schema-shadow-upgrade-and-paired-snapshot-rollback", async () => {
    const changed = await variant("laundry-runtime-schema-extension", (manifest) => {
      manifest.runtime_release = "0.1.0-win-dev.4";
    });
    const manifest = JSON.parse(await readFile(join(changed.folder, "runtime-payload.json")));
    const number = Number(manifest.migration_head.slice(0, 4)) + 1;
    const name = `${String(number).padStart(4, "0")}_runtime_acceptance.sql`;
    const migration = Buffer.from(
      "CREATE TABLE public.runtime_upgrade_acceptance (id integer PRIMARY KEY); INSERT INTO public.runtime_upgrade_acceptance VALUES (1);\n",
    );
    await writeFile(join(changed.folder, "migrations", name), migration);
    manifest.files = [
      ...manifest.files,
      { path: `migrations/${name}`, size: migration.length, sha256: digest(migration) },
    ].sort((a, b) => (a.path < b.path ? -1 : 1));
    const migrations = manifest.files
      .filter((file) => /^migrations\/\d{4}_.*\.sql$/u.test(file.path))
      .sort((a, b) => (a.path < b.path ? -1 : 1));
    manifest.migration_head = name;
    manifest.migrations_sha256 = digest(
      migrations.map((file) => `${file.path.slice(11)}\0${file.sha256}\n`).join(""),
    );
    const bytes = canonicalManifest(manifest);
    await writeFile(join(changed.folder, "runtime-payload.json"), bytes);
    const upgraded = await command("upgrade", changed.folder, digest(bytes));
    assert.equal(upgraded.schema_transition, "upgrade");
    assert.equal(
      await sql("SELECT count(*) FROM public.runtime_upgrade_acceptance", changed.folder),
      "1",
    );
    await sql("INSERT INTO public.runtime_acceptance_probe VALUES (70)", changed.folder);
    const rolledBack = await command("rollback", payload, expectedDigest);
    assert.equal(rolledBack.schema_transition, "rollback");
    assert.equal(await sql("SELECT to_regclass('public.runtime_upgrade_acceptance') IS NULL"), "t");
    assert.equal(
      await sql("SELECT count(*) FROM public.runtime_acceptance_probe WHERE id=70"),
      "0",
    );
    const history = JSON.parse(await readFile(join(root, "upgrade-history.json")));
    assert.equal(history.length, 2);
    const { readBackup } = await load("backup-files.mjs");
    const { reference } = await load("lifecycle-storage.mjs");
    const safety = await readBackup(
      {
        root,
        io,
        platform,
        entry: reference(manifest, digest(bytes)),
        postgresVersion: manifest.sources.postgres.version,
        instance: digest(await io.read(join(root, "secrets/access-token-secret"))),
      },
      rolledBack.safety_backup.id,
      rolledBack.safety_backup.digest,
    );
    assert.equal(safety.digest, rolledBack.safety_backup.digest);
    assert.equal(await secretDigest(), beforeSecrets);
    const health = await command("backup-health");
    assert.equal(health.alerts.includes("task_missing"), false);
    assert.equal(health.alerts.includes("task_unavailable"), false);
  });
  await command("backup-schedule", undefined, undefined, { ...config, enabled: false });
}

export async function scheduledLauncherAcceptance({
  scenario,
  command,
  root,
  expectedDigest,
  host,
  execute,
  env,
  payload,
  health,
}) {
  await scenario("scheduled-launcher-action", async () => {
    await command("stop");
    const selected = join(root, "releases", expectedDigest);
    await host("task-enable", root, selected, expectedDigest);
    await execute(
      join(env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"),
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Start-ScheduledTask -TaskName LaundryDeskV2RuntimeCompanion",
      ],
      { env, cwd: payload },
    );
    await health(root, selected, expectedDigest);
    await execute(
      join(env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"),
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$deadline=[DateTime]::UtcNow.AddSeconds(60); while ((Get-ScheduledTask -TaskName LaundryDeskV2RuntimeCompanion).State -eq 'Running') { if ([DateTime]::UtcNow -gt $deadline) { throw 'WINDOWS_COMPANION_TASK_TIMEOUT' }; Start-Sleep -Milliseconds 200 }",
      ],
      { env, cwd: payload, timeout: 75000 },
    );
  });
}

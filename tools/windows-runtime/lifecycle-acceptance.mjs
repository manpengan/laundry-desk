// Windows CI only. This harness is copied outside the checkout, never shipped in payload.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createServer } from "node:net";
import { cp, readFile, writeFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
const execute = promisify(execFile);
const [payload, expectedDigest, reportFile] = process.argv.slice(2);
assert.equal(process.platform, "win32");
const load = (name) => import(pathToFileURL(join(payload, "scripts", name)).href);
const { digest, canonicalManifest } = await load("companion-contract.mjs");
const { storage, loadPlatform, withOperationLock, reference } = await load("lifecycle-storage.mjs");
const { cleanEnvironment, runtimeEnvironment } = await load("lifecycle-environment.mjs");
const { installationRoot } = await load("lifecycle.mjs");
const { host, pgControl, health } = await load("lifecycle-process.mjs");
const root = installationRoot();
const env = cleanEnvironment();
const node = join(payload, "node/node.exe");
const platform = await loadPlatform(payload);
const io = storage(platform);
const manifest = JSON.parse(await readFile(join(payload, "runtime-payload.json")));
const scenarios = [];
let activePayload = payload;
let activeDigest = expectedDigest;
async function command(action, source = payload, hash = expectedDigest) {
  const result = await execute(
    node,
    [join(source, "scripts/lifecycle-cli.mjs"), action, source, hash],
    { env, cwd: payload, windowsHide: true, timeout: 600000, maxBuffer: 65536 },
  );
  return JSON.parse(result.stdout);
}
async function rejected(action, source, hash, pattern) {
  await assert.rejects(command(action, source, hash), (error) => pattern.test(error.stderr ?? ""));
}
async function scenario(name, action) {
  const started = Date.now();
  await action();
  scenarios.push({ scenario: name, status: "passed", elapsed_ms: Date.now() - started });
  console.log(JSON.stringify(scenarios.at(-1)));
}
async function secretDigest() {
  const names = (await readdir(join(root, "secrets"))).sort();
  return digest(
    Buffer.concat(await Promise.all(names.map((name) => readFile(join(root, "secrets", name))))),
  );
}
async function sql(statement, source = activePayload) {
  const options = {
    env: { ...env, PGPASSFILE: join(root, "secrets/pgpass.conf") },
    cwd: payload,
    timeout: 60000,
    maxBuffer: 65536,
    windowsHide: true,
  };
  return (
    await execute(
      join(source, "postgres/bin/psql.exe"),
      [
        "-h",
        "127.0.0.1",
        "-p",
        "8543",
        "-U",
        "postgres",
        "-d",
        "laundry_v2",
        "-w",
        "-t",
        "-A",
        "-v",
        "ON_ERROR_STOP=1",
        "-c",
        statement,
      ],
      options,
    )
  ).stdout.trim();
}
async function variant(name, update) {
  const folder = join(resolve(payload, ".."), name);
  await cp(payload, folder, { recursive: true, errorOnExist: true, force: false });
  const value = structuredClone(manifest);
  update(value);
  const bytes = canonicalManifest(value);
  await writeFile(join(folder, "runtime-payload.json"), bytes);
  return { folder, hash: digest(bytes) };
}
let beforeSecrets;
try {
  await scenario("fresh-port-conflict", async () => {
    const server = createServer();
    await new Promise((resolve) => server.listen(8787, "127.0.0.1", resolve));
    try {
      await rejected("install", payload, expectedDigest, /(?:PORT|PROCESS)_CONFLICT/u);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
  await scenario("install-real-database", async () => {
    assert.equal((await command("install")).status, "running");
    assert.equal(await sql("SHOW data_checksums"), "on");
    assert.equal(await sql("SHOW password_encryption"), "scram-sha-256");
    await sql(
      "CREATE TABLE public.runtime_acceptance_probe (id integer PRIMARY KEY); INSERT INTO public.runtime_acceptance_probe VALUES (1), (2)",
    );
    beforeSecrets = await secretDigest();
  });
  await scenario("stop-start-repair", async () => {
    assert.equal((await command("stop")).status, "stopped");
    assert.equal((await command("start")).status, "running");
    assert.equal((await command("repair")).status, "running");
    assert.equal((await command("install")).status, "running");
    assert.equal(await secretDigest(), beforeSecrets);
    assert.equal(await sql("SELECT count(*) FROM public.runtime_acceptance_probe"), "2");
  });
  const second = await variant("laundry-runtime-second", (value) => {
    value.runtime_release = "0.1.0-win-dev.2";
  });
  await scenario("same-migration-upgrade-rollback", async () => {
    activePayload = second.folder;
    activeDigest = second.hash;
    assert.equal(
      (await command("upgrade", activePayload, activeDigest)).manifest_sha256,
      activeDigest,
    );
    assert.equal((await command("rollback")).manifest_sha256, expectedDigest);
    activePayload = payload;
    activeDigest = expectedDigest;
    assert.equal(await secretDigest(), beforeSecrets);
    assert.equal(await sql("SELECT count(*) FROM public.runtime_acceptance_probe"), "2");
  });
  await scenario("recover-interrupted-candidate-verification", async () => {
    await command("stop");
    const statePath = join(root, "state.json");
    const state = JSON.parse(await io.read(statePath));
    const candidate = JSON.parse(await readFile(join(second.folder, "runtime-payload.json")));
    const selected = join(root, "releases", second.hash);
    await io.write(
      statePath,
      JSON.stringify({ ...state, pending: reference(candidate, second.hash) }),
    );
    await pgControl(
      "start",
      root,
      selected,
      await runtimeEnvironment(root, selected, candidate, io),
    );
    assert.equal((await command("start")).manifest_sha256, expectedDigest);
    assert.equal(await sql("SELECT count(*) FROM public.runtime_acceptance_probe"), "2");
  });
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
  });
  await scenario("lock-owner-process-death", async () => {
    const script = `const {withOperationLock}=await import(${JSON.stringify(pathToFileURL(join(payload, "scripts/lifecycle-storage.mjs")).href)}); await withOperationLock(${JSON.stringify(root)},async()=>{console.log('LOCKED');await new Promise(()=>{});});`;
    const child = spawn(node, ["--input-type=module", "-e", script], {
      env,
      cwd: payload,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    await new Promise((resolve, reject) => {
      child.stdout.once("data", resolve);
      child.once("error", reject);
      child.once("exit", () => reject(new Error("LOCK_OWNER_EXITED")));
    });
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill();
    await exited;
    assert.equal((await command("status")).status, "running");
  });
  const different = await variant("laundry-runtime-migration-change", (value) => {
    value.migrations_sha256 = "f".repeat(64);
  });
  await scenario("reject-migration-change-and-tampered-package", async () => {
    await rejected(
      "upgrade",
      different.folder,
      different.hash,
      /MIGRATION_CHANGE_REQUIRES_RESTORE/u,
    );
    await writeFile(join(second.folder, "metadata/schema.md"), "tampered");
    await rejected("upgrade", second.folder, second.hash, /INVENTORY_MISMATCH/u);
    assert.equal((await command("status")).status, "running");
  });
  await scenario("exclusive-operation-lock", async () => {
    await withOperationLock(root, async () => {
      for (const action of ["install", "start", "stop", "upgrade", "rollback", "uninstall"])
        await rejected(action, payload, expectedDigest, /OPERATION_BUSY/u);
    });
  });
  await scenario("private-pointer-crash-and-native-failures", async () => {
    const scratch = join(root, "acceptance-pointer");
    await io.directory(scratch);
    const pointer = join(scratch, "pointer.json");
    for (const point of ["before-replace", "after-replace", "after-flush"]) {
      await io.write(pointer, '{"version":"old"}');
      const script = `const {storage,loadPlatform}=await import(${JSON.stringify(pathToFileURL(join(payload, "scripts/lifecycle-storage.mjs")).href)}); const p=await loadPlatform(${JSON.stringify(payload)}); await storage(p,async phase=>{if(phase===${JSON.stringify(point)})process.exit(29)}).write(${JSON.stringify(pointer)},'{"version":"new"}');`;
      await assert.rejects(
        execute(node, ["--input-type=module", "-e", script], { env, cwd: payload }),
        (e) => e.code === 29,
      );
      assert.equal(
        JSON.parse(await io.read(pointer)).version,
        point === "before-replace" ? "old" : "new",
      );
    }
    for (const primitive of ["replaceFileWriteThrough", "flushDirectoryDurably"]) {
      await io.write(pointer, '{"version":"old"}');
      await assert.rejects(
        storage({
          ...platform,
          [primitive]: async () => {
            throw new Error("INJECTED");
          },
        }).write(pointer, '{"version":"new"}'),
        /INJECTED/u,
      );
      assert.ok(["old", "new"].includes(JSON.parse(await io.read(pointer)).version));
    }
  });
  await scenario("server-interruption-and-recovery", async () => {
    const selected = join(root, "releases", expectedDigest);
    await host("stop-server", root, selected, expectedDigest);
    assert.equal((await command("start")).status, "running");
    assert.equal(await sql("SELECT count(*) FROM public.runtime_acceptance_probe"), "2");
  });
  await scenario("uninstall-preserves-data-and-reinstall", async () => {
    assert.equal((await command("uninstall")).status, "uninstalled");
    assert.equal((await command("uninstall")).status, "uninstalled");
    assert.equal(await secretDigest(), beforeSecrets);
    assert.equal((await command("install")).status, "running");
    assert.equal(await secretDigest(), beforeSecrets);
    assert.equal(await sql("SELECT count(*) FROM public.runtime_acceptance_probe"), "2");
  });
  await scenario("task-conflict-is-not-adopted", async () => {
    await command("stop");
    const ps = join(env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe");
    const update = (args) =>
      execute(ps, ["-NoProfile", "-NonInteractive", "-Command", args], { env, cwd: payload });
    await update(
      "$t=Get-ScheduledTask -TaskName LaundryDeskV2RuntimeCompanion; $a=New-ScheduledTaskAction -Execute 'C:\\Windows\\System32\\cmd.exe'; Set-ScheduledTask -InputObject $t -Action $a | Out-Null",
    );
    try {
      await rejected("start", payload, expectedDigest, /TASK_CONFLICT/u);
    } finally {
      // CI owns this synthetic task; this is deliberately not product uninstall code.
      await update(
        "Unregister-ScheduledTask -TaskName LaundryDeskV2RuntimeCompanion -Confirm:$false",
      );
    }
    await command("start");
  });
  await scenario("final-uninstall", async () => {
    await command("uninstall");
    assert.equal(await secretDigest(), beforeSecrets);
  });
  await writeFile(
    reportFile,
    JSON.stringify(
      {
        assurance: "development_only",
        source_git_sha: manifest.source_git_sha,
        manifest_sha256: expectedDigest,
        migration_head: manifest.migration_head,
        scenarios,
      },
      null,
      2,
    ),
  );
} catch (error) {
  for (const line of (error.stderr ?? "").split("\n")) {
    if (/^WINDOWS_COMPANION_DIAGNOSTIC \{[A-Za-z0-9_\s"{},.:[\]\-]*\}$/u.test(line.trim()))
      console.error(line.trim());
  }
  console.error(
    JSON.stringify({
      status: "failed",
      scenario: scenarios.length,
      code:
        (error.stderr ?? error.message).match(/WINDOWS_COMPANION_[A-Z_]+/u)?.[0] ??
        "WINDOWS_COMPANION_ACCEPTANCE_FAILED",
    }),
  );
  process.exitCode = 1;
} finally {
  // Best effort stop only the task/process identity established by this run. Preserve
  // the synthetic cluster on failure in the ephemeral runner; never upload it.
  try {
    await command("stop", activePayload, activeDigest);
  } catch {
    /* Already uninstalled or failed closed. */
  }
}

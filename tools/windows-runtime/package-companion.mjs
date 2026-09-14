import { execFile } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { COMPANION_SOURCES } from "./companion-sources.mjs";
import { canonicalManifest, digest, fail, MANIFEST_NAME } from "./companion-contract.mjs";
import { inventory, requireRealDirectory } from "./companion-files.mjs";
import { inspectCompanion } from "./inspect-companion.mjs";

const execute = promisify(execFile);
const scriptsRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptsRoot, "../..");
const scriptNames = [
  "companion-contract.mjs",
  "companion-files.mjs",
  "inspect-companion.mjs",
  "smoke-companion.mjs",
  "lifecycle-cli.mjs",
  "lifecycle.mjs",
  "lifecycle-storage.mjs",
  "lifecycle-environment.mjs",
  "lifecycle-process.mjs",
  "lifecycle-database.mjs",
  "lifecycle-release.mjs",
  "lifecycle-host.ps1",
];

function buildEnvironment() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(?:NODE_OPTIONS|NODE_PATH|PSModulePath|LAUNDRY_|DATABASE_|PG)/iu.test(key))
      delete env[key];
  }
  if (process.platform === "win32")
    env.PSModulePath = join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/Modules");
  return env;
}

async function run(file, args, cwd = repositoryRoot, env = buildEnvironment()) {
  try {
    return (
      await execute(file, args, {
        cwd,
        env,
        windowsHide: true,
        timeout: 600000,
        maxBuffer: 4 * 1024 * 1024,
      })
    ).stdout.trim();
  } catch (error) {
    const archiveDiagnostic = `${error.stdout ?? ""}\n${error.stderr ?? ""}`.match(
      /WINDOWS_COMPANION_ARCHIVE_FAILURE line=[0-9]+ code=[A-Za-z0-9_.,-]+/u,
    );
    if (archiveDiagnostic) console.error(archiveDiagnostic[0]);
    const stable = `${error.stdout ?? ""}\n${error.stderr ?? ""}`.match(
      /WINDOWS_COMPANION_[A-Z_]+/u,
    );
    if (stable) throw new Error(stable[0]);
    const codes = [
      ...new Set(
        `${error.stdout ?? ""}\n${error.stderr ?? ""}`.match(
          /\b(?:TS[0-9]{4,5}|ERR_PNPM_[A-Z_]+|RUNTIME_[A-Z_]+)\b/gu,
        ) ?? [],
      ),
    ];
    console.error(
      JSON.stringify({
        subprocess_exit: typeof error.code === "number" ? error.code : null,
        diagnostic_codes: codes,
      }),
    );
    fail("BUILD_PROCESS_FAILED");
  }
}

async function sourceIdentity(expectedSha) {
  if (!/^[0-9a-f]{40}$/u.test(expectedSha)) fail("SOURCE_INVALID");
  const options = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=NUL"];
  const before = await run("git.exe", [...options, "rev-parse", "HEAD"]);
  const status = await run("git.exe", [
    ...options,
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
  const after = await run("git.exe", [...options, "rev-parse", "HEAD"]);
  if (status || before !== expectedSha || after !== expectedSha) fail("SOURCE_NOT_EXACT_CLEAN");
}

async function pruneEmpty(root) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory()) await pruneEmpty(join(root, entry.name));
  }
  if ((await readdir(root)).length === 0) await rmdir(root);
}

function copyFilter(path) {
  const parts = path.replaceAll("\\", "/").split("/");
  return (
    !parts.some((part) =>
      [".bin", ".pnpm", ".modules.yaml", ".pnpm-workspace-state-v1.json"].includes(part),
    ) && !/\.test\.(?:js|d\.ts)(?:\.map)?$/u.test(path)
  );
}

export async function packageCompanion({ sourceSha, nodeArchive, postgresArchive, release }) {
  if (process.platform !== "win32" || process.arch !== "x64") fail("BUILD_PLATFORM_INVALID");
  if (!/^[0-9]+\.[0-9]+\.[0-9]+-win-dev(?:\.[0-9]+)?$/u.test(release)) fail("RELEASE_INVALID");
  await sourceIdentity(sourceSha);
  // Invoke pnpm's JS entrypoint with the current Node, never a shell-parsed .cmd command.
  if (!process.env.npm_execpath) fail("RUN_WITH_PNPM_REQUIRED");
  const pnpmScript = await realpath(process.env.npm_execpath);
  if (
    !/pnpm\.[cm]?js$/iu.test(pnpmScript) ||
    (await run(process.execPath, [pnpmScript, "--version"])) !== "11.15.0"
  )
    fail("RUN_WITH_PNPM_REQUIRED");
  for (const name of ["platform-fs", "contracts", "domain", "server"]) {
    console.error(`WINDOWS_COMPANION_STAGE_BUILD_${name.toUpperCase().replaceAll("-", "_")}`);
    await run(process.execPath, [pnpmScript, "--filter", `@laundry/${name}`, "build"]);
  }
  const outputParent = join(scriptsRoot, "dist");
  await mkdir(outputParent, { recursive: true });
  await requireRealDirectory(outputParent);
  const work = await mkdtemp(join(outputParent, ".staging-"));
  const payload = join(work, "payload");
  await mkdir(payload);
  try {
    const powershell = join(
      process.env.SystemRoot,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    for (const [kind, archive] of [
      ["node", nodeArchive],
      ["postgres", postgresArchive],
    ]) {
      console.error(`WINDOWS_COMPANION_STAGE_EXTRACT_${kind.toUpperCase()}`);
      await run(powershell, [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        join(scriptsRoot, "expand-companion-archive.ps1"),
        "-Archive",
        resolve(archive),
        "-Sha256",
        COMPANION_SOURCES[kind].sha256,
        "-Destination",
        join(payload, kind),
        "-Kind",
        kind,
      ]);
    }
    const node = join(payload, "node/node.exe");
    if (
      (await run(node, ["--version"])) !== `v${COMPANION_SOURCES.node.version}` ||
      (await run(join(payload, "postgres/bin/postgres.exe"), ["--version"])) !==
        `postgres (PostgreSQL) ${COMPANION_SOURCES.postgres.version}`
    ) {
      fail("BINARY_VERSION_INVALID");
    }
    const deployed = join(work, "deployed");
    console.error("WINDOWS_COMPANION_STAGE_DEPLOY_SERVER");
    await run(process.execPath, [
      pnpmScript,
      "--filter",
      "@laundry/server",
      "--config.inject-workspace-packages=true",
      "--config.node-linker=hoisted",
      "deploy",
      "--prod",
      deployed,
    ]);
    await mkdir(join(payload, "server"));
    for (const name of ["dist", "package.json", "node_modules"]) {
      await cp(join(deployed, name), join(payload, "server", name), {
        recursive: true,
        filter: copyFilter,
      });
    }
    await cp(join(repositoryRoot, "packages/db/src/migrations"), join(payload, "migrations"), {
      recursive: true,
    });
    await mkdir(join(payload, "metadata"));
    await cp(
      join(repositoryRoot, "packages/contracts/openapi/laundry-v2.openapi.json"),
      join(payload, "metadata/contracts.json"),
    );
    await cp(
      join(repositoryRoot, "packages/db/src/README.md"),
      join(payload, "metadata/schema.md"),
    );
    await mkdir(join(payload, "scripts"));
    for (const name of scriptNames)
      await cp(join(scriptsRoot, name), join(payload, "scripts", name));
    await cp(join(scriptsRoot, "README.md"), join(payload, "README.md"));
    await pruneEmpty(payload);
    console.error("WINDOWS_COMPANION_STAGE_MIGRATION_INFO");
    const migration = JSON.parse(
      await run(
        node,
        [join(payload, "server/dist/runtime/kit-entrypoint.js"), "migration-info"],
        payload,
        { ...buildEnvironment(), LAUNDRY_RUNTIME_MIGRATIONS_DIR: join(payload, "migrations") },
      ),
    );
    const { files } = await inventory(payload);
    console.error("WINDOWS_COMPANION_STAGE_MANIFEST");
    const manifest = canonicalManifest({
      schema: "laundry.windows.runtime-payload",
      version: 1,
      assurance: "development_only",
      platform: "win32-x64",
      source_git_sha: sourceSha,
      runtime_release: release,
      sources: COMPANION_SOURCES,
      migration_head: migration.migration_head,
      migrations_sha256: migration.migrations_sha256,
      files,
    });
    const manifestDigest = digest(manifest);
    await writeFile(join(payload, MANIFEST_NAME), manifest, { flag: "wx" });
    await inspectCompanion(payload, manifestDigest);
    await sourceIdentity(sourceSha);
    const output = join(outputParent, `runtime-${sourceSha}-${release}`);
    // rename refuses an existing nonempty release; never replace a published payload.
    await rename(payload, output);
    return {
      output,
      manifest_sha256: manifestDigest,
      assurance: "development_only",
      source_git_sha: sourceSha,
    };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (
      args.length !== 8 ||
      args[0] !== "--source-sha" ||
      args[2] !== "--node-archive" ||
      args[4] !== "--postgres-archive" ||
      args[6] !== "--release"
    )
      fail("ARGS_INVALID");
    console.log(
      JSON.stringify(
        await packageCompanion({
          sourceSha: args[1],
          nodeArchive: args[3],
          postgresArchive: args[5],
          release: args[7],
        }),
      ),
    );
  } catch (error) {
    console.error(
      /^WINDOWS_COMPANION_[A-Z_]+$/u.test(error.message)
        ? error.message
        : "WINDOWS_COMPANION_BUILD_FAILED",
    );
    process.exitCode = 1;
  }
}

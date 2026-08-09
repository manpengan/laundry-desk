import { constants as fileConstants } from "node:fs";
import { createHash, createPrivateKey, sign } from "node:crypto";
import { access, lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";

import { loadLanStaticAssets } from "../local/lan-gateway-core.mjs";
import { assertDockerId, fail } from "./runtime-counter-loopback-core.mjs";
import { BUILD_COMMAND_TIMEOUT_MS } from "./runtime-counter-loopback-process.mjs";

const CONTRACTS_MAJOR = 2;
const POSTGRES_TAG = "postgres:16";

export async function firstExecutable(candidates, failureCode) {
  for (const candidate of candidates) {
    try {
      await access(candidate, fileConstants.X_OK);
      return await realpath(candidate);
    } catch {
      // Continue through the fixed installation candidates.
    }
  }
  fail(failureCode);
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  );
}

async function migrationBundle(repositoryRoot) {
  const migrationRoot = join(repositoryRoot, "packages/db/src/migrations");
  const names = (await readdir(migrationRoot))
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/u.test(name))
    .sort();
  if (names.length === 0) fail("RUNTIME_COUNTER_MIGRATIONS_INVALID");
  const records = [];
  for (const name of names) {
    records.push(`${name}\0${sha256(await readFile(join(migrationRoot, name)))}\n`);
  }
  return Object.freeze({ head: names.at(-1), sha256: sha256(records.join("")) });
}

async function writeManifest(path, payload, signingKeyPath) {
  const privateKey = createPrivateKey(await readFile(signingKeyPath));
  const signature = sign(
    null,
    Buffer.from(JSON.stringify(canonicalize(payload))),
    privateKey,
  ).toString("base64url");
  await writeFile(path, JSON.stringify({ payload, signature }), {
    flag: "wx",
    mode: 0o600,
  });
}

async function postgresDigest(runDocker) {
  const inspect = async () => {
    const result = await runDocker(
      ["image", "inspect", "--format", "{{json .RepoDigests}}", POSTGRES_TAG],
      { accepting: [0, 1], label: "RUNTIME_COUNTER_POSTGRES_INSPECT" },
    );
    if (result.code !== 0) return null;
    let values;
    try {
      values = JSON.parse(result.stdout);
    } catch {
      return null;
    }
    const reference = Array.isArray(values)
      ? values.find(
          (value) => typeof value === "string" && /^postgres@sha256:[0-9a-f]{64}$/u.test(value),
        )
      : undefined;
    return reference?.replace("postgres@", "docker.io/library/postgres@") ?? null;
  };
  let reference = await inspect();
  if (reference === null) {
    await runDocker(["pull", POSTGRES_TAG], {
      label: "RUNTIME_COUNTER_POSTGRES_PULL",
      timeoutMs: BUILD_COMMAND_TIMEOUT_MS,
    });
    reference = await inspect();
  }
  if (reference === null) fail("RUNTIME_COUNTER_POSTGRES_DIGEST_INVALID");
  return reference;
}

async function findPackagedCounter(releaseRoot) {
  const entries = await readdir(releaseRoot, { withFileTypes: true });
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^mac-[A-Za-z0-9._-]+$/u.test(entry.name)) continue;
    const candidate = join(releaseRoot, entry.name, "laundry-desk V2.app");
    try {
      const metadata = await lstat(candidate);
      if (metadata.isDirectory() && !metadata.isSymbolicLink()) candidates.push(candidate);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        fail("RUNTIME_COUNTER_PACKAGED_APP_INVALID");
      }
    }
  }
  if (candidates.length !== 1) fail("RUNTIME_COUNTER_PACKAGED_APP_INVALID");
  const appPath = await realpath(candidates[0]);
  const releaseRelative = relative(await realpath(releaseRoot), appPath);
  if (releaseRelative.startsWith("..") || isAbsolute(releaseRelative)) {
    fail("RUNTIME_COUNTER_PACKAGED_APP_INVALID");
  }
  const executable = join(appPath, "Contents/MacOS/laundry-desk V2");
  const executableMetadata = await lstat(executable);
  if (!executableMetadata.isFile() || executableMetadata.isSymbolicLink()) {
    fail("RUNTIME_COUNTER_PACKAGED_APP_INVALID");
  }
  try {
    await access(executable, fileConstants.X_OK);
  } catch {
    fail("RUNTIME_COUNTER_PACKAGED_APP_INVALID");
  }
  return Object.freeze({ appPath, executable });
}

export function runtimeTestingBuildArguments(kitRoot, signingKeyPath, outputRoot) {
  return Object.freeze([
    join(kitRoot, "build-app.mjs"),
    "--testing",
    "--testing-signing-key-output",
    signingKeyPath,
    "--testing-output-root",
    outputRoot,
  ]);
}

async function buildRuntimeAndWeb(context) {
  context.report("runtime-app");
  await context.run(
    process.execPath,
    runtimeTestingBuildArguments(
      context.kitRoot,
      context.signingKeyPath,
      context.runtimeAppOutputRoot,
    ),
    {
      label: "RUNTIME_COUNTER_RUNTIME_BUILD",
      timeoutMs: BUILD_COMMAND_TIMEOUT_MS,
    },
  );
  const runtimeApp = await realpath(
    join(context.runtimeAppOutputRoot, "Laundry Desk Runtime Test.app"),
  );
  await context.run(process.execPath, [join(context.kitRoot, "inspect-app.mjs"), runtimeApp], {
    label: "RUNTIME_COUNTER_RUNTIME_INSPECT",
  });
  context.report("web-bundle");
  for (const workspace of ["@laundry/ui", "@laundry/web"]) {
    await context.run(context.pnpm, ["--filter", workspace, "build"], {
      label: `RUNTIME_COUNTER_${workspace.endsWith("ui") ? "UI" : "WEB"}_BUILD`,
      timeoutMs: BUILD_COMMAND_TIMEOUT_MS,
    });
  }
  return runtimeApp;
}

async function buildCounter(context) {
  context.report("packaged-counter");
  await context.run(
    context.pnpm,
    ["exec", "turbo", "run", "build", "--filter=@laundry/edge-agent"],
    { label: "RUNTIME_COUNTER_EDGE_BUILD", timeoutMs: BUILD_COMMAND_TIMEOUT_MS },
  );
  await context.run(context.pnpm, ["--filter", "@laundry/edge-agent", "preload:bundle"], {
    label: "RUNTIME_COUNTER_PRELOAD_BUILD",
    timeoutMs: BUILD_COMMAND_TIMEOUT_MS,
  });
  const releaseRoot = join(context.temporaryRoot, "counter-release");
  await mkdir(releaseRoot, { mode: 0o700 });
  await context.run(
    context.pnpm,
    [
      "--filter",
      "@laundry/edge-agent",
      "exec",
      "electron-builder",
      "--config",
      "electron-builder.yml",
      "--mac",
      "dir",
      `--config.directories.output=${releaseRoot}`,
    ],
    { label: "RUNTIME_COUNTER_PACKAGE", timeoutMs: BUILD_COMMAND_TIMEOUT_MS },
  );
  return await findPackagedCounter(releaseRoot);
}

async function buildServerImage(context, metadata) {
  context.report("server-image");
  const arguments_ = [
    "build",
    "--file",
    join(context.repositoryRoot, "apps/server/Dockerfile.runtime"),
    "--tag",
    context.identity.imageTag,
    "--label",
    `com.laundry-desk.acceptance=${context.identity.acceptanceLabel}`,
    ...Object.entries(metadata.buildArguments).flatMap(([name, value]) => [
      "--build-arg",
      `${name}=${value}`,
    ]),
    context.repositoryRoot,
  ];
  await context.runDocker(arguments_, {
    label: "RUNTIME_COUNTER_SERVER_BUILD",
    timeoutMs: BUILD_COMMAND_TIMEOUT_MS,
  });
  const result = await context.runDocker(
    ["image", "inspect", "--format", "{{json .Id}}", context.identity.imageTag],
    { label: "RUNTIME_COUNTER_SERVER_INSPECT" },
  );
  return assertDockerId(JSON.parse(result.stdout));
}

export async function buildAcceptanceArtifacts(context) {
  const runtimeApp = await buildRuntimeAndWeb(context);
  const counter = await buildCounter(context);
  const migrations = await migrationBundle(context.repositoryRoot);
  const contractsSHA = sha256(
    await readFile(
      join(context.repositoryRoot, "packages/contracts/openapi/laundry-v2.openapi.json"),
    ),
  );
  const schemaSHA = sha256(
    await readFile(join(context.repositoryRoot, "packages/db/src/README.md")),
  );
  const webRoot = join(context.repositoryRoot, "apps/web/dist-spa");
  const ownerSpaSHA = (await loadLanStaticAssets(webRoot)).sha256;
  const release = `0.1.0-counter.${context.identity.runtimeId}`;
  const buildArguments = Object.freeze({
    RUNTIME_CONTRACTS_MAJOR: String(CONTRACTS_MAJOR),
    RUNTIME_CONTRACTS_SHA256: contractsSHA,
    RUNTIME_MIGRATIONS_SHA256: migrations.sha256,
    RUNTIME_MIGRATION_HEAD: migrations.head,
    RUNTIME_RELEASE: release,
    RUNTIME_SCHEMA_SHA256: schemaSHA,
    RUNTIME_SERVER_VERSION: release,
    RUNTIME_WEB_BUNDLE_SHA256: ownerSpaSHA,
  });
  const imageId = await buildServerImage(context, { buildArguments });
  const postgresImage = await postgresDigest(context.runDocker);
  const resources = join(runtimeApp, "Contents/Resources");
  const payload = Object.freeze({
    schema_version: 2,
    product: "laundry-desk-runtime",
    release,
    contracts_major: CONTRACTS_MAJOR,
    contracts_sha256: contractsSHA,
    server_version: release,
    web_bundle_sha256: ownerSpaSHA,
    minimum_app_version: "0.1.0",
    database_schema_sha256: schemaSHA,
    migrations_sha256: migrations.sha256,
    migration_head: migrations.head,
    maximum_compatible_schema: migrations.head,
    rollback_target: null,
    compose_sha256: sha256(await readFile(join(resources, "docker-compose.runtime.yml"))),
    lan_compose_sha256: sha256(await readFile(join(resources, "docker-compose.runtime-lan.yml"))),
    owner_spa_sha256: ownerSpaSHA,
    server_image: Object.freeze({
      index: `registry.example/laundry/server@${imageId}`,
      linux_arm64: imageId,
      linux_amd64: imageId,
    }),
    postgres_major: 16,
    postgres_image: postgresImage,
  });
  const manifestPath = join(context.temporaryRoot, "runtime-manifest.json");
  await writeManifest(manifestPath, payload, context.signingKeyPath);
  return Object.freeze({
    counter,
    imageId,
    manifestPath,
    release,
    runtimeExecutable: join(runtimeApp, "Contents/MacOS/Laundry Desk Runtime"),
    signingKeyPath: context.signingKeyPath,
  });
}

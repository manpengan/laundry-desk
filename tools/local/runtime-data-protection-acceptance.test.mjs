import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const repository = new URL("../../", import.meta.url);
const packageUrl = new URL("package.json", repository);
const adrUrl = new URL(
  "docs/adr/2026-08-08-adr-33-runtime-portable-data-protection.md",
  repository,
);
const runtimeKitUrl = new URL("tools/runtime-kit/", repository);

test("Stage 3 package commands expose deterministic and real-container gates", async () => {
  const packageJson = JSON.parse(await readFile(packageUrl, "utf8"));
  assert.equal(
    packageJson.scripts["runtime:data:no-repo:acceptance"],
    "node tools/runtime-kit/runtime-data-acceptance.mjs",
  );
  assert.equal(
    packageJson.scripts["runtime:data:container:acceptance"],
    "node tools/runtime-kit/real-container-transfer-acceptance.mjs",
  );
  assert.equal(
    packageJson.scripts["runtime:data:acceptance"],
    "pnpm runtime:data:no-repo:acceptance && pnpm runtime:data:container:acceptance",
  );
});

test("Stage 3 acceptance stays split below the test-file hard limit", async () => {
  for (const name of [
    "no-repo-maintenance-acceptance.mjs",
    "no-repo-transfer-acceptance.mjs",
    "real-container-transfer-acceptance.mjs",
  ]) {
    const source = await readFile(new URL(name, runtimeKitUrl), "utf8");
    assert.ok(source.split("\n").length <= 800, `${name} exceeds 800 lines`);
    assert.doesNotMatch(source, /child_process\.(?:exec|execSync)|shell:\s*true/u);
  }
});

test("Stage 3 no-repo gates freeze maintenance and two-root transfer boundaries", async () => {
  const [helpers, maintenance, transfer, orchestrator] = await Promise.all([
    readFile(new URL("no-repo-data-helpers.mjs", runtimeKitUrl), "utf8"),
    readFile(new URL("no-repo-maintenance-acceptance.mjs", runtimeKitUrl), "utf8"),
    readFile(new URL("no-repo-transfer-acceptance.mjs", runtimeKitUrl), "utf8"),
    readFile(new URL("runtime-data-acceptance.mjs", runtimeKitUrl), "utf8"),
  ]);
  assert.match(helpers, /cwd,/u);
  assert.match(helpers, /env: \{ PATH: "", HOME: home/u);
  assert.match(helpers, /RUNTIME_DATA_CHILD_TIMEOUT/u);
  assert.match(maintenance, /\["maintenance"\]/u);
  assert.match(maintenance, /maintenance-state\.json/u);
  assert.match(maintenance, /scheduled-\\d\{8\}T\\d\{6\}Z/u);
  for (const command of [
    '["transfer", "self-test"]',
    '["transfer", "payload-self-test"]',
    '["transfer", "export"]',
    '["transfer", "inspect"]',
    '["transfer", "import"]',
  ]) {
    assert.ok(transfer.includes(command), `missing ${command}`);
  }
  assert.match(transfer, /fixture\.root\("source"\)/u);
  assert.match(transfer, /fixture\.root\("destination"\)/u);
  assert.match(transfer, /instance_id/u);
  assert.match(transfer, /entry\.arguments/u);
  assert.match(transfer, /entry\.environment/u);
  assert.match(orchestrator, /build-app\.mjs/u);
  assert.match(orchestrator, /inspect-app\.mjs/u);
  assert.match(orchestrator, /no-repo-maintenance-acceptance\.mjs/u);
  assert.match(orchestrator, /no-repo-transfer-acceptance\.mjs/u);
  assert.doesNotMatch(`${helpers}\n${maintenance}\n${transfer}`, /shell:\s*true/u);
});

test("Stage 3 real-container gate freezes isolated data and cleanup proof", async () => {
  const source = await readFile(
    new URL("real-container-transfer-acceptance.mjs", runtimeKitUrl),
    "utf8",
  );
  for (const contract of [
    "--test-system-config-root",
    "--test-runtime-id",
    "--test-local-server-image",
    "com.docker.compose.project",
    "runtime_transfer_acceptance",
    "pre_transfer",
    "RUNTIME_BACKUP_INVALID",
    "RUNTIME_TRANSFER_INVALID",
    "RUNTIME_REAL_CONTAINER_TRANSFER_OK",
  ]) {
    assert.ok(source.includes(contract), `real-container acceptance missing ${contract}`);
  }
  assert.match(source, /container", "rm", "--force"/u);
  assert.match(source, /network", "rm"/u);
  assert.match(source, /volume", "rm", "--force"/u);
  assert.match(source, /finally\s*\{/u);
  assert.match(source, /SIGTERM/u);
  assert.match(source, /SIGKILL/u);
  assert.match(source, /public\.customers/u);
  assert.match(source, /CLEANUP_IMAGE_VERIFY/u);
  assert.match(source, /RUNTIME_NONCANONICAL_ERROR/u);
  assert.match(source, /\^RUNTIME_\[A-Z0-9_\]\+\\n\$/u);
  assert.match(source, /flag:\s*"wx"[\s\S]*?flush:\s*true[\s\S]*?mode:\s*0o600/u);
  assert.match(source, /corruptedMetadata\.mode & 0o777/u);
  assert.match(source, /corruptedMetadata\.nlink/u);
  assert.match(source, /corruptedMetadata\.size/u);
  assert.match(
    source,
    /let postgresDigest = await inspectPostgresDigest\(\);\s*if \(postgresDigest === undefined\) \{\s*await dockerRun\(\["pull", "postgres:16"\]/u,
  );
  assert.doesNotMatch(source, /CREATE\s+(?:TABLE|TYPE|INDEX)|ALTER\s+TABLE|DROP\s+TABLE/iu);
  assert.doesNotMatch(source, /shell:\s*true/u);
});

test("Stage 3 external path derives its transfer ceiling from the archive format", async () => {
  const [externalPath, portableArchive, transferAcceptance, main] = await Promise.all([
    readFile(new URL("Sources/RuntimeExternalPath.swift", runtimeKitUrl), "utf8"),
    readFile(new URL("Sources/RuntimePortableArchive.swift", runtimeKitUrl), "utf8"),
    readFile(new URL("no-repo-transfer-acceptance.mjs", runtimeKitUrl), "utf8"),
    readFile(new URL("Sources/main.swift", runtimeKitUrl), "utf8"),
  ]);
  assert.match(
    externalPath,
    /static let maximumTransferBytes = RuntimePortableArchive\.maximumArchiveBytes/u,
  );
  assert.doesNotMatch(externalPath, /maximumTransferBytes(?:\s*:\s*Int64)?\s*=\s*[\d_]+/u);
  assert.match(portableArchive, /static let maximumArchiveBytes:\s*Int64/u);
  assert.match(transferAcceptance, /exact-maximum\.laundry-transfer/u);
  assert.match(transferAcceptance, /above-maximum\.laundry-transfer/u);
  assert.match(transferAcceptance, /linked-transfer-parent/u);
  assert.match(main, /root = URL\(fileURLWithPath: arguments\[1\], isDirectory: true\)/u);
  assert.doesNotMatch(
    main,
    /root = URL\(fileURLWithPath: arguments\[1\], isDirectory: true\)\.standardizedFileURL/u,
  );
});

test("Stage 3 isolated volumes cross the fixed system-runner environment boundary", async () => {
  const [runner, images] = await Promise.all([
    readFile(new URL("Sources/ProcessRunner.swift", runtimeKitUrl), "utf8"),
    readFile(new URL("Sources/RuntimeTestingImages.swift", runtimeKitUrl), "utf8"),
  ]);
  assert.match(runner, /"LAUNDRY_RUNTIME_PGDATA_VOLUME"/u);
  assert.match(runner, /"LAUNDRY_RUNTIME_PHOTOS_VOLUME"/u);
  assert.match(
    images,
    /if testLocalServerImage == nil \{[\s\S]*?"pull", payload\.postgresImage[\s\S]*?\} else \{\s*try assertCachedTestingPostgres/u,
  );
  assert.match(images, /repoDigests\.contains\("postgres@\\\(digest\)"\)/u);
});

test("Stage 3 testing database payload fixture keeps its exact byte count", async () => {
  const source = await readFile(
    new URL("Sources/RuntimeTransferPayloadValidation.swift", runtimeKitUrl),
    "utf8",
  );
  assert.match(source, /rawDigest\.size == 30/u);
  assert.equal(Buffer.byteLength("RUNTIME_FAKE_DATABASE_DATA_V1\n"), 30);
  for (const phase of [
    "EXTRACT_FAILED",
    "RAW_INVALID",
    "SANITIZER_INVALID",
    "SANITIZED_INVALID",
    "CONTENT_INVALID",
    "SOURCE_VERSION_INVALID",
    "OUTPUT_SYNC_FAILED",
  ]) {
    assert.match(source, new RegExp(`RUNTIME_TRANSFER_PAYLOAD_DATABASE_${phase}`, "u"));
  }
});

test("Stage 3 streaming parser containers keep verified stdin attached", async () => {
  const source = await readFile(
    new URL("Sources/RuntimeBackupCommands.swift", runtimeKitUrl),
    "utf8",
  );
  assert.match(source, /"run", "--rm", "--interactive", "--network"/u);
  assert.match(source, /inspectPhotoArchive[\s\S]*?interactive: true/u);
  assert.match(source, /restorePhotos[\s\S]*?interactive: true/u);
  assert.equal(source.match(/interactive: true/gu)?.length, 2);
});

test("Stage 3 database reset preserves the canonical public schema owner", async () => {
  const source = await readFile(
    new URL("Sources/RuntimeDatabaseImportAuthority.swift", runtimeKitUrl),
    "utf8",
  );
  assert.match(source, /CREATE SCHEMA public AUTHORIZATION pg_database_owner/u);
  assert.match(source, /GRANT USAGE ON SCHEMA public TO PUBLIC/u);
  assert.match(source, /COMMENT ON SCHEMA public IS 'standard public schema'/u);
  assert.match(
    source,
    /obj_description\('public'::pg_catalog\.regnamespace\)[\s\S]*?IS DISTINCT FROM 'standard public schema'/u,
  );
  assert.doesNotMatch(source, /CREATE SCHEMA public AUTHORIZATION laundry_owner/u);
});

test("Stage 3 ADR freezes retention, encrypted transfer, and two-root proof", async () => {
  const adr = await readFile(adrUrl, "utf8");
  for (const contract of [
    "最多 30 份且不超过 30 天",
    "PBKDF2-HMAC-SHA256",
    "AES-256-GCM",
    "pre_transfer",
    "目标实例 id",
    "两个独立 Runtime 根",
  ]) {
    assert.ok(adr.includes(contract), `ADR-33 missing ${contract}`);
  }
});

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, createPrivateKey, sign } from "node:crypto";
import {
  cp,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const kitRoot = dirname(fileURLToPath(import.meta.url));
const builtApp = join(kitRoot, "dist/Laundry Desk Runtime Test.app");
const privateKeyPath = join(kitRoot, "dist/test-signing-private.pem");
const temporary = await mkdtemp(join(tmpdir(), "laundry-runtime-native-"));
const emptyCwd = join(temporary, "empty-cwd");
const copiedApp = join(temporary, "Laundry Desk Runtime Test.app");
await mkdir(emptyCwd);
await cp(builtApp, copiedApp, { recursive: true });
const executable = join(copiedApp, "Contents/MacOS/Laundry Desk Runtime");
const compose = await readFile(join(copiedApp, "Contents/Resources/docker-compose.runtime.yml"));
const checksum = (value) => createHash("sha256").update(value).digest("hex");
const repeated = (value) => value.repeat(64);
const payload = Object.freeze({
  schema_version: 1,
  product: "laundry-desk-runtime",
  release: "0.1.0",
  contracts_major: 2,
  contracts_sha256: repeated("a"),
  server_version: "0.1.0",
  web_bundle_sha256: repeated("b"),
  minimum_app_version: "0.1.0",
  database_schema_sha256: repeated("c"),
  migrations_sha256: repeated("d"),
  migration_head: "0033_offline_grant_replay.sql",
  maximum_compatible_schema: "0033_offline_grant_replay.sql",
  rollback_target: null,
  compose_sha256: checksum(compose),
  server_image: Object.freeze({
    index: `registry.example/laundry/server@sha256:${repeated("e")}`,
    linux_arm64: `sha256:${repeated("f")}`,
    linux_amd64: `sha256:${repeated("1")}`,
  }),
  postgres_major: 16,
  postgres_image: `docker.io/library/postgres@sha256:${repeated("2")}`,
});
const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonical(value[key])]),
  );
};
const key = createPrivateKey(await readFile(privateKeyPath));
const signPayload = (value) =>
  sign(null, Buffer.from(JSON.stringify(canonical(value))), key).toString("base64url");
const writeManifest = async (name, value, signature = signPayload(value)) => {
  const path = join(temporary, name);
  await writeFile(path, JSON.stringify({ payload: value, signature }), { mode: 0o600 });
  return path;
};
const signature = signPayload(payload);
const manifest = await writeManifest("runtime-manifest.json", payload, signature);

const execute = (configRoot, runnerLog, args, input = "") =>
  new Promise((resolveRun, rejectRun) => {
    const child = spawn(
      executable,
      ["--test-config-root", configRoot, "--test-runner-log", runnerLog, ...args],
      { cwd: emptyCwd, env: { PATH: "" }, shell: false, stdio: ["pipe", "pipe", "pipe"] },
    );
    const output = [],
      errors = [];
    child.stdout.on("data", (chunk) => output.push(chunk));
    child.stderr.on("data", (chunk) => errors.push(chunk));
    child.once("error", rejectRun);
    child.once("close", (code) => {
      const stdout = Buffer.concat(output).toString("utf8");
      const stderr = Buffer.concat(errors).toString("utf8");
      if (stdout.length > 16_384 || stderr.length > 16_384) {
        rejectRun(new Error("acceptance output exceeded bound"));
      } else resolveRun({ code, stdout, stderr });
    });
    child.stdin.end(input);
  });

const setup = JSON.stringify({
  adminUsername: "owner",
  adminDisplayName: "店长",
  adminPassword: "native-acceptance-password",
  adminPin: "86420987",
});
const assertManifestRejected = async (name, candidate, expected) => {
  const configRoot = join(temporary, `config-manifest-${name}`);
  const runnerLog = join(temporary, `manifest-${name}-runner.jsonl`);
  const result = await execute(configRoot, runnerLog, ["install", "--manifest", candidate], setup);
  assert.equal(result.code, 1);
  assert.match(result.stderr, expected);
  await assert.rejects(() => stat(configRoot), { code: "ENOENT" });
  await assert.rejects(() => stat(runnerLog), { code: "ENOENT" });
};
const tamperPhotoVolume = async (runnerLog) => {
  const path = `${runnerLog}.volumes.json`;
  const original = await readFile(path);
  const volumes = JSON.parse(original.toString("utf8"));
  assert.deepEqual(Object.keys(volumes).sort(), [
    "laundry-desk-runtime_pgdata-v2",
    "laundry-desk-runtime_photos",
  ]);
  volumes["laundry-desk-runtime_photos"] = {
    ...volumes["laundry-desk-runtime_photos"],
    "com.laundry-desk.instance": "foreign-instance",
  };
  await writeFile(path, JSON.stringify(volumes), { mode: 0o600 });
  return async () => writeFile(path, original, { mode: 0o600 });
};

const tamperedManifest = await writeManifest(
  "runtime-manifest-tampered.json",
  { ...payload, web_bundle_sha256: repeated("9") },
  signature,
);
const newerAppManifest = await writeManifest("runtime-manifest-newer-app.json", {
  ...payload,
  minimum_app_version: "0.2.0",
});
const contractsMismatchManifest = await writeManifest("runtime-manifest-contracts-mismatch.json", {
  ...payload,
  contracts_major: 3,
});
const invalidRollbackManifest = await writeManifest("runtime-manifest-invalid-rollback.json", {
  ...payload,
  rollback_target: {
    release: payload.release,
    server_image_index: payload.server_image.index,
    maximum_compatible_schema: payload.migration_head,
  },
});
const unpinnedPostgresManifest = await writeManifest("runtime-manifest-unpinned-postgres.json", {
  ...payload,
  postgres_image: "postgres:16",
});

for (const [name, candidate, expected] of [
  ["tampered", tamperedManifest, /RUNTIME_MANIFEST_SIGNATURE_INVALID/u],
  ["newer-app", newerAppManifest, /RUNTIME_MANIFEST_INCOMPATIBLE/u],
  ["contracts-mismatch", contractsMismatchManifest, /RUNTIME_MANIFEST_INCOMPATIBLE/u],
  ["invalid-rollback", invalidRollbackManifest, /RUNTIME_MANIFEST_INVALID/u],
  ["unpinned-postgres", unpinnedPostgresManifest, /RUNTIME_MANIFEST_INVALID/u],
]) {
  await assertManifestRejected(name, candidate, expected);
}

const preexistingRoot = join(temporary, "config-preexisting-photo");
const preexistingLog = join(temporary, "preexisting-runner.jsonl");
await writeFile(
  `${preexistingLog}.volumes.json`,
  JSON.stringify({
    "laundry-desk-runtime_photos": {
      "com.laundry-desk.managed": "true",
      "com.laundry-desk.project": "laundry-desk-runtime",
      "com.laundry-desk.instance": "foreign-instance",
    },
  }),
  { mode: 0o600 },
);
let result = await execute(
  preexistingRoot,
  preexistingLog,
  ["install", "--manifest", manifest],
  setup,
);
assert.equal(result.code, 1);
assert.match(result.stderr, /RUNTIME_RECOVERY_REQUIRED/u);
await assert.rejects(() => stat(join(preexistingRoot, "state.json")), { code: "ENOENT" });

const wrongDigestRoot = join(temporary, "config-wrong-index");
const wrongDigestLog = join(temporary, "wrong-index-runner.jsonl");
await writeFile(
  `${wrongDigestLog}.repo-digests.json`,
  JSON.stringify([`registry.example/laundry/server@${payload.server_image.linux_arm64}`]),
  { mode: 0o600 },
);
result = await execute(wrongDigestRoot, wrongDigestLog, ["install", "--manifest", manifest], setup);
assert.equal(result.code, 1);
assert.match(result.stderr, /RUNTIME_IMAGE_METADATA_INVALID/u);

const primaryRoot = join(temporary, "config-primary");
const primaryLog = join(temporary, "primary-runner.jsonl");
result = await execute(primaryRoot, primaryLog, ["install", "--manifest", manifest], setup);
assert.equal(result.code, 0, result.stderr);
assert.equal(JSON.parse(result.stdout).status, "ready");
result = await execute(primaryRoot, primaryLog, ["restart"]);
assert.equal(result.code, 0, result.stderr);
result = await execute(primaryRoot, primaryLog, ["status"]);
assert.equal(result.code, 0, result.stderr);
assert.equal(JSON.parse(result.stdout).ok, true);
const restorePrimaryVolumes = await tamperPhotoVolume(primaryLog);
result = await execute(primaryRoot, primaryLog, ["start"]);
assert.equal(result.code, 1);
assert.match(result.stderr, /RUNTIME_RECOVERY_REQUIRED/u);
result = await execute(primaryRoot, primaryLog, ["stop"]);
assert.equal(result.code, 1);
assert.match(result.stderr, /RUNTIME_RECOVERY_REQUIRED/u);
result = await execute(primaryRoot, primaryLog, ["diagnose"]);
assert.equal(result.code, 0, result.stderr);
assert.equal(JSON.parse(result.stdout).fault_code, "RUNTIME_RECOVERY_REQUIRED");
await restorePrimaryVolumes();
result = await execute(primaryRoot, primaryLog, ["status"]);
assert.equal(JSON.parse(result.stdout).ok, true);
assert.deepEqual((await readdir(join(primaryRoot, "secrets"))).sort(), [
  "access-token-secret",
  "app-password",
  "csrf-proof-secret",
  "database-admin-url",
  "database-url",
  "postgres-password",
]);

const runnerText = await readFile(primaryLog, "utf8");
assert.doesNotMatch(runnerText, /native-acceptance-password|86420987|node|pnpm/u);

const statePath = join(primaryRoot, "state.json");
const hardlinkPath = join(primaryRoot, "state-hardlink");
await link(statePath, hardlinkPath);
result = await execute(primaryRoot, primaryLog, ["diagnose"]);
assert.equal(result.code, 0, result.stderr);
assert.equal(JSON.parse(result.stdout).fault_code, "RUNTIME_RECOVERY_REQUIRED");
await unlink(hardlinkPath);
result = await execute(primaryRoot, primaryLog, ["status"]);
assert.equal(JSON.parse(result.stdout).ok, true);

const faultRoot = join(temporary, "config-fault");
const faultLog = join(temporary, "fault-runner.jsonl");
await writeFile(`${faultLog}.fail-once`, "verify", { mode: 0o600 });
result = await execute(faultRoot, faultLog, ["install", "--manifest", manifest], setup);
assert.equal(result.code, 1);
assert.match(result.stderr, /RUNTIME_COMMAND_FAILED/u);
const restoreFaultVolumes = await tamperPhotoVolume(faultLog);
result = await execute(faultRoot, faultLog, ["recover", "--manifest", manifest]);
assert.equal(result.code, 1);
assert.match(result.stderr, /RUNTIME_RECOVERY_REQUIRED/u);
await restoreFaultVolumes();
result = await execute(faultRoot, faultLog, ["recover", "--manifest", manifest]);
assert.equal(result.code, 0, result.stderr);
assert.equal(JSON.parse(result.stdout).status, "ready");

const invalidRoot = join(temporary, "config-invalid-pin");
result = await execute(
  invalidRoot,
  join(temporary, "invalid-runner.jsonl"),
  ["install", "--manifest", manifest],
  JSON.stringify({ ...JSON.parse(setup), adminPin: "123456789" }),
);
assert.equal(result.code, 1);
assert.match(result.stderr, /RUNTIME_SETUP_INVALID/u);
await assert.rejects(() => stat(invalidRoot), { code: "ENOENT" });

const oversizedRoot = join(temporary, "config-oversized");
result = await execute(
  oversizedRoot,
  join(temporary, "oversized-runner.jsonl"),
  ["install", "--manifest", manifest],
  "x".repeat(4_097),
);
assert.equal(result.code, 1);
assert.match(result.stderr, /RUNTIME_SETUP_STDIN_INVALID/u);
await assert.rejects(() => stat(oversizedRoot), { code: "ENOENT" });

await rm(privateKeyPath, { force: true });
process.stdout.write("RUNTIME_NATIVE_NO_REPO_ACCEPTANCE_OK scenarios=14 manifest_negatives=5\n");

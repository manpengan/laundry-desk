import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { collectCups, collectEdgeQueue, collectUpdateState } from "./support-bundle-edge.mjs";
import {
  parseSupportBundleArguments,
  resolveEdgeUserDataPath,
  runSupportBundle,
  SUPPORT_BUNDLE_MANIFEST,
} from "./support-bundle.mjs";
import {
  installSupportBundle,
  readManagedFile,
  readManagedJson,
  redactSupportText,
  SUPPORT_BUNDLE_MAXIMUM_BYTES,
} from "./support-bundle-safety.mjs";

const temporaryRoots = [];
const FIXED_NOW = new Date("2026-07-31T04:05:06.000Z");
const QUEUE_ID = "00000000-0000-4000-8000-000000000001";
const CUPS_ARTIFACT = `${QUEUE_ID}-xp58-0001.txt`;
const UPDATE_NONCE = "00000000-0000-4000-8000-000000000002";
const JWT = "headerABC.payloadDEF.signatureGHI";
const BEARER = "bearer-secret-value-123456789";
const PASSWORD = "password-secret-123";
const PHONE = "13812345678";
const URL_PASSWORD = "url-password-secret";
const PEM_SECRET = "private-key-secret-material";
const QUEUE_PLAINTEXT = "queue-plaintext-secret";
const QUEUE_CIPHERTEXT = Buffer.from("queue-ciphertext-secret").toString("base64");
const INSTANCE_ID = "0123456789abcdefghijklmn";
const UNLABELED_LOG_SECRET = "unlabeled-log-secret-that-no-redactor-could-classify";

test.afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function temporaryRoot(name = "laundry-support-") {
  const path = await realpath(await mkdtemp(join(tmpdir(), name)));
  temporaryRoots.push(path);
  return path;
}

async function privateDirectory(path, mode = 0o700) {
  await mkdir(path, { recursive: true, mode });
  await chmod(path, mode);
  return path;
}

async function writeExact(path, contents, mode) {
  await writeFile(path, contents, { mode });
  await chmod(path, mode);
}

async function writeJson(path, value, mode = 0o600) {
  await writeExact(path, `${JSON.stringify(value)}\n`, mode);
}

async function createFixture() {
  const root = await temporaryRoot();
  const configDirectory = await privateDirectory(join(root, "local-config"));
  const edgeUserDataRoot = await privateDirectory(join(root, "edge-user-data"));
  const edgeStateRoot = await privateDirectory(join(edgeUserDataRoot, "edge-state"));
  const updateRoot = await privateDirectory(join(edgeUserDataRoot, "updates"));
  const repositoryRoot = await privateDirectory(join(root, "repository"), 0o755);
  const edgePackageRoot = await privateDirectory(join(repositoryRoot, "apps", "edge-agent"), 0o755);
  const migrationRoot = await privateDirectory(
    join(repositoryRoot, "packages", "db", "src", "migrations"),
    0o755,
  );
  await writeJson(
    join(repositoryRoot, "package.json"),
    { name: "laundry-desk", version: "0.1.0" },
    0o644,
  );
  await writeJson(
    join(edgePackageRoot, "package.json"),
    { name: "@laundry/edge-agent", version: "0.1.0" },
    0o644,
  );
  await writeExact(join(migrationRoot, "0001_roles.sql"), "SELECT 1;\n", 0o644);
  await writeExact(join(migrationRoot, "0002_runtime.sql"), "SELECT 2;\n", 0o644);
  await writeJson(join(edgeStateRoot, "offline-queue.json"), {
    version: 1,
    rows: [
      {
        id: QUEUE_ID,
        seq: 1,
        sealed_payload: QUEUE_CIPHERTEXT,
        aad: QUEUE_PLAINTEXT,
        state: "inflight",
      },
    ],
  });
  await writeJson(join(edgeUserDataRoot, "cups-worker-state.json"), {
    version: 1,
    records: [
      {
        artifact: CUPS_ARTIFACT,
        sha256: "a".repeat(64),
        state: "submitting",
        cups_job_id: "Store_XP58-42",
        updated_at: 1_753_937_106_000,
      },
    ],
  });
  await writeJson(join(updateRoot, "update-state.json"), {
    version: 1,
    active_slot: "B",
    slots: {
      A: {
        version: "0.1.0",
        app_path: join(root, "secret-slot-A.app"),
        artifact_sha256: "b".repeat(64),
        healthy: true,
      },
      B: {
        version: "0.2.0",
        app_path: join(root, "secret-slot-B.app"),
        artifact_sha256: "c".repeat(64),
        healthy: true,
      },
    },
    minimum_secure_version: "0.1.0",
    pending_activation: {
      slot: "B",
      previous_slot: "A",
      nonce: UPDATE_NONCE,
      started_at: FIXED_NOW.toISOString(),
      launch_started: true,
    },
    history: [
      {
        at: FIXED_NOW.toISOString(),
        event: "slot_activated",
        slot: "B",
        version: "0.2.0",
      },
    ],
  });
  return Object.freeze({
    root,
    configDirectory,
    edgeUserDataRoot,
    edgeStateRoot,
    updateRoot,
    repositoryRoot,
    edgePackageRoot,
    migrationRoot,
  });
}

function secretLogs(fixture) {
  return [
    `authorization: Bearer ${BEARER}`,
    `jwt=${JWT}`,
    `password=${PASSWORD} csrf_token=csrf-secret-value PIN=987654`,
    `cookie=session-cookie-secret token=token-secret-value`,
    `postgresql://operator:${URL_PASSWORD}@127.0.0.1:5432/laundry`,
    `customer=${PHONE}`,
    `path=${fixture.configDirectory}/config.json`,
    `edge=${fixture.edgeUserDataRoot}/edge-state/offline-queue.json`,
    `unexpected failure detail ${UNLABELED_LOG_SECRET}`,
    "fatal fixed-marker",
    `-----BEGIN PRIVATE KEY-----\n${PEM_SECRET}\n-----END PRIVATE KEY-----`,
  ].join("\n");
}

function diagnoseReport() {
  return Object.freeze({
    ok: true,
    project: "laundry-desk",
    config: Object.freeze({ valid: true, instance_id: INSTANCE_ID }),
    api: Object.freeze({ reachable: true, ready: true }),
    compose: Object.freeze({ reachable: true, services_reported: true }),
    storage: Object.freeze({
      free_bytes: 123_456,
      photos: Object.freeze({ exists: true, valid: true, entries: 2 }),
      backups: Object.freeze({ exists: false, entries: 0 }),
    }),
    maintenance: Object.freeze({
      ok: true,
      status: "healthy",
      age_seconds: 60,
      last_backup_at: FIXED_NOW.toISOString(),
      last_drill_at: null,
    }),
  });
}

function dependenciesFor(fixture, options = Object.freeze({})) {
  const logs = options.logs ?? secretLogs(fixture);
  return Object.freeze({
    resolveLocalConfigPaths: () =>
      Object.freeze({
        directoryPath: fixture.configDirectory,
        filePath: join(fixture.configDirectory, "config.json"),
      }),
    resolveEdgeUserDataPath: () => fixture.edgeUserDataRoot,
    repositoryRoot: fixture.repositoryRoot,
    edgePackageRoot: fixture.edgePackageRoot,
    migrationRoot: fixture.migrationRoot,
    platform: "darwin",
    arch: "arm64",
    nodeVersion: "v22.17.0",
    homeDir: fixture.root,
    now: () => FIXED_NOW,
    randomBytes: () => Buffer.alloc(12, options.randomByte ?? 7),
    runDiagnose: async () => diagnoseReport(),
    probeHealthEndpoint: async () => Object.freeze({ reachable: true, ready: true }),
    capture: async (command) => {
      if (command.args.includes("logs")) return logs;
      const stateIndex = command.args.indexOf("--status");
      if (stateIndex < 0) throw new Error("unexpected command");
      const state = command.args[stateIndex + 1];
      if (state === "running") return "postgres\nserver\n";
      if (state === "exited") return "migrate\n";
      return "";
    },
  });
}

test("creates an exact, bounded, private support bundle without source secrets", async () => {
  const fixture = await createFixture();
  let stdout = "";
  const result = await runSupportBundle(
    {
      argv: Object.freeze([]),
      env: Object.freeze({ PATH: "/bin" }),
      cwd: fixture.repositoryRoot,
      stdout: (text) => {
        stdout += text;
      },
    },
    dependenciesFor(fixture),
  );
  const bytes = await readFile(result.path);
  const text = bytes.toString("utf8");
  const bundle = JSON.parse(text);
  const outputDirectory = dirname(result.path);

  assert.deepEqual(bundle.manifest, SUPPORT_BUNDLE_MANIFEST);
  assert.deepEqual(Object.keys(bundle.sections), SUPPORT_BUNDLE_MANIFEST.sections);
  assert.equal(bundle.version, 1);
  assert.equal(bundle.generated_at, FIXED_NOW.toISOString());
  assert.deepEqual(bundle.sections.edge_queue, {
    status: "ok",
    file_status: "valid",
    pending_count: 0,
    inflight_count: 1,
  });
  assert.deepEqual(bundle.sections.diagnostics, {
    status: "ok",
    ok: true,
    api: { reachable: true, ready: true },
    compose: { reachable: true, services_reported: true },
    storage: {
      free_bytes: 123_456,
      photos: { exists: true, valid: true, entries: 2 },
      backups: { exists: false, valid: null, entries: 0 },
    },
    maintenance: { ok: true, status: "healthy", age_seconds: 60 },
  });
  assert.deepEqual(bundle.sections.cups, {
    status: "ok",
    file_status: "valid",
    submitted_count: 0,
    uncertain_count: 1,
    uncertain: true,
  });
  assert.deepEqual(bundle.sections.update_state, {
    status: "ok",
    version: 1,
    active_slot: "B",
    slots: {
      A: { version: "0.1.0", healthy: true },
      B: { version: "0.2.0", healthy: true },
    },
    minimum_secure_version: "0.1.0",
    pending_activation: true,
    history_events: ["slot_activated"],
  });
  assert.deepEqual(bundle.sections.services.compose.services, {
    postgres: "running",
    migrate: "exited",
    bootstrap: "not_found",
    server: "running",
  });
  assert.deepEqual(bundle.sections.server_logs, {
    status: "ok",
    line_count: 13,
    error_marker_count: 1,
    truncated: false,
  });
  assert.deepEqual(bundle.sections.migrations.filenames, ["0001_roles.sql", "0002_runtime.sql"]);

  const forbidden = [
    BEARER,
    JWT,
    PASSWORD,
    "csrf-secret-value",
    "session-cookie-secret",
    "token-secret-value",
    "987654",
    PHONE,
    URL_PASSWORD,
    PEM_SECRET,
    QUEUE_PLAINTEXT,
    QUEUE_CIPHERTEXT,
    CUPS_ARTIFACT,
    "Store_XP58-42",
    UPDATE_NONCE,
    "a".repeat(64),
    "b".repeat(64),
    "c".repeat(64),
    INSTANCE_ID,
    UNLABELED_LOG_SECRET,
    fixture.root,
    fixture.configDirectory,
    fixture.edgeUserDataRoot,
  ];
  for (const secret of forbidden) assert.equal(text.includes(secret), false, secret);
  for (const forbiddenKey of [
    "sealed_payload",
    '"aad"',
    '"artifact"',
    "cups_job_id",
    "app_path",
    "artifact_sha256",
    '"nonce"',
    "instance_id",
  ]) {
    assert.equal(text.includes(forbiddenKey), false, forbiddenKey);
  }
  assert.equal("text" in bundle.sections.server_logs, false);
  assert.equal(result.bytes, bytes.byteLength);
  assert.ok(result.bytes <= SUPPORT_BUNDLE_MAXIMUM_BYTES);
  assert.equal(result.sha256, createHash("sha256").update(bytes).digest("hex"));
  assert.equal((await stat(outputDirectory)).mode & 0o7777, 0o700);
  const metadata = await lstat(result.path);
  assert.equal(metadata.mode & 0o7777, 0o600);
  assert.equal(metadata.nlink, 1);
  assert.deepEqual(
    (await readdir(outputDirectory)).filter((name) => name.startsWith(".")),
    [],
  );
  assert.match(stdout, /Support bundle: .+\nSHA-256: [0-9a-f]{64}\nBytes: \d+\n/u);
  assert.equal(text.includes(result.path), false);
});

test("rejects arguments and derives only the fixed desktop userData path", () => {
  assert.doesNotThrow(() => parseSupportBundleArguments([]));
  assert.doesNotThrow(() => parseSupportBundleArguments(["--"]));
  for (const argv of [
    ["--output", "/tmp/elsewhere"],
    ["--", "--path", "/tmp/elsewhere"],
    ["/tmp/arbitrary.json"],
  ]) {
    assert.throws(() => parseSupportBundleArguments(argv), {
      code: "LOCAL_SUPPORT_ARGS_INVALID",
    });
  }
  assert.equal(
    resolveEdgeUserDataPath({ platform: "darwin", homeDir: "/Users/operator" }),
    "/Users/operator/Library/Application Support/laundry-desk V2",
  );
  assert.equal(
    resolveEdgeUserDataPath({ platform: "linux", homeDir: "/home/operator" }),
    "/home/operator/.config/laundry-desk V2",
  );
  assert.throws(() => resolveEdgeUserDataPath({ platform: "win32", homeDir: "/Users/operator" }), {
    code: "LOCAL_SUPPORT_PLATFORM_UNSUPPORTED",
  });
});

test("atomically installs with O_EXCL staging and never overwrites a managed result", async () => {
  const fixture = await createFixture();
  const bytes = Buffer.from('{"version":1}\n');
  const installDependencies = Object.freeze({
    now: () => FIXED_NOW,
    randomBytes: () => Buffer.alloc(12, 9),
  });
  const first = await installSupportBundle(fixture.configDirectory, bytes, installDependencies);
  await assert.rejects(
    () =>
      installSupportBundle(
        fixture.configDirectory,
        Buffer.from("replacement"),
        installDependencies,
      ),
    { code: "LOCAL_SUPPORT_INSTALL_FAILED" },
  );
  assert.deepEqual(await readFile(first.path), bytes);

  const stagingDependencies = Object.freeze({
    now: () => new Date("2026-07-31T04:05:07.000Z"),
    randomBytes: () => Buffer.alloc(12, 8),
  });
  const outputDirectory = dirname(first.path);
  const staging = join(
    outputDirectory,
    `.laundry-v2-support-20260731T040507Z-${Buffer.alloc(12, 8).toString("hex")}.json.staging`,
  );
  await writeExact(staging, "do-not-overwrite", 0o600);
  await assert.rejects(
    () => installSupportBundle(fixture.configDirectory, bytes, stagingDependencies),
    { code: "LOCAL_SUPPORT_STAGING_FAILED" },
  );
  assert.equal(await readFile(staging, "utf8"), "do-not-overwrite");
  await assert.rejects(
    () =>
      installSupportBundle(
        fixture.configDirectory,
        Buffer.alloc(SUPPORT_BUNDLE_MAXIMUM_BYTES + 1),
        installDependencies,
      ),
    { code: "LOCAL_SUPPORT_BUNDLE_TOO_LARGE" },
  );
});

test("managed readers reject traversal, symlink, hardlink, broad mode, oversize, and invalid JSON", async () => {
  const root = await privateDirectory(join(await temporaryRoot(), "sources"));
  const path = join(root, "state.json");
  await writeJson(path, { version: 1 });
  assert.deepEqual(await readManagedJson(root, "state.json", 1_024), { version: 1 });
  const symlinkRoot = join(dirname(root), "source-root-link");
  await symlink(root, symlinkRoot);
  await assert.rejects(() => readManagedFile(symlinkRoot, "state.json", 1_024), {
    code: "LOCAL_SUPPORT_DIRECTORY_INVALID",
  });
  await assert.rejects(() => readManagedFile(root, "../state.json", 1_024), {
    code: "LOCAL_SUPPORT_SOURCE_INVALID",
  });

  await chmod(root, 0o755);
  await assert.rejects(() => readManagedFile(root, "state.json", 1_024), {
    code: "LOCAL_SUPPORT_DIRECTORY_INVALID",
  });
  await chmod(root, 0o700);
  await chmod(path, 0o644);
  await assert.rejects(() => readManagedFile(root, "state.json", 1_024), {
    code: "LOCAL_SUPPORT_SOURCE_INVALID",
  });
  await rm(path);
  const target = join(dirname(root), "target.json");
  await writeJson(target, { version: 1 });
  await symlink(target, path);
  await assert.rejects(() => readManagedFile(root, "state.json", 1_024), {
    code: "LOCAL_SUPPORT_SOURCE_INVALID",
  });
  await rm(path);
  const hardlinkSource = join(dirname(root), "hardlink.json");
  await writeJson(hardlinkSource, { version: 1 });
  await link(hardlinkSource, path);
  await assert.rejects(() => readManagedFile(root, "state.json", 1_024), {
    code: "LOCAL_SUPPORT_SOURCE_INVALID",
  });
  await rm(path);
  await writeExact(path, "x".repeat(1_025), 0o600);
  await assert.rejects(() => readManagedFile(root, "state.json", 1_024), {
    code: "LOCAL_SUPPORT_SOURCE_INVALID",
  });
  await writeExact(path, "{not-json", 0o600);
  await assert.rejects(() => readManagedJson(root, "state.json", 1_024), {
    code: "LOCAL_SUPPORT_SOURCE_INVALID",
  });
  await rm(path);
  await mkdir(path, { mode: 0o700 });
  await assert.rejects(() => readManagedFile(root, "state.json", 1_024), {
    code: "LOCAL_SUPPORT_SOURCE_INVALID",
  });
});

test("private collectors fail closed on malicious extra fields without echoing them", async () => {
  const fixture = await createFixture();
  const secret = "malicious-extra-field-secret";
  await writeJson(join(fixture.edgeStateRoot, "offline-queue.json"), {
    version: 1,
    rows: [],
    extra: secret,
  });
  await writeJson(join(fixture.edgeUserDataRoot, "cups-worker-state.json"), {
    version: 1,
    records: [],
    password: secret,
  });
  const update = JSON.parse(await readFile(join(fixture.updateRoot, "update-state.json"), "utf8"));
  await writeJson(join(fixture.updateRoot, "update-state.json"), {
    ...update,
    token: secret,
  });
  assert.deepEqual(await collectEdgeQueue(fixture), {
    status: "unavailable",
    code: "EDGE_QUEUE_UNAVAILABLE",
  });
  assert.deepEqual(await collectCups(fixture), {
    status: "unavailable",
    code: "CUPS_STATE_UNAVAILABLE",
  });
  assert.deepEqual(await collectUpdateState(fixture), {
    status: "unavailable",
    code: "UPDATE_STATE_UNAVAILABLE",
  });
  assert.equal(JSON.stringify(await collectEdgeQueue(fixture)).includes(secret), false);
});

test("redactor removes credential classes, Chinese phones, PEM, and absolute home paths", () => {
  const home = "/Users/private-operator";
  const input = [
    `Bearer ${BEARER}`,
    JWT,
    `authorization=${BEARER}`,
    `Cookie: first=${PASSWORD}; second=cookie-second-secret`,
    `cookie='${PASSWORD}'`,
    `password=${PASSWORD}`,
    `operator_password="quoted password secret"`,
    `LAUNDRY_ACCESS_TOKEN_SECRET=environment-secret`,
    `"bootstrap_admin_password":"json-password-secret"`,
    `csrf-proof=csrf-secret`,
    `PIN 123456`,
    `postgresql://user:${URL_PASSWORD}@database/laundry`,
    PHONE,
    "+86 13912345678",
    `${home}/Library/Application Support/laundry-desk V2/config.json`,
    `-----BEGIN PRIVATE KEY-----\n${PEM_SECRET}\n-----END PRIVATE KEY-----`,
  ].join("\n");
  const output = redactSupportText(input, [home]);
  for (const secret of [
    BEARER,
    JWT,
    PASSWORD,
    URL_PASSWORD,
    PHONE,
    "13912345678",
    PEM_SECRET,
    home,
    "csrf-secret",
    "123456",
    "environment-secret",
    "json-password-secret",
    "cookie-second-secret",
    "quoted password secret",
  ]) {
    assert.equal(output.includes(secret), false, secret);
  }
});

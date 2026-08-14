import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { assembleReleaseCandidate } from "../release-candidate/assemble.mjs";
import { buildVerifier } from "../release-candidate/build-verifier.mjs";
import { loadOciIndex, parseAssemblyInput } from "../release-candidate/evidence.mjs";
import {
  COUNTER_MANIFEST_DOMAIN,
  RELEASE_DOMAIN,
  canonicalJson,
  sha256,
  signAuthority,
  validateCounterManifest,
  validateEnvelope,
  validateRuntimeManifest,
} from "../release-candidate/schema.mjs";
import { describeAppTree, describeFile } from "../release-candidate/safe-io.mjs";

const execute = promisify(execFile);
const repositoryRoot = resolve(import.meta.dirname, "../..");
const version = "0.1.0";
const gitSha = "1234567890abcdef1234567890abcdef12345678";
const stamp = "2026-08-08T00:00:00.000Z";
const hex = (character) => character.repeat(64);

async function writeJSON(path, value, mode = 0o600) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode });
}

async function createApp(root, name, executableName, resources) {
  const app = join(root, name);
  const macOS = join(app, "Contents/MacOS");
  await mkdir(macOS, { recursive: true });
  await writeFile(join(macOS, executableName), "fixture executable\n", { mode: 0o755 });
  for (const [relativePath, bytes] of Object.entries(resources)) {
    const path = join(app, "Contents/Resources", relativePath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes, { mode: 0o644 });
  }
  await symlink(executableName, join(macOS, "current"));
  return app;
}

async function copyAppTreeForTesting(file, args) {
  assert.equal(file, "/usr/bin/ditto");
  assert.deepEqual(args.slice(0, 3), ["--rsrc", "--extattr", "--acl"]);
  const source = args.at(-2);
  const destination = args.at(-1);
  assert.equal(typeof source, "string");
  assert.equal(typeof destination, "string");
  await cp(source, destination, {
    recursive: true,
    verbatimSymlinks: true,
    preserveTimestamps: true,
  });
  return Object.freeze({ stderr: "", stdout: "" });
}

function ociIndex(amd64, arm64) {
  return {
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.index.v1+json",
    manifests: [
      {
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        digest: amd64,
        size: 100,
        platform: { architecture: "amd64", os: "linux" },
      },
      {
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        digest: arm64,
        size: 101,
        platform: { architecture: "arm64", os: "linux" },
      },
    ],
  };
}

async function signedCounterManifest(path, key, dmg, zip) {
  const artifacts = await Promise.all([describeFile(dmg, dmg), describeFile(zip, zip)]);
  const authority = {
    protocol_version: 1,
    channel: "stable",
    version,
    minimum_secure_version: version,
    minimum_upgradable_version: "0.0.0",
    contracts_major: 2,
    local_schema: 45,
    published_at: stamp,
    artifacts: [
      {
        kind: "dmg",
        name: artifacts[0].path.split("/").at(-1),
        size_bytes: artifacts[0].size_bytes,
        sha256: artifacts[0].sha256,
      },
      {
        kind: "zip",
        name: artifacts[1].path.split("/").at(-1),
        size_bytes: artifacts[1].size_bytes,
        sha256: artifacts[1].sha256,
      },
    ],
    rollback: null,
  };
  const signature = sign(
    null,
    Buffer.from(`${COUNTER_MANIFEST_DOMAIN}${canonicalJson(authority)}\n`),
    key,
  ).toString("base64");
  await writeJSON(path, { authority, signature }, 0o644);
}

async function signedRuntimeManifest(path, key, serverIndex, postgresIndex, arch) {
  const serverDigest = `sha256:${sha256(await readFile(serverIndex))}`;
  const postgresDigest = `sha256:${sha256(await readFile(postgresIndex))}`;
  const payload = {
    schema_version: 2,
    product: "laundry-desk-runtime",
    release: version,
    contracts_major: 2,
    contracts_sha256: hex("1"),
    server_version: version,
    web_bundle_sha256: hex("2"),
    minimum_app_version: version,
    database_schema_sha256: hex("3"),
    migrations_sha256: hex("4"),
    migration_head: "0045_fixture.sql",
    maximum_compatible_schema: "0045_fixture.sql",
    rollback_target: null,
    compose_sha256: hex("5"),
    lan_compose_sha256: hex("6"),
    owner_spa_sha256: hex("7"),
    server_image: {
      index: `registry.example/laundry/server@${serverDigest}`,
      linux_arm64: arch.arm64,
      linux_amd64: arch.amd64,
    },
    postgres_major: 16,
    postgres_image: `docker.io/library/postgres@${postgresDigest}`,
  };
  const signature = sign(null, Buffer.from(canonicalJson(payload)), key).toString("base64url");
  await writeJSON(path, { payload, signature }, 0o644);
  return { postgresDigest, serverDigest };
}

const passedChecks = Object.freeze({
  counter_codesign: true,
  counter_gatekeeper: true,
  counter_stapler: true,
  runtime_codesign: true,
  runtime_gatekeeper: true,
  runtime_stapler: true,
  verifier_codesign: true,
  verifier_gatekeeper: true,
  verifier_stapler: true,
});

async function fixture(t) {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), "laundry-rc-fixture-")));
  t.after(async () => rm(temporary, { recursive: true, force: true }));
  const source = join(temporary, "source");
  await mkdir(source, { recursive: true });
  const counterKeys = generateKeyPairSync("ed25519");
  const runtimeKeys = generateKeyPairSync("ed25519");
  const counterPublic = counterKeys.publicKey.export({ format: "pem", type: "spki" });
  const runtimeSPKI = runtimeKeys.publicKey.export({ format: "der", type: "spki" });
  const runtimePublic = `${runtimeSPKI.subarray(-32).toString("base64url")}\n`;
  const counterApp = await createApp(source, "Laundry Desk Counter.app", "Counter", {
    "update/update-public-key.pem": counterPublic,
  });
  const runtimeApp = await createApp(source, "Laundry Desk Runtime.app", "Runtime", {
    "trusted-manifest-public-key.txt": runtimePublic,
  });
  const verifierApp = join(source, "Laundry Desk Release Candidate Verifier.app");
  if (process.platform === "darwin") {
    await buildVerifier({ mode: "testing", output: verifierApp });
  } else {
    await createApp(
      source,
      "Laundry Desk Release Candidate Verifier.app",
      "Laundry Desk Release Candidate Verifier",
      {},
    );
  }
  const counterDmg = join(source, "laundry-counter.dmg");
  const counterZip = join(source, "laundry-counter.zip");
  const runtimeDmg = join(source, "laundry-runtime.dmg");
  const runtimeZip = join(source, "laundry-runtime.zip");
  await Promise.all([
    writeFile(counterDmg, "counter dmg\n"),
    writeFile(counterZip, "counter zip\n"),
    writeFile(runtimeDmg, "runtime dmg\n"),
    writeFile(runtimeZip, "runtime zip\n"),
  ]);
  const arch = { amd64: `sha256:${hex("a")}`, arm64: `sha256:${hex("b")}` };
  const serverIndex = join(source, "server-index.json");
  const postgresIndex = join(source, "postgres-index.json");
  await writeFile(serverIndex, JSON.stringify(ociIndex(arch.amd64, arch.arm64)));
  await writeFile(
    postgresIndex,
    JSON.stringify(ociIndex(`sha256:${hex("c")}`, `sha256:${hex("d")}`)),
  );
  const counterManifest = join(source, "counter-manifest.json");
  const runtimeManifest = join(source, "runtime-manifest.json");
  await signedCounterManifest(counterManifest, counterKeys.privateKey, counterDmg, counterZip);
  const digests = await signedRuntimeManifest(
    runtimeManifest,
    runtimeKeys.privateKey,
    serverIndex,
    postgresIndex,
    arch,
  );
  const [counterTree, runtimeTree, verifierTree] = await Promise.all([
    describeAppTree(counterApp, "counter.app"),
    describeAppTree(runtimeApp, "runtime.app"),
    describeAppTree(verifierApp, "verifier.app"),
  ]);
  const transfer = join(source, "transfer.json");
  const clean = join(source, "clean.json");
  const xp58 = join(source, "xp58.json");
  await writeJSON(transfer, {
    assurance: "software_only",
    cleanup: "clean",
    completed_at: stamp,
    database_sha256: hex("8"),
    git_sha: gitSha,
    kind: "runtime_real_container_transfer",
    photos_sha256: hex("9"),
    postgres_image_digest: digests.postgresDigest,
    product_version: version,
    roots: 2,
    schema_version: 1,
    server_image_digest: digests.serverDigest,
    status: "passed",
  });
  await writeJSON(clean, {
    assurance: "software_only",
    checks: passedChecks,
    counter_app_tree_sha256: counterTree.tree_sha256,
    git_sha: gitSha,
    kind: "clean_second_mac",
    machine_fingerprint_sha256: hex("e"),
    no_repository: true,
    node_or_pnpm_invoked: false,
    os_version: "macOS 15.6",
    product_version: version,
    runtime_app_tree_sha256: runtimeTree.tree_sha256,
    schema_version: 1,
    status: "passed",
    team_identifier: "software_only",
    verified_at: stamp,
    verifier_app_tree_sha256: verifierTree.tree_sha256,
  });
  await writeJSON(xp58, {
    schema_version: 2,
    platform: "darwin",
    printer_family: "xp58",
    app_version: version,
    accepted_at: stamp,
    job_fingerprint: hex("1"),
    snapshot_sha256: hex("2"),
    queue_fingerprint: hex("3"),
    cups_job_fingerprint: hex("4"),
    receipt_seq: 1,
    operator_confirmation: {
      chinese_clear: true,
      amounts_correct: true,
      feed_ok: true,
      cut_or_tear_ok: true,
      barcode_scanned: true,
      disconnect_no_duplicate: true,
      explicit_reprint_one_copy: true,
    },
  });
  const counterPrivate = join(source, "counter-private.pem");
  const runtimePrivate = join(source, "runtime-private.pem");
  await writeFile(counterPrivate, counterKeys.privateKey.export({ format: "pem", type: "pkcs8" }), {
    mode: 0o600,
  });
  await writeFile(runtimePrivate, runtimeKeys.privateKey.export({ format: "pem", type: "pkcs8" }), {
    mode: 0o600,
  });
  const output = join(temporary, "candidate");
  const input = {
    schema_version: 1,
    mode: "testing",
    output_directory: output,
    counter: { app: counterApp, dmg: counterDmg, manifest: counterManifest, zip: counterZip },
    runtime: { app: runtimeApp, dmg: runtimeDmg, manifest: runtimeManifest, zip: runtimeZip },
    oci: { postgres_index: postgresIndex, server_index: serverIndex },
    reports: { clean_second_mac: clean, real_container_transfer: transfer, xp58 },
    testing_identity: { git_sha: gitSha, product_version: version },
    verifier_app: verifierApp,
  };
  const env = {
    LAUNDRY_COUNTER_EVIDENCE_PRIVATE_KEY_FILE: counterPrivate,
    LAUNDRY_RUNTIME_EVIDENCE_PRIVATE_KEY_FILE: runtimePrivate,
  };
  const copyExecute = process.platform === "darwin" ? undefined : copyAppTreeForTesting;
  await assembleReleaseCandidate(input, { env, copyExecute });
  return { copyExecute, env, input, output, temporary };
}

async function runVerifier(root, cwd) {
  const executable = join(
    root,
    "verifier/Laundry Desk Release Candidate Verifier.app/Contents/MacOS/Laundry Desk Release Candidate Verifier",
  );
  try {
    return await execute(executable, [root], { cwd, encoding: "utf8", env: { PATH: "" } });
  } catch (error) {
    const details = {
      code: error?.code ?? null,
      signal: error?.signal ?? null,
      stderr: typeof error?.stderr === "string" ? error.stderr : null,
      stdout: typeof error?.stdout === "string" ? error.stdout : null,
    };
    throw new Error(`RC_TEST_VERIFIER_FAILED ${JSON.stringify(details)}`, { cause: error });
  }
}

async function cloneCandidate(setup, name) {
  const target = join(setup.temporary, name);
  await cp(setup.output, target, { recursive: true, verbatimSymlinks: true });
  return target;
}

test(
  "universal native candidate verifier works without repo, PATH, Node, or cwd state",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const setup = await fixture(t);
    const empty = join(setup.temporary, "empty-cwd");
    await mkdir(empty);
    const result = await runVerifier(setup.output, empty);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), {
      assurance: "software_only",
      git_sha: gitSha,
      ok: true,
      product_version: version,
      release_authority_sha256: JSON.parse(
        await readFile(join(setup.output, "field-evidence.json"), "utf8"),
      ).authority.release_authority_sha256,
    });
  },
);

test("native verifier scopes Darwin output buffers to contiguous storage", async () => {
  const source = await readFile(
    join(repositoryRoot, "tools/release-candidate/Sources/SafeIO.swift"),
    "utf8",
  );
  assert.doesNotMatch(source, /Darwin\.read\(\s*descriptor,\s*&buffer/u);
  assert.doesNotMatch(source, /Darwin\.readlink\([^,]+,\s*&buffer/u);
  assert.doesNotMatch(source, /Darwin\.realpath\([^,]+,\s*&buffer/u);
  assert.match(source, /withUnsafeMutableBytes/u);
  assert.match(source, /withUnsafeMutableBufferPointer/u);
});

test("software-only candidate assembly is complete and repeatable on every platform", async (t) => {
  const setup = await fixture(t);
  const firstRelease = await readFile(join(setup.output, "release-evidence.json"), "utf8");
  const firstField = await readFile(join(setup.output, "field-evidence.json"), "utf8");
  assert.equal(JSON.parse(firstRelease).authority.assurance, "software_only");
  assert.equal(JSON.parse(firstField).authority.assurance, "software_only");
  assert.equal(
    (await readdir(setup.output, { recursive: true })).some((name) => name.includes("private.pem")),
    false,
  );

  const repeatedOutput = join(setup.temporary, "candidate-repeat");
  const repeated = await assembleReleaseCandidate(
    { ...setup.input, output_directory: repeatedOutput },
    { env: setup.env, copyExecute: setup.copyExecute },
  );
  assert.equal(repeated.assurance, "software_only");
  assert.equal(await readFile(join(repeatedOutput, "release-evidence.json"), "utf8"), firstRelease);
  assert.equal(await readFile(join(repeatedOutput, "field-evidence.json"), "utf8"), firstField);
});

test(
  "portable verifier rejects artifact, key, OCI, report, extra, and missing-field tampering",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const setup = await fixture(t);
    const cases = [
      [
        "artifact",
        "artifacts/counter/laundry-counter.dmg",
        async (path) => writeFile(path, "tampered"),
      ],
      [
        "key",
        "artifacts/counter/Laundry Desk Counter.app/Contents/Resources/update/update-public-key.pem",
        async (path) => writeFile(path, "tampered"),
      ],
      ["oci", "evidence/server-oci-index.json", async (path) => writeFile(path, "{}")],
      ["report", "evidence/xp58.json", async (path) => writeFile(path, "{}")],
      ["extra", "unexpected.txt", async (path) => writeFile(path, "extra")],
    ];
    for (const [name, relativePath, mutate] of cases) {
      const candidate = await cloneCandidate(setup, `tamper-${name}`);
      await mutate(join(candidate, relativePath));
      await assert.rejects(() => runVerifier(candidate, setup.temporary));
    }
    const missing = await cloneCandidate(setup, "tamper-missing");
    const fieldPath = join(missing, "field-evidence.json");
    await chmod(fieldPath, 0o600);
    const field = JSON.parse(await readFile(fieldPath, "utf8"));
    delete field.authority.xp58;
    await writeFile(fieldPath, canonicalJson(field));
    await assert.rejects(() => runVerifier(missing, setup.temporary));
  },
);

test("formal schema and required macOS gate are frozen on every platform", async () => {
  const root = resolve(tmpdir(), "laundry-release-candidate-static");
  assert.throws(
    () =>
      parseAssemblyInput({
        schema_version: 1,
        mode: "formal",
        output_directory: `${root}/output`,
        counter: {
          app: `${root}/Counter.app`,
          dmg: `${root}/counter.dmg`,
          manifest: `${root}/counter-manifest.json`,
          zip: `${root}/counter.zip`,
        },
        runtime: {
          app: `${root}/Runtime.app`,
          dmg: `${root}/runtime.dmg`,
          manifest: `${root}/runtime-manifest.json`,
          zip: `${root}/runtime.zip`,
        },
        oci: {
          postgres_index: `${root}/postgres-index.json`,
          server_index: `${root}/server-index.json`,
        },
        reports: {
          clean_second_mac: `${root}/clean-second-mac.json`,
          real_container_transfer: `${root}/real-container-transfer.json`,
        },
        testing_identity: null,
        verifier_app: `${root}/Verifier.app`,
      }),
    /RC_ASSEMBLY_INPUT_INVALID/u,
  );
  const packageJson = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
  assert.equal(
    packageJson.scripts["release:candidate:test"],
    "node --test tools/local/release-candidate.test.mjs",
  );
  assert.equal(
    packageJson.scripts["release:candidate:assemble"],
    "node tools/release-candidate/assemble.mjs",
  );
  assert.equal(
    packageJson.scripts["release:candidate:verifier"],
    "node tools/release-candidate/build-verifier.mjs",
  );
  const foundation = await readFile(
    join(repositoryRoot, ".github/workflows/foundation.yml"),
    "utf8",
  );
  assert.match(
    foundation,
    /pnpm run release:candidate:swift:check && pnpm run release:candidate:test/u,
  );
});

test("release and field authorities require two distinct Ed25519 keys", () => {
  const key = generateKeyPairSync("ed25519");
  assert.throws(
    () => signAuthority({}, RELEASE_DOMAIN, key.privateKey, key.privateKey),
    /RC_EVIDENCE_KEYS_NOT_DISTINCT/u,
  );
  const signature = sign(null, Buffer.from(`${RELEASE_DOMAIN}{}\n`), key.privateKey).toString(
    "base64url",
  );
  assert.throws(
    () =>
      validateEnvelope(
        {
          authority: {},
          counter_signature: signature,
          runtime_signature: signature,
          schema_version: 1,
        },
        (authority) => authority,
        RELEASE_DOMAIN,
        key.publicKey,
        key.publicKey,
      ),
    /RC_EVIDENCE_KEYS_NOT_DISTINCT/u,
  );
});

test("Node manifest and OCI validation matches the portable verifier", async (t) => {
  const counterKey = generateKeyPairSync("ed25519");
  const runtimeKey = generateKeyPairSync("ed25519");
  const counter = {
    artifacts: [
      { kind: "dmg", name: "counter.dmg", sha256: hex("a"), size_bytes: 1 },
      { kind: "zip", name: "counter.zip", sha256: hex("b"), size_bytes: 1 },
    ],
    channel: "stable",
    contracts_major: 2,
    local_schema: 45,
    minimum_secure_version: version,
    minimum_upgradable_version: "0.0.0",
    protocol_version: 1,
    published_at: stamp,
    rollback: null,
    version,
  };
  const signedCounter = (authority) => ({
    authority,
    signature: sign(
      null,
      Buffer.from(`${COUNTER_MANIFEST_DOMAIN}${canonicalJson(authority)}\n`),
      counterKey.privateKey,
    ).toString("base64"),
  });
  for (const invalid of [
    { ...counter, minimum_secure_version: "invalid" },
    { ...counter, minimum_upgradable_version: "invalid" },
    { ...counter, contracts_major: "2" },
    { ...counter, local_schema: -1 },
    { ...counter, rollback: { unexpected: true } },
    {
      ...counter,
      rollback: {
        artifact_sha256: "invalid",
        max_compatible_local_schema: -1,
        target_version: "invalid",
      },
    },
  ]) {
    assert.throws(
      () => validateCounterManifest(signedCounter(invalid), counterKey.publicKey),
      /RC_COUNTER_MANIFEST_INVALID/u,
    );
  }

  const runtime = {
    schema_version: 2,
    product: "laundry-desk-runtime",
    release: version,
    contracts_major: 2,
    contracts_sha256: hex("1"),
    server_version: version,
    web_bundle_sha256: hex("2"),
    minimum_app_version: version,
    database_schema_sha256: hex("3"),
    migrations_sha256: hex("4"),
    migration_head: "0045_fixture.sql",
    maximum_compatible_schema: "0045_fixture.sql",
    rollback_target: null,
    compose_sha256: hex("5"),
    lan_compose_sha256: hex("6"),
    owner_spa_sha256: hex("7"),
    server_image: {
      index: `registry.example/laundry/server@sha256:${hex("8")}`,
      linux_arm64: `sha256:${hex("9")}`,
      linux_amd64: `sha256:${hex("a")}`,
    },
    postgres_major: 16,
    postgres_image: `docker.io/library/postgres@sha256:${hex("b")}`,
  };
  const signedRuntime = (payload) => ({
    payload,
    signature: sign(null, Buffer.from(canonicalJson(payload)), runtimeKey.privateKey).toString(
      "base64url",
    ),
  });
  for (const invalid of [
    { ...runtime, contracts_major: 0 },
    ...[
      "compose_sha256",
      "contracts_sha256",
      "database_schema_sha256",
      "migrations_sha256",
      "web_bundle_sha256",
      "lan_compose_sha256",
      "owner_spa_sha256",
    ].map((name) => ({ ...runtime, [name]: "invalid" })),
  ]) {
    assert.throws(
      () => validateRuntimeManifest(signedRuntime(invalid), runtimeKey.publicKey),
      /RC_RUNTIME_MANIFEST_INVALID/u,
    );
  }

  const temporary = await realpath(await mkdtemp(join(tmpdir(), "laundry-rc-oci-")));
  t.after(async () => rm(temporary, { recursive: true, force: true }));
  const platforms = { amd64: `sha256:${hex("c")}`, arm64: `sha256:${hex("d")}` };
  const baseIndex = ociIndex(platforms.amd64, platforms.arm64);
  const invalidIndexes = [
    {
      ...baseIndex,
      manifests: baseIndex.manifests.map((entry, index) =>
        index === 0 ? { ...entry, urls: Array(33).fill("https://invalid.example") } : entry,
      ),
    },
    { ...baseIndex, annotations: { example: "😀".repeat(1025) } },
    {
      ...baseIndex,
      manifests: baseIndex.manifests.map((entry, index) =>
        index === 0 ? { ...entry, urls: ["😀".repeat(1024)] } : entry,
      ),
    },
  ];
  for (const [index, value] of invalidIndexes.entries()) {
    const path = join(temporary, `invalid-${index}.json`);
    const bytes = Buffer.from(JSON.stringify(value));
    await writeFile(path, bytes);
    await assert.rejects(
      () =>
        loadOciIndex(path, `sha256:${sha256(bytes)}`, {
          amd64: platforms.amd64,
          arm64: platforms.arm64,
        }),
      /RC_OCI_INDEX_INVALID/u,
    );
  }
});

test(
  "assembly waits for concurrent copies before cleaning a failed staging directory",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const setup = await fixture(t);
    const failedInput = {
      ...setup.input,
      output_directory: join(setup.temporary, "failed-candidate"),
      reports: { ...setup.input.reports, xp58: join(setup.temporary, "missing-xp58.json") },
    };
    let finishedCopies = 0;
    const delayedCopy = async (file, args) => {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 75));
      try {
        return await execute(file, args, { encoding: "utf8" });
      } finally {
        finishedCopies += 1;
      }
    };
    await assert.rejects(() =>
      assembleReleaseCandidate(failedInput, { env: setup.env, copyExecute: delayedCopy }),
    );
    assert.equal(finishedCopies, 3);
    assert.deepEqual(
      (await readdir(setup.temporary)).filter((name) =>
        name.startsWith(".laundry-release-candidate-"),
      ),
      [],
    );
  },
);

test(
  "formal assembly credentials fail closed",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const setup = await fixture(t);
    const formal = {
      ...setup.input,
      mode: "formal",
      testing_identity: null,
      output_directory: join(setup.temporary, "formal"),
    };
    assert.throws(
      () => parseAssemblyInput({ ...formal, reports: { ...formal.reports, xp58: undefined } }),
      /RC_ASSEMBLY_INPUT/u,
    );
    const gitCalls = [];
    const gitExecute = async (_file, args, options) => {
      gitCalls.push({ args, env: options.env });
      return { stdout: args.includes("rev-parse") ? `${gitSha}\n` : "", stderr: "" };
    };
    await assert.rejects(
      () => assembleReleaseCandidate(formal, { env: {}, gitExecute }),
      /REQUIRED/u,
    );
    assert.equal(gitCalls.length, 2);
    for (const call of gitCalls) {
      assert.equal("LAUNDRY_COUNTER_EVIDENCE_PRIVATE_KEY_FILE" in call.env, false);
      assert.equal("LAUNDRY_RUNTIME_EVIDENCE_PRIVATE_KEY_FILE" in call.env, false);
      assert.equal(call.env.GIT_CONFIG_GLOBAL, "/dev/null");
      assert.equal(call.env.GIT_CONFIG_NOSYSTEM, "1");
      assert.ok(call.args.includes("core.fsmonitor=false"));
      assert.ok(call.args.includes("core.hooksPath=/dev/null"));
    }
  },
);

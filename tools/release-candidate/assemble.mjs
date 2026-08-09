import { access, chmod, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  assertKeyPair,
  loadCounterPublicKey,
  loadOciIndex,
  loadPrivateKey,
  loadProductManifests,
  loadRuntimePublicKey,
  manifestDigests,
  parseAssemblyInput,
  validateCounterArtifacts,
  validateManifestRelease,
} from "./evidence.mjs";
import { execute, inspectFormalProducts, readGitIdentity } from "./platform.mjs";
import {
  assertFormalStrings,
  validateCleanMacReport,
  validateTransferReport,
  validateXp58Report,
} from "./reports.mjs";
import {
  FIELD_DOMAIN,
  RELEASE_DOMAIN,
  canonicalJson,
  sha256,
  signAuthority,
  validateFieldAuthority,
  validateReleaseAuthority,
} from "./schema.mjs";
import {
  MAX_JSON_BYTES,
  canonicalAbsolutePath,
  copyAppTree,
  copySafeFile,
  describeAppTree,
  describeFile,
  ensureRealDirectory,
  packagePath,
  readStrictJson,
} from "./safe-io.mjs";
import { settleAll } from "./settle.mjs";

const toolRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(toolRoot, "../..");
const KEY_ENVIRONMENT = Object.freeze({
  counter: "LAUNDRY_COUNTER_EVIDENCE_PRIVATE_KEY_FILE",
  runtime: "LAUNDRY_RUNTIME_EVIDENCE_PRIVATE_KEY_FILE",
});

function isInside(root, candidate) {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`));
}

async function assertMissing(path) {
  try {
    await access(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error("RC_OUTPUT_EXISTS");
}

async function liveIdentity(run) {
  const [git, packageBytes] = await Promise.all([
    readGitIdentity(repositoryRoot, run),
    readFile(join(repositoryRoot, "apps/edge-agent/package.json")),
  ]);
  let packageJson;
  try {
    packageJson = JSON.parse(packageBytes.toString("utf8"));
  } catch {
    throw new Error("RC_PRODUCT_VERSION_INVALID");
  }
  const gitSha = git.head.trim();
  if (!/^[0-9a-f]{40}$/u.test(gitSha) || git.status !== "") {
    throw new Error("RC_FORMAL_GIT_NOT_CLEAN");
  }
  if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(packageJson.version)) {
    throw new Error("RC_PRODUCT_VERSION_INVALID");
  }
  return Object.freeze({ gitSha, version: packageJson.version });
}

function keyPaths(env) {
  return Object.fromEntries(
    Object.entries(KEY_ENVIRONMENT).map(([name, key]) => {
      const value = env[key];
      if (typeof value !== "string" || value.length === 0) throw new Error(`${key}_REQUIRED`);
      return [name, canonicalAbsolutePath(value, key)];
    }),
  );
}

function stagedPaths(root, input) {
  const path = (value) => packagePath(root, value);
  return Object.freeze({
    counter: Object.freeze({
      app: path(`artifacts/counter/${basename(input.counter.app)}`),
      dmg: path(`artifacts/counter/${basename(input.counter.dmg)}`),
      manifest: path("evidence/counter-update-manifest.json"),
      zip: path(`artifacts/counter/${basename(input.counter.zip)}`),
    }),
    runtime: Object.freeze({
      app: path(`artifacts/runtime/${basename(input.runtime.app)}`),
      dmg: path(`artifacts/runtime/${basename(input.runtime.dmg)}`),
      manifest: path("evidence/runtime-manifest.json"),
      zip: path(`artifacts/runtime/${basename(input.runtime.zip)}`),
    }),
    oci: Object.freeze({
      postgres: path("evidence/postgres-oci-index.json"),
      server: path("evidence/server-oci-index.json"),
    }),
    reports: Object.freeze({
      clean: path("evidence/clean-second-mac.json"),
      transfer: path("evidence/real-container-transfer.json"),
      xp58: path("evidence/xp58.json"),
    }),
    verifier: path(`verifier/${basename(input.verifier_app)}`),
  });
}

async function copyInputs(input, paths, run) {
  await settleAll([
    copyAppTree(input.counter.app, paths.counter.app, run),
    copyAppTree(input.runtime.app, paths.runtime.app, run),
    copyAppTree(input.verifier_app, paths.verifier, run),
    copySafeFile(input.counter.dmg, paths.counter.dmg),
    copySafeFile(input.counter.zip, paths.counter.zip),
    copySafeFile(input.counter.manifest, paths.counter.manifest, MAX_JSON_BYTES),
    copySafeFile(input.runtime.dmg, paths.runtime.dmg),
    copySafeFile(input.runtime.zip, paths.runtime.zip),
    copySafeFile(input.runtime.manifest, paths.runtime.manifest, MAX_JSON_BYTES),
    copySafeFile(input.oci.server_index, paths.oci.server, 8 * 1024 * 1024),
    copySafeFile(input.oci.postgres_index, paths.oci.postgres, 8 * 1024 * 1024),
    copySafeFile(input.reports.real_container_transfer, paths.reports.transfer, MAX_JSON_BYTES),
    copySafeFile(input.reports.clean_second_mac, paths.reports.clean, MAX_JSON_BYTES),
    copySafeFile(input.reports.xp58, paths.reports.xp58, MAX_JSON_BYTES),
  ]);
}

const relativeTo = (root, path) => relative(root, path).split(sep).join("/");

async function productDescriptor(root, paths, details) {
  const keyName = details.kind === "counter" ? "public_key_spki_sha256" : "public_key_raw_sha256";
  const [app, dmg, zip, manifest] = await Promise.all([
    describeAppTree(paths.app, relativeTo(root, paths.app)),
    describeFile(paths.dmg, relativeTo(root, paths.dmg)),
    describeFile(paths.zip, relativeTo(root, paths.zip)),
    describeFile(paths.manifest, relativeTo(root, paths.manifest), MAX_JSON_BYTES),
  ]);
  return Object.freeze({
    app,
    bundle_identifier:
      details.kind === "counter" ? "com.laundry-desk.v2" : "com.laundry-desk.runtime",
    dmg,
    manifest,
    [keyName]: details.keyDigest,
    team_identifier: details.team,
    version: details.version,
    zip,
  });
}

async function loadReports(paths) {
  const [transfer, clean, xp58] = await Promise.all([
    readStrictJson(paths.transfer, "RC_TRANSFER_REPORT"),
    readStrictJson(paths.clean, "RC_CLEAN_MAC_REPORT"),
    readStrictJson(paths.xp58, "RC_XP58_REPORT"),
  ]);
  return Object.freeze({ transfer: transfer.value, clean: clean.value, xp58: xp58.value });
}

async function writeCanonical(path, value) {
  await writeFile(path, canonicalJson(value), { flag: "wx", mode: 0o444 });
}

export async function assembleReleaseCandidate(rawInput, options = {}) {
  const input = parseAssemblyInput(rawInput);
  const formal = input.mode === "formal";
  if (formal && isInside(repositoryRoot, input.output_directory)) {
    throw new Error("RC_FORMAL_OUTPUT_MUST_BE_OUTSIDE_REPOSITORY");
  }
  await assertMissing(input.output_directory);
  const identity = formal
    ? await liveIdentity(options.gitExecute)
    : {
        gitSha: input.testing_identity.git_sha,
        version: input.testing_identity.product_version,
      };
  const keys = await Promise.all([
    loadCounterPublicKey(input.counter.app),
    loadRuntimePublicKey(input.runtime.app),
  ]).then(([counter, runtime]) => Object.freeze({ counter, runtime }));
  const privatePaths = keyPaths(options.env ?? process.env);
  const privateKeys = await Promise.all([
    loadPrivateKey(privatePaths.counter, "RC_COUNTER_PRIVATE_KEY"),
    loadPrivateKey(privatePaths.runtime, "RC_RUNTIME_PRIVATE_KEY"),
  ]).then(([counter, runtime]) => Object.freeze({ counter, runtime }));
  assertKeyPair(privateKeys.counter, keys.counter.key, "RC_COUNTER_KEY_PAIR_MISMATCH");
  assertKeyPair(privateKeys.runtime, keys.runtime.key, "RC_RUNTIME_KEY_PAIR_MISMATCH");
  const manifests = await loadProductManifests(input, keys);
  validateManifestRelease(manifests, identity.version, formal);
  const digests = manifestDigests(manifests);
  const [serverIndex, postgresIndex] = await Promise.all([
    loadOciIndex(input.oci.server_index, digests.serverDigest, {
      amd64: manifests.runtime.server_image.linux_amd64,
      arm64: manifests.runtime.server_image.linux_arm64,
    }),
    loadOciIndex(input.oci.postgres_index, digests.postgresDigest, { amd64: null, arm64: null }),
  ]);
  const identities = formal
    ? await inspectFormalProducts(input, identity.version, options.platformExecute ?? execute)
    : Object.freeze({
        counter: { teamIdentifier: "software_only" },
        runtime: { teamIdentifier: "software_only" },
        verifier: { teamIdentifier: "software_only" },
      });
  const parent = dirname(input.output_directory);
  await ensureRealDirectory(parent, "RC_OUTPUT_PARENT");
  const staging = await mkdtemp(join(parent, ".laundry-release-candidate-"));
  await chmod(staging, 0o700);
  try {
    const paths = stagedPaths(staging, input);
    await copyInputs(input, paths, options.copyExecute ?? execute);
    const [counter, runtime, verifierApp, reports] = await Promise.all([
      productDescriptor(staging, paths.counter, {
        kind: "counter",
        keyDigest: keys.counter.digest,
        team: identities.counter.teamIdentifier,
        version: identity.version,
      }),
      productDescriptor(staging, paths.runtime, {
        kind: "runtime",
        keyDigest: keys.runtime.digest,
        team: identities.runtime.teamIdentifier,
        version: identity.version,
      }),
      describeAppTree(paths.verifier, relativeTo(staging, paths.verifier)),
      loadReports(paths.reports),
    ]);
    validateCounterArtifacts(manifests.counter, counter);
    const assurance = formal ? "formal" : "software_only";
    validateTransferReport(reports.transfer, {
      formal,
      gitSha: identity.gitSha,
      postgresDigest: digests.postgresDigest,
      serverDigest: digests.serverDigest,
      version: identity.version,
    });
    validateCleanMacReport(reports.clean, {
      counterTree: counter.app.tree_sha256,
      formal,
      gitSha: identity.gitSha,
      runtimeTree: runtime.app.tree_sha256,
      team: identities.counter.teamIdentifier,
      verifierTree: verifierApp.tree_sha256,
      version: identity.version,
    });
    validateXp58Report(reports.xp58, { version: identity.version });
    const releaseAuthority = validateReleaseAuthority({
      assurance,
      counter,
      git: Object.freeze({ clean: true, sha: identity.gitSha }),
      oci: Object.freeze({
        postgres: Object.freeze({
          digest: digests.postgresDigest,
          index: await describeFile(
            paths.oci.postgres,
            relativeTo(staging, paths.oci.postgres),
            8 * 1024 * 1024,
          ),
        }),
        server: Object.freeze({
          digest: digests.serverDigest,
          index: await describeFile(
            paths.oci.server,
            relativeTo(staging, paths.oci.server),
            8 * 1024 * 1024,
          ),
        }),
      }),
      product_version: identity.version,
      real_container_transfer: await describeFile(
        paths.reports.transfer,
        relativeTo(staging, paths.reports.transfer),
        MAX_JSON_BYTES,
      ),
      runtime,
      schema_version: 1,
      verifier: Object.freeze({
        app: verifierApp,
        bundle_identifier: "com.laundry-desk.release-candidate-verifier",
        team_identifier: identities.verifier.teamIdentifier,
        version: identity.version,
      }),
    });
    const fieldAuthority = validateFieldAuthority({
      assurance,
      clean_second_mac: await describeFile(
        paths.reports.clean,
        relativeTo(staging, paths.reports.clean),
        MAX_JSON_BYTES,
      ),
      git_sha: identity.gitSha,
      product_version: identity.version,
      release_authority_sha256: sha256(Buffer.from(canonicalJson(releaseAuthority), "utf8")),
      schema_version: 1,
      xp58: await describeFile(
        paths.reports.xp58,
        relativeTo(staging, paths.reports.xp58),
        MAX_JSON_BYTES,
      ),
    });
    if (formal) {
      assertFormalStrings({
        fieldAuthority,
        manifests,
        reports,
        releaseAuthority,
        serverIndex: serverIndex.value,
        postgresIndex: postgresIndex.value,
      });
    }
    const releaseEnvelope = signAuthority(
      releaseAuthority,
      RELEASE_DOMAIN,
      privateKeys.counter,
      privateKeys.runtime,
    );
    const fieldEnvelope = signAuthority(
      fieldAuthority,
      FIELD_DOMAIN,
      privateKeys.counter,
      privateKeys.runtime,
    );
    await settleAll([
      writeCanonical(join(staging, "release-evidence.json"), releaseEnvelope),
      writeCanonical(join(staging, "field-evidence.json"), fieldEnvelope),
    ]);
    await rename(staging, input.output_directory);
    return Object.freeze({
      assurance,
      git_sha: identity.gitSha,
      output_directory: input.output_directory,
      product_version: identity.version,
      release_authority_sha256: fieldAuthority.release_authority_sha256,
    });
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

async function main() {
  if (process.argv.length !== 3) throw new Error("RC_ASSEMBLY_ARGS_INVALID");
  const inputPath = canonicalAbsolutePath(process.argv[2], "RC_ASSEMBLY_INPUT");
  const input = (await readStrictJson(inputPath, "RC_ASSEMBLY_INPUT", MAX_JSON_BYTES)).value;
  const result = await assembleReleaseCandidate(input);
  process.stdout.write(`${canonicalJson({ ok: true, ...result })}\n`);
}

const invoked = process.argv[1];
if (invoked !== undefined && pathToFileURL(resolve(invoked)).href === import.meta.url) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : "RC_ASSEMBLY_FAILED";
    process.stderr.write(`${message.startsWith("RC_") ? message : "RC_ASSEMBLY_FAILED"}\n`);
    process.exitCode = 1;
  });
}

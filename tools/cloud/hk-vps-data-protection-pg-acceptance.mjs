import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { ensureLocalConfig } from "../local/config.mjs";
import { DEFAULT_CLOUD_ENVIRONMENT_PROFILE } from "./cloud-environment-profile.mjs";
import { captureVerifiedDataProtectionSet } from "./hk-vps-data-protection-capture.mjs";
import {
  DATA_PROTECTION_PHOTO_MARKER,
  DATA_PROTECTION_PHOTO_MARKER_CONTENT,
  createDataProtectionSetId,
  emptyDataProtectionState,
} from "./hk-vps-data-protection-contract.mjs";
import { drillDataProtectionSet } from "./hk-vps-data-protection-db.mjs";
import {
  captureDataProtectionPhotos,
  ensureDataProtectionRoots,
  publishDataProtectionSet,
  verifyDataProtectionSet,
} from "./hk-vps-data-protection-files.mjs";
import {
  createDataProtectionPgAdapter,
  discoverDataProtectionPostgresContainer,
} from "./hk-vps-data-protection-pg-adapter.mjs";
import {
  DATA_PROTECTION_PG_MUTATED_PHOTO,
  DATA_PROTECTION_PG_ORIGINAL_PHOTO,
  dataProtectionPgPhotoSha256,
  seedDataProtectionPgFixture,
} from "./hk-vps-data-protection-pg-fixture.mjs";
import { verifyRestoredDataProtectionDatabase } from "./hk-vps-data-protection-recovery-db.mjs";
import {
  cleanupDataProtectionRecoveryPath,
  prepareDataProtectionPhotoRestore,
  switchDataProtectionPhotos,
  verifyDataProtectionRestoredPhotos,
} from "./hk-vps-data-protection-recovery-files.mjs";
import {
  dataProtectionRecoveryConfirmation,
  runDataProtectionRecovery,
} from "./hk-vps-data-protection-recovery.mjs";
import {
  clearDataProtectionOperation,
  persistDataProtectionOperation,
  persistDataProtectionState,
  readDataProtectionOperation,
  readDataProtectionState,
} from "./hk-vps-data-protection-state.mjs";
import {
  inspectRetainedDataProtectionSets,
  prepareDataProtectionStaging,
} from "./hk-vps-data-protection-storage.mjs";

const executeFile = promisify(execFile);
const PROFILE = DEFAULT_CLOUD_ENVIRONMENT_PROFILE;
const REQUIRED_ENVIRONMENT = Object.freeze({
  LAUNDRY_CLOUD_DATA_PG_TEST: "1",
  LAUNDRY_USE_LOCAL_PG: "1",
  LAUNDRY_COMMISSIONING_ACCEPTANCE_ISOLATED: "1",
});

function fail(code, cause) {
  const error = new Error(code, cause === undefined ? undefined : { cause });
  error.code = code;
  throw error;
}

function assertOptIn(environment) {
  const project = environment.COMPOSE_PROJECT_NAME;
  if (
    Object.entries(REQUIRED_ENVIRONMENT).some(([name, value]) => environment[name] !== value) ||
    typeof project !== "string" ||
    !/^laundry-commission-pg-[a-z0-9]+$/u.test(project)
  ) {
    fail("CLOUD_DATA_PG_OPT_IN_REQUIRED");
  }
  return project;
}

async function currentCodeSha(cwd) {
  const result = await executeFile("/usr/bin/git", ["rev-parse", "HEAD"], {
    cwd,
    encoding: "utf8",
    maxBuffer: 4096,
    timeout: 10_000,
  });
  const sha = result.stdout.trim();
  if (!/^[0-9a-f]{40}$/u.test(sha)) fail("CLOUD_DATA_PG_CODE_SHA_INVALID");
  return sha;
}

function localStores(paths, identity) {
  const verifySet = async (path, options = {}) =>
    await verifyDataProtectionSet(path, { ...options, identity });
  const inspectSets = async (options = {}) =>
    await inspectRetainedDataProtectionSets({
      ...options,
      root: paths.dataRoot,
      setRoot: paths.setRoot,
      identity,
      verifySet,
    });
  return Object.freeze({
    verifySet,
    inspectSets,
    prepareStaging: async (operationId) =>
      await prepareDataProtectionStaging(operationId, {
        root: paths.dataRoot,
        setRoot: paths.setRoot,
        identity,
        verifySet,
      }),
    publishSet: async (staging, setId) =>
      await publishDataProtectionSet(staging, setId, { setRoot: paths.setRoot }),
  });
}

function persistedStores(paths, identity) {
  return Object.freeze({
    readOperation: async () =>
      await readDataProtectionOperation({ path: paths.operationPath, identity }),
    persistOperation: async (operation, options = {}) =>
      await persistDataProtectionOperation(operation, {
        ...options,
        path: paths.operationPath,
      }),
    clearOperation: async () => await clearDataProtectionOperation({ path: paths.operationPath }),
    readState: async () => await readDataProtectionState({ path: paths.statePath, identity }),
    persistState: async (state) =>
      await persistDataProtectionState(state, { path: paths.statePath }),
  });
}

async function runRealAcceptance({ adapter, codeSha, identity, paths, stores, fixture }) {
  let stage = "BASELINE_CAPTURE";
  try {
    const drillSet = async (verified) =>
      await drillDataProtectionSet(verified, undefined, {
        ...adapter.drillDependencies,
        token: () => randomBytes(12).toString("hex"),
      });
    const captureDependencies = Object.freeze({
      now: () => new Date(),
      readSourceEvidence: async () => await adapter.sourceEvidence(codeSha),
      createDump: async (path) => await adapter.createDump(path),
      capturePhotos: async (staging, files) =>
        await captureDataProtectionPhotos(staging, files, {
          photoRoot: paths.photoRoot,
          sourceIdentity: identity,
        }),
      verifySet: stores.verifySet,
      drillSet,
      publishSet: stores.publishSet,
    });
    const createdAt = new Date();
    const setId = createDataProtectionSetId("manual", createdAt, randomBytes(8).toString("hex"));
    await adapter.setWriteGate(false);
    const staging = await stores.prepareStaging(randomBytes(16).toString("hex"));
    const baseline = await captureVerifiedDataProtectionSet(
      {
        setId,
        kind: "manual",
        createdAt,
        stagingPath: staging.stagingPath,
        sourceIdentity: identity,
      },
      captureDependencies,
    );
    stage = "LIVE_MUTATION";
    await adapter.setWriteGate(true);
    await adapter.query(
      PROFILE.services.postgresDatabase,
      "UPDATE orders SET note='mutated', updated_at=now() WHERE id=$1",
      [fixture.order],
    );
    await writeFile(join(paths.photoRoot, fixture.storageKey), DATA_PROTECTION_PG_MUTATED_PHOTO, {
      mode: 0o600,
    });
    await adapter.query(
      PROFILE.services.postgresDatabase,
      "UPDATE garment_photos SET content_sha256=$2 WHERE id=$1::uuid",
      [fixture.photo, dataProtectionPgPhotoSha256(DATA_PROTECTION_PG_MUTATED_PHOTO)],
    );
    stage = "BASELINE_DRILL";
    await drillSet(baseline.verified);
    const persisted = persistedStores(paths, identity);
    let deskStopped = false;
    stage = "RECOVERY";
    const recovery = await runDataProtectionRecovery(
      {
        setId,
        confirmation: `${dataProtectionRecoveryConfirmation(baseline.verified.manifestSha256)}\n`,
        photoRoot: paths.photoRoot,
      },
      {
        ...persisted,
        now: () => new Date(),
        transitionExists: async () => false,
        inspectSets: stores.inspectSets,
        drillSet,
        findCodeTree: async () => PROFILE.paths.liveRoot,
        laundryIdentity: async () => identity,
        readMarker: async () => ({ git_sha: codeSha }),
        stopDesk: async () => {
          deskStopped = true;
        },
        startDesk: async () => {
          deskStopped = false;
        },
        inspectWriteGate: async () => undefined,
        activateWriteGate: async () => await adapter.setWriteGate(false),
        releaseWriteGate: async () => await adapter.setWriteGate(true),
        prepareSetStaging: stores.prepareStaging,
        captureSet: async (input) =>
          await captureVerifiedDataProtectionSet(input, captureDependencies),
        prepareCode: async (_source, _sha, operationId) =>
          `${PROFILE.paths.liveRoot}.restore-${operationId}`,
        preparePhotos: async (verified, operationId) =>
          await prepareDataProtectionPhotoRestore(verified, operationId, identity, {
            photoRoot: paths.photoRoot,
            sourceIdentity: identity,
          }),
        verifySet: stores.verifySet,
        restoreDatabase: async (verified) =>
          await adapter.restore(verified.dumpPath, PROFILE.services.postgresDatabase, true),
        verifyDatabase: async (manifest) =>
          await verifyRestoredDataProtectionDatabase(
            manifest,
            undefined,
            adapter.verificationDependencies,
          ),
        switchPhotos: async (photoStaging, operationId) =>
          await switchDataProtectionPhotos(photoStaging, operationId, {
            photoRoot: paths.photoRoot,
          }),
        verifyPhotos: async (_path, manifest) =>
          await verifyDataProtectionRestoredPhotos(paths.photoRoot, manifest, identity),
        switchCode: async () =>
          `${PROFILE.paths.liveRoot}.rollback-pre-${codeSha.slice(0, 7)}-20260812T000000Z`,
        cleanupRecoveryPath: async (path, operationId) =>
          await cleanupDataProtectionRecoveryPath(path, operationId, {
            photoRoot: paths.photoRoot,
          }),
        assertDeskHealth: async () => {
          if (deskStopped) fail("CLOUD_DATA_PG_DESK_STATE_INVALID");
        },
        assertSharedInfrastructure: async () => undefined,
      },
    );
    stage = "RESTORED_EVIDENCE";
    const restored = await adapter.query(
      PROFILE.services.postgresDatabase,
      `SELECT orders.note, photos.content_sha256
       FROM orders
       JOIN garment_photos photos ON photos.order_id=orders.id
      WHERE orders.id=$1::uuid`,
      [fixture.order],
    );
    assert.equal(restored.rows[0]?.note, null);
    assert.equal(
      restored.rows[0]?.content_sha256,
      dataProtectionPgPhotoSha256(DATA_PROTECTION_PG_ORIGINAL_PHOTO),
    );
    assert.deepEqual(
      await readFile(join(paths.photoRoot, fixture.storageKey)),
      DATA_PROTECTION_PG_ORIGINAL_PHOTO,
    );
    const state = await persisted.readState();
    assert.equal(state.last_recovery?.set_id, setId);
    assert.equal(state.last_recovery?.pre_recovery_set_id, recovery.pre_recovery_set_id);
    const retained = await stores.inspectSets({ reserveSlot: false });
    const preRecovery = retained.sets.find(
      (entry) => entry.manifest.set_id === recovery.pre_recovery_set_id,
    );
    assert.equal(
      preRecovery?.manifest.photos.files[0]?.sha256,
      dataProtectionPgPhotoSha256(DATA_PROTECTION_PG_MUTATED_PHOTO),
    );
    stage = "TAMPER_REJECTION";
    await writeFile(join(baseline.setPath, "photos", fixture.storageKey), "tampered", {
      mode: 0o600,
    });
    await assert.rejects(() => stores.verifySet(baseline.setPath), {
      code: "CLOUD_DATA_PHOTO_SNAPSHOT_INVALID",
    });
    return Object.freeze({ recovery, retainedCount: retained.sets.length });
  } catch (error) {
    fail(`CLOUD_DATA_PG_ACCEPTANCE_${stage}_FAILED`, error);
  }
}

export function dataProtectionPgFailureMarker(error) {
  const codes = [];
  let current = error;
  while (current !== undefined && current !== null && codes.length < 5) {
    const code = current.code;
    if (typeof code === "string" && /^[A-Z][A-Z0-9_]{2,95}$/u.test(code)) codes.push(code);
    current = current.cause;
  }
  return `CLOUD_DATA_PG_ACCEPTANCE_FAILED code=${codes.join(",") || "UNKNOWN"}`;
}

export async function runDataProtectionPgAcceptance(options = {}) {
  const environment = options.environment ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const project = assertOptIn(environment);
  const config = await (options.ensureConfig ?? ensureLocalConfig)({ env: environment });
  const container = await (options.discoverContainer ?? discoverDataProtectionPostgresContainer)({
    project,
    cwd,
    environment,
  });
  const adapter = (options.createAdapter ?? createDataProtectionPgAdapter)({
    container,
    password: config.postgresSuperuserPassword,
    cwd,
    environment,
  });
  const root = await realpath(await mkdtemp(join(tmpdir(), "laundry-data-pg-")));
  const paths = Object.freeze({
    dataRoot: join(root, "data"),
    setRoot: join(root, "data", "sets"),
    statePath: join(root, "data", "state.json"),
    operationPath: join(root, "data", "operation.json"),
    photoRoot: join(root, "photos"),
  });
  try {
    await mkdir(paths.photoRoot, { mode: 0o700 });
    await writeFile(
      join(paths.photoRoot, DATA_PROTECTION_PHOTO_MARKER),
      DATA_PROTECTION_PHOTO_MARKER_CONTENT,
      { mode: 0o600 },
    );
    const metadata = await lstat(root);
    const identity = Object.freeze({ uid: metadata.uid, gid: metadata.gid });
    await ensureDataProtectionRoots({
      root: paths.dataRoot,
      setRoot: paths.setRoot,
      identity,
    });
    await persistDataProtectionState(emptyDataProtectionState(), { path: paths.statePath });
    const fixture = await seedDataProtectionPgFixture(adapter, paths.photoRoot);
    return await runRealAcceptance({
      adapter,
      codeSha: await (options.codeSha ?? currentCodeSha)(cwd),
      identity,
      paths,
      stores: localStores(paths, identity),
      fixture,
    });
  } finally {
    await adapter.setWriteGate(true).catch(() => undefined);
    await rm(root, { force: true, recursive: true });
  }
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  runDataProtectionPgAcceptance()
    .then((result) => {
      process.stdout.write(
        `CLOUD_DATA_PG_ACCEPTANCE_OK set_id=${result.recovery.set_id} retained_sets=${result.retainedCount}\n`,
      );
    })
    .catch((error) => {
      process.stderr.write(`${dataProtectionPgFailureMarker(error)}\n`);
      process.exitCode = 1;
    });
}

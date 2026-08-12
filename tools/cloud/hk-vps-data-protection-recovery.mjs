import { randomBytes } from "node:crypto";
import { TextDecoder } from "node:util";

import { captureVerifiedDataProtectionSet } from "./hk-vps-data-protection-capture.mjs";
import { dataProtectionFailureRequiresOperation } from "./hk-vps-data-protection-cleanup.mjs";
import {
  DATA_PROTECTION_PHOTO_ROOT,
  createDataProtectionSetId,
} from "./hk-vps-data-protection-contract.mjs";
import { drillDataProtectionSet } from "./hk-vps-data-protection-db.mjs";
import { verifyDataProtectionSet } from "./hk-vps-data-protection-files.mjs";
import { readLaundryIdentity } from "./hk-vps-data-protection-host.mjs";
import {
  restoreDataProtectionDatabase,
  verifyRestoredDataProtectionDatabase,
} from "./hk-vps-data-protection-recovery-db.mjs";
import {
  cleanupDataProtectionRecoveryPath,
  findDataProtectionCodeTree,
  prepareDataProtectionCodeRestore,
  prepareDataProtectionPhotoRestore,
  switchDataProtectionCode,
  switchDataProtectionPhotos,
  verifyDataProtectionRestoredPhotos,
} from "./hk-vps-data-protection-recovery-files.mjs";
import {
  clearDataProtectionOperation,
  createDataProtectionOperation,
  persistDataProtectionOperation,
  persistDataProtectionState,
  readDataProtectionOperation,
  readDataProtectionState,
  updateDataProtectionOperation,
} from "./hk-vps-data-protection-state.mjs";
import {
  cleanupDataProtectionStaging,
  inspectRetainedDataProtectionSets,
  prepareDataProtectionStaging,
} from "./hk-vps-data-protection-storage.mjs";
import { CloudReleaseError, fail } from "./hk-vps-release-core.mjs";
import { assertSharedInfrastructure } from "./hk-vps-release-host-guard.mjs";
import { assertDeskHealth, startDesk, stopDesk } from "./hk-vps-release-remote-system.mjs";
import {
  LIVE_ROOT,
  readReleaseMarker,
  transitionExists,
} from "./hk-vps-release-remote-support.mjs";
import {
  activateDatabaseWriteGate,
  inspectDatabaseWriteGate,
  releaseDatabaseWriteGate,
} from "./hk-vps-release-write-gate.mjs";

const MAX_CONFIRMATION_BYTES = 128;

function errorCode(error) {
  return error instanceof CloudReleaseError && error.code.startsWith("CLOUD_DATA_")
    ? error.code
    : "CLOUD_DATA_RECOVERY_FAILED";
}

export function dataProtectionRecoveryConfirmation(manifestSha256) {
  if (typeof manifestSha256 !== "string" || !/^[0-9a-f]{64}$/u.test(manifestSha256)) {
    fail("CLOUD_DATA_RECOVERY_CONFIRMATION_INVALID");
  }
  return `RECOVER-${manifestSha256.slice(0, 12)}`;
}

export function parseDataProtectionRecoveryConfirmation(source, manifestSha256) {
  if (
    typeof source !== "string" ||
    source !== `${dataProtectionRecoveryConfirmation(manifestSha256)}\n`
  ) {
    fail("CLOUD_DATA_RECOVERY_CONFIRMATION_INVALID");
  }
  return true;
}

export async function readDataProtectionRecoveryInput(stream = process.stdin) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > MAX_CONFIRMATION_BYTES) fail("CLOUD_DATA_RECOVERY_CONFIRMATION_INVALID");
    chunks.push(buffer);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } catch (error) {
    fail("CLOUD_DATA_RECOVERY_CONFIRMATION_INVALID", error);
  }
}

async function assertOperationAvailable(dependencies) {
  if (await (dependencies.transitionExists ?? transitionExists)()) {
    fail("CLOUD_DATA_RELEASE_TRANSITION_ACTIVE");
  }
  if ((await (dependencies.readOperation ?? readDataProtectionOperation)()) !== null) {
    fail("CLOUD_DATA_OPERATION_ACTIVE");
  }
}

async function recordFailure(error, now, dependencies) {
  const state = await (dependencies.readState ?? readDataProtectionState)();
  await (dependencies.persistState ?? persistDataProtectionState)({
    ...state,
    last_failure: {
      ...state.last_failure,
      recover: {
        code: errorCode(error),
        failed_at: now().toISOString(),
      },
    },
  });
}

async function markRecoveryRequired(context, error, dependencies) {
  let recoveryError = error;
  if (context.startAttempted || !context.stopped) {
    try {
      await (dependencies.stopDesk ?? stopDesk)(undefined);
      context.stopped = true;
    } catch (stopError) {
      recoveryError = stopError;
    }
  }
  if (context.appRoleOriginalCanLogin) {
    try {
      await (dependencies.activateWriteGate ?? activateDatabaseWriteGate)(undefined);
      context.gateReleased = false;
    } catch (gateError) {
      recoveryError = gateError;
    }
  }
  try {
    context.operation = updateDataProtectionOperation(
      context.operation,
      { phase: "recovery_required", app_role_original_can_login: true },
      dependencies.now(),
    );
    await (dependencies.persistOperation ?? persistDataProtectionOperation)(context.operation, {
      replace: true,
    });
  } catch (stateError) {
    recoveryError = stateError;
  }
  fail("CLOUD_DATA_RECOVERY_REQUIRED", recoveryError);
}

async function recoverBeforeDestructiveChange(context, error, dependencies, clearOperation = true) {
  try {
    for (const path of [context.codeStaging, context.photoStaging].filter(Boolean)) {
      await (dependencies.cleanupRecoveryPath ?? cleanupDataProtectionRecoveryPath)(
        path,
        context.operation.operation_id,
      );
    }
    if (context.setStaging !== null) {
      await (dependencies.cleanupSetStaging ?? cleanupDataProtectionStaging)(
        context.setStaging,
        context.operation.operation_id,
      );
    }
    if (context.appRoleOriginalCanLogin && !context.gateReleased) {
      await (dependencies.releaseWriteGate ?? releaseDatabaseWriteGate)(undefined);
      context.gateReleased = true;
    }
    if (context.stopAttempted || context.stopped) {
      context.startAttempted = true;
      await (dependencies.startDesk ?? startDesk)(undefined);
      await (dependencies.assertDeskHealth ?? assertDeskHealth)(context.originalCodeSha, undefined);
      await (dependencies.assertSharedInfrastructure ?? assertSharedInfrastructure)(undefined);
      context.startAttempted = false;
      context.stopAttempted = false;
      context.stopped = false;
    }
    if (clearOperation) {
      await (dependencies.clearOperation ?? clearDataProtectionOperation)();
    }
  } catch (recoveryError) {
    await markRecoveryRequired(context, recoveryError, dependencies);
  }
  throw error;
}

function defaultDependencies(input) {
  return Object.freeze({ now: () => new Date(), randomBytes, ...input });
}

export async function runDataProtectionRecovery(options, inputDependencies = {}) {
  const dependencies = defaultDependencies(inputDependencies);
  await assertOperationAvailable(dependencies);
  const retained = await (dependencies.inspectSets ?? inspectRetainedDataProtectionSets)({
    reserveSlot: true,
  });
  const candidates = retained.sets.filter((entry) => entry.manifest.set_id === options.setId);
  if (candidates.length !== 1) fail("CLOUD_DATA_SET_NOT_FOUND");
  const target = candidates[0];
  parseDataProtectionRecoveryConfirmation(options.confirmation, target.manifestSha256);
  const startedAt = dependencies.now();
  const preRecoverySetId = createDataProtectionSetId(
    "pre_recovery",
    startedAt,
    dependencies.randomBytes(8).toString("hex"),
  );
  const context = {
    operation: createDataProtectionOperation("recover", target.manifest.set_id, startedAt, {
      randomBytes: dependencies.randomBytes,
      preRecoverySetId,
    }),
    setStaging: null,
    codeStaging: null,
    photoStaging: null,
    originalCodeSha: null,
    appRoleOriginalCanLogin: false,
    stopped: false,
    startAttempted: false,
    stopAttempted: false,
    gateReleased: true,
    destructiveStarted: false,
  };
  const persist = async (changes) => {
    context.operation = updateDataProtectionOperation(
      context.operation,
      changes,
      dependencies.now(),
    );
    await (dependencies.persistOperation ?? persistDataProtectionOperation)(context.operation, {
      replace: true,
    });
  };
  await (dependencies.persistOperation ?? persistDataProtectionOperation)(context.operation);
  try {
    await (dependencies.drillSet ?? drillDataProtectionSet)(target, options.signal);
    const codeSource = await (dependencies.findCodeTree ?? findDataProtectionCodeTree)(
      target.manifest.code_sha,
    );
    const sourceIdentity = await (dependencies.laundryIdentity ?? readLaundryIdentity)(
      options.signal,
      dependencies,
    );
    context.originalCodeSha = (
      await (dependencies.readMarker ?? readReleaseMarker)(LIVE_ROOT)
    ).git_sha;
    await (dependencies.inspectWriteGate ?? inspectDatabaseWriteGate)(options.signal);
    context.appRoleOriginalCanLogin = true;
    context.stopAttempted = true;
    await (dependencies.stopDesk ?? stopDesk)(options.signal);
    context.stopped = true;
    await persist({ phase: "service_stopped" });
    await persist({ phase: "gate_intent", app_role_original_can_login: true });
    await (dependencies.activateWriteGate ?? activateDatabaseWriteGate)(options.signal);
    context.gateReleased = false;
    await persist({ phase: "gate_active" });
    const staging = await (dependencies.prepareSetStaging ?? prepareDataProtectionStaging)(
      context.operation.operation_id,
    );
    context.setStaging = staging.stagingPath;
    const preRecovery = await (dependencies.captureSet ?? captureVerifiedDataProtectionSet)(
      {
        setId: preRecoverySetId,
        kind: "pre_recovery",
        createdAt: startedAt,
        stagingPath: staging.stagingPath,
        sourceIdentity,
        signal: options.signal,
        onPhase: async (phase) => await persist({ phase }),
      },
      { ...dependencies, now: dependencies.now },
    );
    if (preRecovery.evidence.codeSha !== context.originalCodeSha) {
      fail("CLOUD_DATA_RECOVERY_SOURCE_CHANGED");
    }
    context.setStaging = null;
    context.codeStaging = await (dependencies.prepareCode ?? prepareDataProtectionCodeRestore)(
      codeSource,
      target.manifest.code_sha,
      context.operation.operation_id,
      {
        signal: options.signal,
      },
    );
    context.photoStaging = await (dependencies.preparePhotos ?? prepareDataProtectionPhotoRestore)(
      target,
      context.operation.operation_id,
      sourceIdentity,
    );
    const reverified = await (dependencies.verifySet ?? verifyDataProtectionSet)(target.setPath, {
      expectedSetId: target.manifest.set_id,
    });
    if (reverified.manifestSha256 !== target.manifestSha256) {
      fail("CLOUD_DATA_RECOVERY_SET_CHANGED");
    }
    await persist({ phase: "restoring" });
    context.destructiveStarted = true;
    await (dependencies.restoreDatabase ?? restoreDataProtectionDatabase)(
      reverified,
      options.signal,
    );
    await (dependencies.verifyDatabase ?? verifyRestoredDataProtectionDatabase)(
      reverified.manifest,
      options.signal,
    );
    const previousPhotos = await (dependencies.switchPhotos ?? switchDataProtectionPhotos)(
      context.photoStaging,
      context.operation.operation_id,
    );
    context.photoStaging = null;
    await (dependencies.verifyPhotos ?? verifyDataProtectionRestoredPhotos)(
      options.photoRoot ?? DATA_PROTECTION_PHOTO_ROOT,
      reverified.manifest,
      sourceIdentity,
    );
    const rollbackCodePath = await (dependencies.switchCode ?? switchDataProtectionCode)(
      context.codeStaging,
      preRecovery.evidence.codeSha,
      startedAt,
    );
    context.codeStaging = null;
    await (dependencies.cleanupRecoveryPath ?? cleanupDataProtectionRecoveryPath)(
      previousPhotos,
      context.operation.operation_id,
    );
    await (dependencies.releaseWriteGate ?? releaseDatabaseWriteGate)(options.signal);
    context.gateReleased = true;
    await persist({ phase: "gate_released" });
    context.startAttempted = true;
    await (dependencies.startDesk ?? startDesk)(options.signal);
    await (dependencies.assertDeskHealth ?? assertDeskHealth)(
      target.manifest.code_sha,
      options.signal,
    );
    await (dependencies.assertSharedInfrastructure ?? assertSharedInfrastructure)(options.signal);
    context.startAttempted = false;
    context.stopAttempted = false;
    context.stopped = false;
    const completedAt = dependencies.now().toISOString();
    const state = await (dependencies.readState ?? readDataProtectionState)();
    await (dependencies.persistState ?? persistDataProtectionState)({
      ...state,
      last_backup: {
        set_id: target.manifest.set_id,
        completed_at: target.manifest.created_at,
        manifest_sha256: target.manifestSha256,
        code_sha: target.manifest.code_sha,
      },
      last_drill: {
        set_id: target.manifest.set_id,
        completed_at: completedAt,
        manifest_sha256: target.manifestSha256,
      },
      last_recovery: {
        set_id: target.manifest.set_id,
        completed_at: completedAt,
        manifest_sha256: target.manifestSha256,
        code_sha: target.manifest.code_sha,
        pre_recovery_set_id: preRecoverySetId,
        rollback_code_path: rollbackCodePath,
      },
      last_failure: { ...state.last_failure, recover: null },
    });
    await (dependencies.clearOperation ?? clearDataProtectionOperation)();
    return Object.freeze({
      set_id: target.manifest.set_id,
      manifest_sha256: target.manifestSha256,
      code_sha: target.manifest.code_sha,
      pre_recovery_set_id: preRecoverySetId,
      rollback_code_path: rollbackCodePath,
    });
  } catch (error) {
    let failure = error;
    let clearOperation = !dataProtectionFailureRequiresOperation(error);
    try {
      await recordFailure(error, dependencies.now, dependencies);
    } catch (stateError) {
      failure = stateError;
      clearOperation = false;
    }
    if (context.destructiveStarted) {
      await markRecoveryRequired(context, failure, dependencies);
    }
    await recoverBeforeDestructiveChange(context, failure, dependencies, clearOperation);
  }
}

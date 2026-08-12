import { randomBytes } from "node:crypto";

import { captureVerifiedDataProtectionSet } from "./hk-vps-data-protection-capture.mjs";
import { dataProtectionFailureRequiresOperation } from "./hk-vps-data-protection-cleanup.mjs";
import { createDataProtectionSetId } from "./hk-vps-data-protection-contract.mjs";
import { drillDataProtectionSet } from "./hk-vps-data-protection-db.mjs";
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
import { readLaundryIdentity } from "./hk-vps-data-protection-host.mjs";
import { CloudReleaseError, fail } from "./hk-vps-release-core.mjs";
import {
  LIVE_ROOT,
  readReleaseMarker,
  transitionExists,
} from "./hk-vps-release-remote-support.mjs";
import { assertDeskHealth, startDesk, stopDesk } from "./hk-vps-release-remote-system.mjs";
import {
  activateDatabaseWriteGate,
  inspectDatabaseWriteGate,
  releaseDatabaseWriteGate,
} from "./hk-vps-release-write-gate.mjs";

function errorCode(error) {
  return error instanceof CloudReleaseError && error.code.startsWith("CLOUD_DATA_")
    ? error.code
    : "CLOUD_DATA_BACKUP_FAILED";
}

async function assertOperationAvailable(dependencies) {
  if (await (dependencies.transitionExists ?? transitionExists)()) {
    fail("CLOUD_DATA_RELEASE_TRANSITION_ACTIVE");
  }
  if ((await (dependencies.readOperation ?? readDataProtectionOperation)()) !== null) {
    fail("CLOUD_DATA_OPERATION_ACTIVE");
  }
}

async function recordFailure(action, error, now, dependencies) {
  const readState = dependencies.readState ?? readDataProtectionState;
  const persistState = dependencies.persistState ?? persistDataProtectionState;
  const state = await readState();
  await persistState({
    ...state,
    last_failure: {
      ...state.last_failure,
      [action]: {
        code: errorCode(error),
        failed_at: now().toISOString(),
      },
    },
  });
}

async function markBackupRecoveryRequired(context, error, dependencies) {
  let recoveryFailure = error;
  if (context.startAttempted) {
    try {
      await (dependencies.stopDesk ?? stopDesk)(undefined);
      context.stopped = true;
    } catch (stopError) {
      recoveryFailure = stopError;
    }
  }
  if (context.appRoleOriginalCanLogin) {
    try {
      await (dependencies.activateWriteGate ?? activateDatabaseWriteGate)(undefined);
      context.gateReleased = false;
    } catch (gateError) {
      recoveryFailure = gateError;
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
    recoveryFailure = stateError;
  }
  fail("CLOUD_DATA_RECOVERY_REQUIRED", recoveryFailure);
}

async function recoverBackupOperation(context, error, dependencies, clearOperation = true) {
  let finalError = error;
  if (context.startAttempted) await markBackupRecoveryRequired(context, error, dependencies);
  try {
    if (context.appRoleOriginalCanLogin && !context.gateReleased) {
      await (dependencies.releaseWriteGate ?? releaseDatabaseWriteGate)(undefined);
      context.gateReleased = true;
    }
    if (context.stopAttempted || context.stopped) {
      context.startAttempted = true;
      await (dependencies.startDesk ?? startDesk)(undefined);
      await (dependencies.assertDeskHealth ?? assertDeskHealth)(context.expectedCodeSha, undefined);
      context.startAttempted = false;
      context.stopAttempted = false;
      context.stopped = false;
    }
  } catch (recoveryError) {
    await markBackupRecoveryRequired(context, recoveryError, dependencies);
  }
  if (context.stagingPath !== null) {
    try {
      await (dependencies.cleanupStaging ?? cleanupDataProtectionStaging)(
        context.stagingPath,
        context.operation.operation_id,
      );
    } catch (cleanupError) {
      finalError = cleanupError;
      clearOperation = false;
      try {
        await recordFailure("backup", cleanupError, dependencies.now, dependencies);
      } catch (stateError) {
        finalError = stateError;
      }
    }
  }
  if (clearOperation) {
    await (dependencies.clearOperation ?? clearDataProtectionOperation)();
  }
  throw finalError;
}

function defaultDependencies(input = {}) {
  return Object.freeze({
    now: () => new Date(),
    randomBytes,
    ...input,
  });
}

export async function runDataProtectionBackup(options = {}, inputDependencies = {}) {
  const dependencies = defaultDependencies(inputDependencies);
  const kind = options.kind ?? "manual";
  const now = dependencies.now;
  await assertOperationAvailable(dependencies);
  const startedAt = now();
  const setId = createDataProtectionSetId(
    kind,
    startedAt,
    dependencies.randomBytes(8).toString("hex"),
  );
  const context = {
    operation: createDataProtectionOperation("backup", setId, startedAt, {
      randomBytes: dependencies.randomBytes,
    }),
    stagingPath: null,
    expectedCodeSha: null,
    appRoleOriginalCanLogin: false,
    gateReleased: true,
    startAttempted: false,
    stopAttempted: false,
    stopped: false,
  };
  const persist = async (changes) => {
    context.operation = updateDataProtectionOperation(context.operation, changes, now());
    await (dependencies.persistOperation ?? persistDataProtectionOperation)(context.operation, {
      replace: true,
    });
  };
  await (dependencies.persistOperation ?? persistDataProtectionOperation)(context.operation);
  try {
    const staging = await (dependencies.prepareStaging ?? prepareDataProtectionStaging)(
      context.operation.operation_id,
    );
    context.stagingPath = staging.stagingPath;
    const sourceIdentity = await (dependencies.laundryIdentity ?? readLaundryIdentity)(
      options.signal,
      dependencies,
    );
    context.expectedCodeSha = (
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
    const captured = await (dependencies.captureSet ?? captureVerifiedDataProtectionSet)(
      {
        setId,
        kind,
        createdAt: startedAt,
        stagingPath: staging.stagingPath,
        sourceIdentity,
        signal: options.signal,
        onPhase: async (phase) => await persist({ phase }),
      },
      { ...dependencies, now },
    );
    context.stagingPath = null;
    await (dependencies.releaseWriteGate ?? releaseDatabaseWriteGate)(options.signal);
    context.gateReleased = true;
    await persist({ phase: "gate_released" });
    context.startAttempted = true;
    await (dependencies.startDesk ?? startDesk)(options.signal);
    await (dependencies.assertDeskHealth ?? assertDeskHealth)(
      captured.evidence.codeSha,
      options.signal,
    );
    context.startAttempted = false;
    context.stopAttempted = false;
    context.stopped = false;
    const state = await (dependencies.readState ?? readDataProtectionState)();
    await (dependencies.persistState ?? persistDataProtectionState)({
      ...state,
      last_backup: {
        set_id: setId,
        completed_at: now().toISOString(),
        manifest_sha256: captured.verified.manifestSha256,
        code_sha: captured.evidence.codeSha,
      },
      last_failure: { ...state.last_failure, backup: null },
    });
    await (dependencies.clearOperation ?? clearDataProtectionOperation)();
    return Object.freeze({
      set_id: setId,
      manifest_sha256: captured.verified.manifestSha256,
      code_sha: captured.evidence.codeSha,
    });
  } catch (error) {
    let failure = error;
    let clearOperation = !dataProtectionFailureRequiresOperation(error);
    try {
      await recordFailure("backup", error, now, dependencies);
    } catch (stateError) {
      failure = stateError;
      clearOperation = false;
    }
    return await recoverBackupOperation(context, failure, dependencies, clearOperation);
  }
}

export async function runDataProtectionDrill(options = {}, inputDependencies = {}) {
  const dependencies = defaultDependencies(inputDependencies);
  await assertOperationAvailable(dependencies);
  const retained = await (dependencies.inspectSets ?? inspectRetainedDataProtectionSets)({
    reserveSlot: false,
  });
  const candidates = options.setId
    ? retained.sets.filter((entry) => entry.manifest.set_id === options.setId)
    : [...retained.sets].sort((left, right) =>
        right.manifest.created_at.localeCompare(left.manifest.created_at),
      );
  const selected = candidates[0];
  if (selected === undefined || (options.setId && candidates.length !== 1)) {
    fail("CLOUD_DATA_SET_NOT_FOUND");
  }
  const operation = createDataProtectionOperation(
    "drill",
    selected.manifest.set_id,
    dependencies.now(),
    {
      randomBytes: dependencies.randomBytes,
    },
  );
  await (dependencies.persistOperation ?? persistDataProtectionOperation)(operation);
  try {
    await (dependencies.drillSet ?? drillDataProtectionSet)(selected, options.signal);
    const state = await (dependencies.readState ?? readDataProtectionState)();
    await (dependencies.persistState ?? persistDataProtectionState)({
      ...state,
      last_drill: {
        set_id: selected.manifest.set_id,
        completed_at: dependencies.now().toISOString(),
        manifest_sha256: selected.manifestSha256,
      },
      last_failure: { ...state.last_failure, drill: null },
    });
    await (dependencies.clearOperation ?? clearDataProtectionOperation)();
    return Object.freeze({
      set_id: selected.manifest.set_id,
      manifest_sha256: selected.manifestSha256,
    });
  } catch (error) {
    let failure = error;
    let clearOperation = !dataProtectionFailureRequiresOperation(error);
    try {
      await recordFailure("drill", error, dependencies.now, dependencies);
    } catch (stateError) {
      failure = stateError;
      clearOperation = false;
    }
    if (clearOperation) await (dependencies.clearOperation ?? clearDataProtectionOperation)();
    throw failure;
  }
}

import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, unlink } from "node:fs/promises";
import { dirname } from "node:path";

import {
  DATA_PROTECTION_OPERATION_PATH,
  DATA_PROTECTION_STATE_PATH,
  emptyDataProtectionState,
  parseDataProtectionOperation,
  parseDataProtectionState,
} from "./hk-vps-data-protection-contract.mjs";
import {
  readDataProtectionJsonFile,
  writeDataProtectionJson,
} from "./hk-vps-data-protection-files.mjs";
import { fail } from "./hk-vps-release-core.mjs";

function missing(error) {
  return error instanceof Error && error.code === "ENOENT";
}

async function syncDirectory(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function readDataProtectionState(options = {}) {
  const path = options.path ?? DATA_PROTECTION_STATE_PATH;
  const metadata = await (options.lstat ?? lstat)(path).catch((error) => {
    if (missing(error)) return null;
    throw error;
  });
  if (metadata === null) return emptyDataProtectionState();
  const read = await (options.readJson ?? readDataProtectionJsonFile)(path, {
    identity: options.identity,
    code: "CLOUD_DATA_STATE_INVALID",
  });
  const state = parseDataProtectionState(read.value);
  if (read.source !== `${JSON.stringify(state)}\n`) fail("CLOUD_DATA_STATE_INVALID");
  return state;
}

export async function persistDataProtectionState(state, options = {}) {
  const parsed = parseDataProtectionState(state);
  await (options.writeJson ?? writeDataProtectionJson)(
    options.path ?? DATA_PROTECTION_STATE_PATH,
    parsed,
    { replace: true, code: "CLOUD_DATA_STATE_WRITE_FAILED" },
  );
  return parsed;
}

export async function readDataProtectionOperation(options = {}) {
  const path = options.path ?? DATA_PROTECTION_OPERATION_PATH;
  const metadata = await (options.lstat ?? lstat)(path).catch((error) => {
    if (missing(error)) return null;
    throw error;
  });
  if (metadata === null) return null;
  const read = await (options.readJson ?? readDataProtectionJsonFile)(path, {
    identity: options.identity,
    code: "CLOUD_DATA_OPERATION_INVALID",
  });
  const operation = parseDataProtectionOperation(read.value);
  if (read.source !== `${JSON.stringify(operation)}\n`) fail("CLOUD_DATA_OPERATION_INVALID");
  return operation;
}

export function createDataProtectionOperation(action, setId, now = new Date(), options = {}) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    fail("CLOUD_DATA_OPERATION_INVALID");
  }
  return parseDataProtectionOperation({
    schema: "laundry.cloud-data-protection.operation",
    version: 1,
    operation_id: (options.randomBytes ?? randomBytes)(16).toString("hex"),
    action,
    phase: "intent",
    set_id: setId,
    pre_recovery_set_id: options.preRecoverySetId ?? null,
    app_role_original_can_login: null,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
  });
}

export function updateDataProtectionOperation(operation, changes, now = new Date()) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    fail("CLOUD_DATA_OPERATION_INVALID");
  }
  return parseDataProtectionOperation({
    ...operation,
    ...changes,
    updated_at: now.toISOString(),
  });
}

export async function persistDataProtectionOperation(operation, options = {}) {
  const parsed = parseDataProtectionOperation(operation);
  await (options.writeJson ?? writeDataProtectionJson)(
    options.path ?? DATA_PROTECTION_OPERATION_PATH,
    parsed,
    { replace: options.replace === true, code: "CLOUD_DATA_OPERATION_WRITE_FAILED" },
  );
  return parsed;
}

export async function clearDataProtectionOperation(options = {}) {
  const path = options.path ?? DATA_PROTECTION_OPERATION_PATH;
  try {
    await (options.unlink ?? unlink)(path);
    await (options.syncDirectory ?? syncDirectory)(dirname(path));
    return true;
  } catch (error) {
    if (missing(error)) return false;
    fail("CLOUD_DATA_OPERATION_CLEAR_FAILED", error);
  }
}

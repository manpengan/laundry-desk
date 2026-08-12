import {
  asRecord,
  requireInteger,
  requireString,
  requireThat,
  requireUuid,
} from "./adr36-web-core.mjs";

const STORE_KEYS = Object.freeze([
  "store_code",
  "store_name",
  "timezone",
  "profile_version",
  "updated_at",
  "is_current",
]);
const DIRECTORY_KEYS = Object.freeze(["returned_store_count", "truncated", "stores"]);
const RESULT_KEYS = Object.freeze(["store"]);
const STORE_CODE = /^[\x21-\x7e]{1,64}$/u;

function exactKeys(record, keys, code) {
  const actual = Object.keys(record);
  requireThat(
    actual.length === keys.length && keys.every((key) => Object.hasOwn(record, key)),
    code,
  );
}

function exactUtcTimestamp(value) {
  requireThat(typeof value === "string", "OWNER_STORE_DIRECTORY_INVALID");
  const milliseconds = Date.parse(value);
  requireThat(
    Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value,
    "OWNER_STORE_DIRECTORY_INVALID",
  );
  return value;
}

function timeZone(value) {
  const candidate = requireString(value, "OWNER_STORE_DIRECTORY_INVALID");
  requireThat(candidate.length <= 64, "OWNER_STORE_DIRECTORY_INVALID");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate }).format();
  } catch {
    requireThat(false, "OWNER_STORE_DIRECTORY_INVALID");
  }
  return candidate;
}

function storeRow(value) {
  const record = asRecord(value, "OWNER_STORE_DIRECTORY_INVALID");
  exactKeys(record, STORE_KEYS, "OWNER_STORE_DIRECTORY_INVALID");
  const storeCode = requireString(record.store_code, "OWNER_STORE_DIRECTORY_INVALID");
  const storeName = requireString(record.store_name, "OWNER_STORE_DIRECTORY_INVALID");
  const profileVersion = requireInteger(record.profile_version, "OWNER_STORE_DIRECTORY_INVALID");
  requireThat(
    STORE_CODE.test(storeCode) &&
      storeName.trim() === storeName &&
      storeName.length <= 128 &&
      profileVersion > 0 &&
      typeof record.is_current === "boolean",
    "OWNER_STORE_DIRECTORY_INVALID",
  );
  return Object.freeze({
    storeCode,
    storeName,
    timeZone: timeZone(record.timezone),
    profileVersion,
    updatedAt: exactUtcTimestamp(record.updated_at),
    isCurrent: record.is_current,
  });
}

function storeDirectory(value) {
  const record = asRecord(value, "OWNER_STORE_DIRECTORY_INVALID");
  exactKeys(record, DIRECTORY_KEYS, "OWNER_STORE_DIRECTORY_INVALID");
  requireThat(Array.isArray(record.stores), "OWNER_STORE_DIRECTORY_INVALID");
  const stores = Object.freeze(record.stores.map(storeRow));
  const returnedStoreCount = requireInteger(
    record.returned_store_count,
    "OWNER_STORE_DIRECTORY_INVALID",
  );
  requireThat(
    stores.length > 0 &&
      stores.length <= 50 &&
      returnedStoreCount === stores.length &&
      typeof record.truncated === "boolean" &&
      (!record.truncated || stores.length === 50) &&
      new Set(stores.map((store) => store.storeCode)).size === stores.length &&
      stores.every(
        (store, index) => index === 0 || stores[index - 1].storeCode <= store.storeCode,
      ) &&
      stores.filter((store) => store.isCurrent).length === 1,
    "OWNER_STORE_DIRECTORY_INVALID",
  );
  return Object.freeze({ stores, truncated: record.truncated });
}

function changedStore(value) {
  const record = asRecord(value, "OWNER_STORE_CHANGE_INVALID");
  exactKeys(record, RESULT_KEYS, "OWNER_STORE_CHANGE_INVALID");
  const store = storeRow(record.store);
  requireThat(store.isCurrent, "OWNER_STORE_CHANGE_INVALID");
  return store;
}

function ownerContext(value) {
  const input = asRecord(value, "OWNER_JOURNEY_OPTIONS_INVALID");
  const api = asRecord(input.api, "OWNER_JOURNEY_API_INVALID");
  requireThat(
    typeof api.query === "function" &&
      typeof api.stepUp === "function" &&
      typeof api.refresh === "function",
    "OWNER_JOURNEY_API_INVALID",
  );
  const adminSession = asRecord(input.adminSession, "OWNER_ADMIN_SESSION_INVALID");
  const approverSession = asRecord(input.approverSession, "OWNER_APPROVER_SESSION_INVALID");
  const run = asRecord(input.run, "OWNER_JOURNEY_RUN_INVALID");
  const approverPin = requireString(input.approverPin, "OWNER_APPROVER_PIN_INVALID");
  requireThat(/^\d{4,8}$/u.test(approverPin), "OWNER_APPROVER_PIN_INVALID");
  requireThat(typeof input.updateSession === "function", "OWNER_SESSION_UPDATE_INVALID");
  return Object.freeze({
    api,
    adminSession,
    approverStaffId: requireUuid(approverSession.staffId, "OWNER_APPROVER_SESSION_INVALID"),
    approverPin,
    runId: requireString(run.runId, "OWNER_JOURNEY_RUN_INVALID"),
    label: requireString(run.label, "OWNER_JOURNEY_RUN_INVALID"),
    updateSession: input.updateSession,
  });
}

export function createOwnerOperationsJourney(options) {
  const context = ownerContext(options);
  const syntheticName = `ADR40 ${context.label}`.slice(0, 128);
  const reason = `ADR40 owner operations ${context.runId}`.slice(0, 256);
  let adminSession = context.adminSession;
  let state = Object.freeze({
    phase: "ready",
    original: null,
    changeStarted: false,
  });
  const update = (patch) => {
    state = Object.freeze({ ...state, ...patch });
  };

  const readDirectory = async () => {
    const directory = storeDirectory(
      await context.api.query(adminSession, "store.authorized.list", {}),
    );
    const current = directory.stores.find((store) => store.isCurrent);
    requireThat(current !== undefined, "OWNER_CURRENT_STORE_MISSING");
    return Object.freeze({ directory, current });
  };

  const refreshForName = async (storeName) => {
    const refreshed = asRecord(
      await context.api.refresh(adminSession),
      "OWNER_SESSION_REFRESH_INVALID",
    );
    const display = asRecord(refreshed.display, "OWNER_SESSION_REFRESH_INVALID");
    requireThat(display.store_name === storeName, "OWNER_SESSION_STORE_NAME_INVALID");
    adminSession = Object.freeze({ ...refreshed });
    context.updateSession(adminSession);
  };

  const setName = (current, storeName) =>
    context.api.stepUp(
      adminSession,
      "store.profile.set",
      {
        expected_profile_version: current.profileVersion,
        store_name: storeName,
        reason,
      },
      context.approverStaffId,
      context.approverPin,
    );

  const execute = async () => {
    requireThat(state.phase === "ready", "OWNER_JOURNEY_ALREADY_STARTED");
    update({ phase: "running" });
    const initial = await readDirectory();
    const display = asRecord(adminSession.display, "OWNER_ADMIN_SESSION_INVALID");
    requireThat(
      display.store_code === initial.current.storeCode &&
        display.store_name === initial.current.storeName &&
        syntheticName !== initial.current.storeName,
      "OWNER_SESSION_STORE_INVALID",
    );
    update({ original: initial.current, changeStarted: true });
    const changed = changedStore(await setName(initial.current, syntheticName));
    requireThat(
      changed.storeCode === initial.current.storeCode &&
        changed.storeName === syntheticName &&
        changed.timeZone === initial.current.timeZone &&
        changed.profileVersion === initial.current.profileVersion + 1,
      "OWNER_STORE_CHANGE_INVALID",
    );
    const observed = await readDirectory();
    requireThat(
      observed.current.storeName === changed.storeName &&
        observed.current.profileVersion === changed.profileVersion &&
        observed.current.updatedAt === changed.updatedAt,
      "OWNER_STORE_CHANGE_NOT_VISIBLE",
    );
    await refreshForName(syntheticName);
    update({ phase: "executed" });
  };

  const cleanup = async () => {
    if (!state.changeStarted || state.original === null) return true;
    try {
      let observed = await readDirectory();
      if (observed.current.storeName !== state.original.storeName) {
        if (observed.current.storeName !== syntheticName) return false;
        try {
          changedStore(await setName(observed.current, state.original.storeName));
        } catch {
          // A response can fail after the transaction commits; the follow-up query is authoritative.
        }
        observed = await readDirectory();
      }
      if (
        observed.current.storeCode !== state.original.storeCode ||
        observed.current.storeName !== state.original.storeName ||
        observed.current.timeZone !== state.original.timeZone
      ) {
        return false;
      }
      await refreshForName(state.original.storeName);
      update({ phase: "cleaned" });
      return true;
    } catch {
      return false;
    }
  };

  return Object.freeze({ execute, cleanup });
}

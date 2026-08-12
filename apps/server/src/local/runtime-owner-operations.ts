import type { AccountingHandlerDeps, AccountingReadPort } from "../accounting/types.js";
import {
  createMemoryStoreManagementDeps,
  createPgStoreManagementDeps,
} from "../store-management/runtime.js";
import { readPgStoreTimeZone } from "../store-management/time-zone.js";
import { LOCAL_PROFILE } from "./profile.js";

export { createMemoryStoreManagementDeps, createPgStoreManagementDeps };

export function createPgAccountingDeps(source: AccountingReadPort): AccountingHandlerDeps {
  return Object.freeze({
    source,
    timeZone: LOCAL_PROFILE.timezone,
    resolveTimeZone: readPgStoreTimeZone,
  });
}

import type { LocalStaffDirectoryEntry } from "../local/staff-directory.js";
import { createMemoryStaffAccessStore } from "./access-store.js";
import type { StaffAccessHandlerDeps } from "./handlers.js";

export function createMemoryStaffAccessDeps(
  directory: readonly LocalStaffDirectoryEntry[],
): StaffAccessHandlerDeps {
  return Object.freeze({
    store: createMemoryStaffAccessStore(
      directory.map((entry) =>
        Object.freeze({
          ...entry,
          is_active: true,
          permission_version: 1,
        }),
      ),
    ),
  });
}

export function createPgStaffAccessDeps(): StaffAccessHandlerDeps {
  return Object.freeze({
    persistence: "sql",
    store: createMemoryStaffAccessStore([]),
  });
}

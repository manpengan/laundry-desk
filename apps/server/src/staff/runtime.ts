import type { LocalStaffDirectoryEntry } from "../local/staff-directory.js";
import type { MemoryCredentialIdentityAdapter } from "./credential-types.js";
import { createMemoryStaffAccessState, createMemoryStaffAccessStore } from "./access-store.js";
import type { StaffAccessHandlerDeps } from "./handlers.js";
import { createMemoryStaffCredentialStore } from "./memory-credential-store.js";

const unreachablePgCredentialStore = Object.freeze({
  create: async () => {
    throw new Error("PostgreSQL credential store must bind the command transaction");
  },
  reset: async () => {
    throw new Error("PostgreSQL credential store must bind the command transaction");
  },
  complete: async () => {
    throw new Error("PostgreSQL credential store must bind the route transaction");
  },
});

export function createMemoryStaffAccessDeps(
  directory: readonly LocalStaffDirectoryEntry[],
  identity: MemoryCredentialIdentityAdapter,
): StaffAccessHandlerDeps {
  const state = createMemoryStaffAccessState(
    directory.map((entry) =>
      Object.freeze({
        ...entry,
        is_active: true,
        permission_version: 1,
      }),
    ),
  );
  return Object.freeze({
    store: createMemoryStaffAccessStore(state),
    credentials: createMemoryStaffCredentialStore(state, identity),
  });
}

export function createPgStaffAccessDeps(): StaffAccessHandlerDeps {
  return Object.freeze({
    persistence: "sql",
    store: createMemoryStaffAccessStore([]),
    credentials: unreachablePgCredentialStore,
  });
}

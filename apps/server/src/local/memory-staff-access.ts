import type { MemoryIdentityStore } from "../identity/memory-store.js";
import { createMemoryStaffAccessDeps } from "../staff/runtime.js";
import { LOCAL_PROFILE } from "./profile.js";
import { LOCAL_MEMORY_STAFF_DIRECTORY } from "./staff-directory.js";

export function createLocalMemoryStaffAccessDeps(store: MemoryIdentityStore) {
  return createMemoryStaffAccessDeps(LOCAL_MEMORY_STAFF_DIRECTORY, {
    orgId: LOCAL_PROFILE.orgId,
    findStaff: (staffId) => store.staff.findById(LOCAL_PROFILE.orgId, staffId),
    upsertStaff: store.seedStaff,
    revokeSessions: async (staffId, now) => {
      for (const session of store.listSessions()) {
        if (session.staff_id !== staffId || session.status !== "active") continue;
        await store.sessions.revoke(session.session_id, session.session_version + 1, now);
        await store.refresh.revokeFamily(session.family_id);
      }
    },
  });
}

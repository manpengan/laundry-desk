/**
 * Local-dev demo seed (memory identity). Credentials are LOCAL ONLY.
 * Aligns with apps/web mock: password `demo`, PIN `1234`.
 */

import { createAccessTokenSigner } from "../identity/crypto-util.js";
import { createMemoryIdentityStore } from "../identity/memory-store.js";
import { createScryptPasswordPort } from "../identity/password.js";
import type { StaffRecord, Uuid } from "../identity/types.js";
import type { IdentityHandlerDeps } from "../handlers/identity-handlers.js";
import {
  createMemoryAuditQueryStore,
  createMemoryFeaturesStore,
  createMemorySettingsStore,
} from "../platform/index.js";
import type { PlatformHandlerDeps } from "../platform/handlers.js";

/** LOCAL ONLY — match apps/web mock defaults. */
export const DEMO_PASSWORD = "demo";
/** LOCAL ONLY */
export const DEMO_PIN = "1234";

export const DEMO_ORG_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const DEMO_STORE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const DEMO_ADMIN_ID = "11111111-1111-4111-8111-111111111103";
export const DEMO_STAFF_A_ID = "11111111-1111-4111-8111-111111111101";
export const DEMO_STAFF_B_ID = "11111111-1111-4111-8111-111111111102";

export type LocalStaffDirectoryEntry = Readonly<{
  staff_id: string;
  display_name: string;
  role: "admin" | "staff";
  username: string;
}>;

export type LocalRuntime = Readonly<{
  identity: IdentityHandlerDeps;
  platform: PlatformHandlerDeps;
  store: ReturnType<typeof createMemoryIdentityStore>;
  accessTokenSecret: string;
  staffDirectory: readonly LocalStaffDirectoryEntry[];
}>;

const FIXED_SECRET = "local-dev-access-secret-do-not-use-in-prod";

export async function createLocalRuntime(): Promise<LocalRuntime> {
  const store = createMemoryIdentityStore();
  const passwordPort = createScryptPasswordPort();
  const passwordHash = await passwordPort.hashPassword(DEMO_PASSWORD);
  const pinHash = await passwordPort.hashPassword(DEMO_PIN);

  store.seedOrgStore({
    org_id: DEMO_ORG_ID,
    org_code: "hongfa",
    store_id: DEMO_STORE_ID,
    store_code: "main",
  });

  const seedStaff = (staffId: Uuid, username: string, displayName: string): void => {
    const staff: StaffRecord = Object.freeze({
      staff_id: staffId,
      org_id: DEMO_ORG_ID,
      username,
      password_hash: passwordHash,
      pin_hash: pinHash,
      display_name: displayName,
      is_active: true,
      permission_version: 1,
    });
    store.seedStaff(staff);
  };

  seedStaff(DEMO_ADMIN_ID, "admin", "店长");
  seedStaff(DEMO_STAFF_A_ID, "staff", "店员甲");
  seedStaff(DEMO_STAFF_B_ID, "staffb", "店员乙");

  const clock = {
    nowEpochSeconds: () => Math.floor(Date.now() / 1000),
  };
  const sessionDeps = {
    sessions: store.sessions,
    refresh: store.refresh,
    clock,
    accessTokenSigner: createAccessTokenSigner(FIXED_SECRET),
  };
  const login = {
    staff: store.staff,
    orgStore: store.orgStore,
    passwordPort,
    sessions: sessionDeps,
  };
  const pin = {
    challenges: store.pinChallenges,
    lockouts: store.pinLockouts,
    staff: store.staff,
    pinPort: passwordPort,
    clock,
    sessions: sessionDeps,
  };

  const identity: IdentityHandlerDeps = Object.freeze({
    login,
    sessions: sessionDeps,
    pin,
    pinChallenges: store.pinChallenges,
    clock,
    resolveBinding: () =>
      Object.freeze({
        session: null,
        refreshSecret: null,
      }),
  });

  const platform: PlatformHandlerDeps = Object.freeze({
    settings: createMemorySettingsStore(),
    features: createMemoryFeaturesStore(),
    audit: createMemoryAuditQueryStore(),
  });

  const staffDirectory = Object.freeze([
    Object.freeze({
      staff_id: DEMO_STAFF_A_ID,
      display_name: "店员甲",
      role: "staff" as const,
      username: "staff",
    }),
    Object.freeze({
      staff_id: DEMO_STAFF_B_ID,
      display_name: "店员乙",
      role: "staff" as const,
      username: "staffb",
    }),
    Object.freeze({
      staff_id: DEMO_ADMIN_ID,
      display_name: "店长",
      role: "admin" as const,
      username: "admin",
    }),
  ]);

  return Object.freeze({
    identity,
    platform,
    store,
    accessTokenSecret: FIXED_SECRET,
    staffDirectory,
  });
}

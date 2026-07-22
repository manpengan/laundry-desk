/**
 * Build LocalRuntime for memory (default) or Postgres (DATABASE_URL / LAUNDRY_USE_LOCAL_PG).
 */

import { createAccessTokenSigner } from "../identity/crypto-util.js";
import { createMemoryIdentityStore } from "../identity/memory-store.js";
import { createPgIdentityStore } from "../identity/pg-store.js";
import { createScryptPasswordPort } from "../identity/password.js";
import type { StaffRecord, Uuid } from "../identity/types.js";
import type { IdentityHandlerDeps } from "../handlers/identity-handlers.js";
import {
  createMemoryAuditQueryStore,
  createMemoryFeaturesStore,
  createMemorySettingsStore,
} from "../platform/index.js";
import type { PlatformHandlerDeps } from "../platform/handlers.js";
import {
  createPgPool,
  resolveIdentityDatabaseUrl,
  type PgPool,
} from "../db/pg-pool.js";
import {
  DEMO_ADMIN_ID,
  DEMO_ORG_ID,
  DEMO_PASSWORD,
  DEMO_PIN,
  DEMO_STAFF_A_ID,
  DEMO_STAFF_B_ID,
  DEMO_STORE_ID,
} from "./demo-ids.js";
import { seedDemoIdentity } from "./pg-seed.js";

export {
  DEMO_ADMIN_ID,
  DEMO_ORG_ID,
  DEMO_PASSWORD,
  DEMO_PIN,
  DEMO_STAFF_A_ID,
  DEMO_STAFF_B_ID,
  DEMO_STORE_ID,
} from "./demo-ids.js";

export type LocalStaffDirectoryEntry = Readonly<{
  staff_id: string;
  display_name: string;
  role: "admin" | "staff";
  username: string;
}>;

export type LocalRuntimeMode = "memory" | "pg";

export type LocalRuntime = Readonly<{
  mode: LocalRuntimeMode;
  identity: IdentityHandlerDeps;
  platform: PlatformHandlerDeps;
  accessTokenSecret: string;
  staffDirectory: readonly LocalStaffDirectoryEntry[];
  /** Present when mode === "pg"; close on shutdown. */
  pool: PgPool | null;
  /** Memory store when mode === "memory" (tests). */
  store: ReturnType<typeof createMemoryIdentityStore> | null;
}>;

const FIXED_SECRET = "local-dev-access-secret-do-not-use-in-prod";

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

function buildIdentityDeps(
  ports: Readonly<{
    staff: ReturnType<typeof createMemoryIdentityStore>["staff"];
    orgStore: ReturnType<typeof createMemoryIdentityStore>["orgStore"];
    sessions: ReturnType<typeof createMemoryIdentityStore>["sessions"];
    refresh: ReturnType<typeof createMemoryIdentityStore>["refresh"];
    pinChallenges: ReturnType<typeof createMemoryIdentityStore>["pinChallenges"];
    pinLockouts: ReturnType<typeof createMemoryIdentityStore>["pinLockouts"];
  }>,
  passwordPort: ReturnType<typeof createScryptPasswordPort>,
): IdentityHandlerDeps {
  const clock = {
    nowEpochSeconds: () => Math.floor(Date.now() / 1000),
  };
  const sessionDeps = {
    sessions: ports.sessions,
    refresh: ports.refresh,
    clock,
    accessTokenSigner: createAccessTokenSigner(FIXED_SECRET),
  };
  const login = {
    staff: ports.staff,
    orgStore: ports.orgStore,
    passwordPort,
    sessions: sessionDeps,
  };
  const pin = {
    challenges: ports.pinChallenges,
    lockouts: ports.pinLockouts,
    staff: ports.staff,
    pinPort: passwordPort,
    clock,
    sessions: sessionDeps,
  };

  return Object.freeze({
    login,
    sessions: sessionDeps,
    pin,
    pinChallenges: ports.pinChallenges,
    clock,
    resolveBinding: () =>
      Object.freeze({
        session: null,
        refreshSecret: null,
      }),
  });
}

function buildPlatform(): PlatformHandlerDeps {
  return Object.freeze({
    settings: createMemorySettingsStore(),
    features: createMemoryFeaturesStore(),
    audit: createMemoryAuditQueryStore(),
  });
}

/** In-memory identity (unit tests / no Docker). */
export async function createMemoryLocalRuntime(): Promise<LocalRuntime> {
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

  return Object.freeze({
    mode: "memory" as const,
    identity: buildIdentityDeps(store, passwordPort),
    platform: buildPlatform(),
    accessTokenSecret: FIXED_SECRET,
    staffDirectory,
    pool: null,
    store,
  });
}

/** Postgres identity against formal M1 tables (seed demo on boot). */
export async function createPgLocalRuntime(connectionString: string): Promise<LocalRuntime> {
  const pool = createPgPool({ connectionString });
  try {
    await seedDemoIdentity(pool);
  } catch (error) {
    await pool.end();
    throw error;
  }

  const store = createPgIdentityStore(pool);
  const passwordPort = createScryptPasswordPort();

  return Object.freeze({
    mode: "pg" as const,
    identity: buildIdentityDeps(store, passwordPort),
    platform: buildPlatform(),
    accessTokenSecret: FIXED_SECRET,
    staffDirectory,
    pool,
    store: null,
  });
}

/**
 * Auto-select: DATABASE_URL / LAUNDRY_USE_LOCAL_PG → PG; else memory.
 */
export async function createLocalRuntime(
  env: NodeJS.ProcessEnv = process.env,
): Promise<LocalRuntime> {
  const url = resolveIdentityDatabaseUrl(env);
  if (url !== null) {
    return createPgLocalRuntime(url);
  }
  return createMemoryLocalRuntime();
}

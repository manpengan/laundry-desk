/**
 * Build LocalRuntime for memory (default) or Postgres (DATABASE_URL / LAUNDRY_USE_LOCAL_PG).
 */

import { randomBytes } from "node:crypto";

import { z } from "zod";

import { ACCESS_TOKEN_AUDIENCE, ACCESS_TOKEN_ISSUER } from "@laundry/contracts";

import { createAccessTokenSigner } from "../identity/crypto-util.js";
import { createMemoryIdentityStore } from "../identity/memory-store.js";
import { createPgIdentityStore } from "../identity/pg-store.js";
import { createPasswordPort } from "../identity/password.js";
import type { StaffRecord, Uuid } from "../identity/types.js";
import type { CatalogHandlerDeps } from "../catalog/handlers.js";
import { createMemoryCatalogStore } from "../catalog/memory-catalog.js";
import { createPgCatalogStore } from "../catalog/pg-catalog-store.js";
import type { CustomerHandlerDeps } from "../customer/handlers.js";
import { createMemoryCustomerStore } from "../customer/memory-store.js";
import { createPgCustomerStore } from "../customer/pg-customer-store.js";
import type { IdentityHandlerDeps } from "../handlers/identity-handlers.js";
import type { OrderHandlerDeps } from "../order/handlers.js";
import { createMemoryOrderStore } from "../order/memory-store.js";
import { createMemoryPrintJobStore } from "../print/memory-store.js";
import type { PrintHandlerDeps } from "../print/handlers.js";
import { createPgPrintJobStore } from "../print/pg-print-store.js";
import { createPgOrderStore } from "../order/pg-order-store.js";
import { createOrderBackedStatsQuery } from "../stats/memory-source.js";
import { createPgStatsQuery } from "../stats/pg-source.js";
import type { StatsHandlerDeps } from "../stats/handlers.js";
import type { ShiftHandlerDeps } from "../shift/handlers.js";
import { createMemoryShiftStore } from "../shift/memory-store.js";
import { createPgShiftStore } from "../shift/pg-shift-store.js";
import type { PhotoHandlerDeps } from "../photo/handlers.js";
import { createMemoryPhotoStore } from "../photo/memory-store.js";
import { createPgPhotoStore } from "../photo/pg-photo-store.js";
import { processPendingActionStore } from "../pending-actions/process-store.js";
import type { PendingActionStore } from "../pending-actions/types.js";
import {
  createMemoryAuditQueryStore,
  createMemoryFeaturesStore,
  createMemorySettingsStore,
} from "../platform/index.js";
import type { PlatformHandlerDeps } from "../platform/handlers.js";
import { processStepUpProofStore, type StepUpProofStore } from "../policy/step-up-proof-store.js";
import {
  createPgPool,
  resolveRuntimeDatabaseUrl,
  type CreatePoolOptions,
  type PgPool,
} from "../db/pg-pool.js";
import { withStoreGuc } from "../db/tenant-guc-client.js";
import { DEMO_PASSWORD, DEMO_PIN, DEMO_STAFF_A_ID, DEMO_STAFF_B_ID } from "./demo-ids.js";
import { assertLocalBootstrapReady } from "./bootstrap.js";
import {
  parseLocalHostConfig,
  parseLocalServerConfig,
  parseLocalSigningSecrets,
  type LocalServerConfig,
} from "./config.js";
import { LOCAL_PROFILE } from "./profile.js";

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
  /** M2 order receive/pickup (memory or PG). */
  order: OrderHandlerDeps;
  /** M2 catalog price list (memory seed or PG catalog_items). */
  catalog: CatalogHandlerDeps;
  /** M2 print job queue (memory or PG print_jobs). */
  print: PrintHandlerDeps;
  /** M2 day stats (order-backed). */
  stats: StatsHandlerDeps;
  /** M2 customer archive (memory seed or PG customers). */
  customer: CustomerHandlerDeps;
  /** M2 shift closing (memory; both runtime modes for skeleton). */
  shift: ShiftHandlerDeps;
  /** M3 garment photo metadata (memory; both runtime modes for skeleton). */
  photo: PhotoHandlerDeps;
  accessTokenSecret: string;
  csrfProofSecret: string;
  staffDirectory: readonly LocalStaffDirectoryEntry[];
  /** Shared with Command Bus for confirm_ref / step-up PIN. */
  pendingStore: PendingActionStore;
  stepUpProofStore: StepUpProofStore;
  /** Present when mode === "pg"; close on shutdown. */
  pool: PgPool | null;
  /** Memory store when mode === "memory" (tests). */
  store: ReturnType<typeof createMemoryIdentityStore> | null;
}>;

export type CreatePgLocalRuntimeDependencies = Readonly<{
  createPool: (options: CreatePoolOptions) => PgPool;
  assertReady: (pool: PgPool, expectedDemoOnly: boolean) => Promise<void>;
  loadStaffDirectory: (pool: PgPool) => Promise<readonly LocalStaffDirectoryEntry[]>;
}>;

const defaultPgRuntimeDependencies: CreatePgLocalRuntimeDependencies = Object.freeze({
  createPool: createPgPool,
  assertReady: assertLocalBootstrapReady,
  loadStaffDirectory: loadPgStaffDirectory,
});

const memoryStaffDirectory = Object.freeze([
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
    staff_id: LOCAL_PROFILE.adminStaffId,
    display_name: "店长",
    role: "admin" as const,
    username: "admin",
  }),
]);

function freezeStaffDirectory(
  entries: readonly LocalStaffDirectoryEntry[],
): readonly LocalStaffDirectoryEntry[] {
  return Object.freeze(
    entries.map((entry) => (Object.isFrozen(entry) ? entry : Object.freeze({ ...entry }))),
  );
}

type PgStaffDirectoryRow = Readonly<{
  staff_id: string;
  display_name: string;
  role: string;
  username: string;
}>;

const PgStaffDirectoryRowSchema = z
  .object({
    staff_id: z.uuid(),
    display_name: z.string().trim().min(1),
    role: z.enum(["admin", "staff"]),
    username: z.string().trim().min(1),
  })
  .strict()
  .readonly();

function mapPgStaffDirectoryRow(row: PgStaffDirectoryRow): LocalStaffDirectoryEntry {
  return PgStaffDirectoryRowSchema.parse(row);
}

export async function loadPgStaffDirectory(
  pool: PgPool,
): Promise<readonly LocalStaffDirectoryEntry[]> {
  const rows = await withStoreGuc(
    pool,
    {
      orgId: LOCAL_PROFILE.orgId,
      storeId: LOCAL_PROFILE.storeId,
      staffId: LOCAL_PROFILE.adminStaffId,
    },
    async (client) => {
      const result = await client.query<PgStaffDirectoryRow>(
        `SELECT staff.id::text AS staff_id, staff.display_name, role.role, staff.username
           FROM staffs staff
           JOIN staff_store_roles role
             ON role.org_id = staff.org_id
            AND role.staff_id = staff.id
          WHERE staff.org_id = $1::uuid
            AND role.store_id = $2::uuid
            AND staff.is_active = true
            AND role.is_active = true
          ORDER BY staff.username, staff.id`,
        [LOCAL_PROFILE.orgId, LOCAL_PROFILE.storeId],
      );
      return result.rows.map(mapPgStaffDirectoryRow);
    },
  );
  return rows;
}

function buildIdentityDeps(
  ports: Readonly<{
    staff: ReturnType<typeof createMemoryIdentityStore>["staff"];
    orgStore: ReturnType<typeof createMemoryIdentityStore>["orgStore"];
    sessions: ReturnType<typeof createMemoryIdentityStore>["sessions"];
    refresh: ReturnType<typeof createMemoryIdentityStore>["refresh"];
    lifecycle: ReturnType<typeof createMemoryIdentityStore>["lifecycle"];
    pinChallenges: ReturnType<typeof createMemoryIdentityStore>["pinChallenges"];
    pinLockouts: ReturnType<typeof createMemoryIdentityStore>["pinLockouts"];
  }>,
  passwordPort: ReturnType<typeof createPasswordPort>,
  accessTokenSecret: string,
  pendingStore: PendingActionStore = processPendingActionStore,
  proofStore: StepUpProofStore = processStepUpProofStore,
): IdentityHandlerDeps {
  const clock = {
    nowEpochSeconds: () => Math.floor(Date.now() / 1000),
  };
  const sessionDeps = {
    sessions: ports.sessions,
    refresh: ports.refresh,
    lifecycle: ports.lifecycle,
    clock,
    accessTokenSigner: createAccessTokenSigner({
      secret: accessTokenSecret,
      issuer: ACCESS_TOKEN_ISSUER,
      audience: ACCESS_TOKEN_AUDIENCE,
    }),
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
  const pinStepUp = Object.freeze({
    ...pin,
    pending: pendingStore,
    proofs: proofStore,
  });

  return Object.freeze({
    login,
    sessions: sessionDeps,
    pin,
    pinStepUp,
    resolveBinding: () =>
      Object.freeze({
        session: null,
        refreshSecret: null,
      }),
  });
}

function buildPlatform(persistence: "memory" | "sql" = "memory"): PlatformHandlerDeps {
  // Memory stores still required as typed placeholders; SQL mode rebinds per request via ctx.client.
  return Object.freeze({
    persistence,
    settings: createMemorySettingsStore(),
    features: createMemoryFeaturesStore(),
    audit: createMemoryAuditQueryStore(),
  });
}

function mintRuntimeSecret(): string {
  return randomBytes(32).toString("base64url");
}

async function closeFailedPgPool(pool: PgPool, initializationError: unknown): Promise<never> {
  try {
    await pool.end();
  } catch (cleanupError) {
    throw new AggregateError(
      [initializationError, cleanupError],
      "PostgreSQL runtime initialization and pool cleanup both failed",
      { cause: initializationError },
    );
  }
  throw initializationError;
}

/** In-memory identity (unit tests / no Docker). */
export async function createMemoryLocalRuntime(): Promise<LocalRuntime> {
  const store = createMemoryIdentityStore();
  const passwordPort = createPasswordPort();
  const passwordHash = await passwordPort.hashPassword(DEMO_PASSWORD);
  const pinHash = await passwordPort.hashPassword(DEMO_PIN);
  const accessTokenSecret = mintRuntimeSecret();
  const csrfProofSecret = mintRuntimeSecret();

  store.seedOrgStore({
    org_id: LOCAL_PROFILE.orgId,
    org_code: LOCAL_PROFILE.orgCode,
    store_id: LOCAL_PROFILE.storeId,
    store_code: LOCAL_PROFILE.storeCode,
  });

  const seedStaff = (staffId: Uuid, username: string, displayName: string): void => {
    const staff: StaffRecord = Object.freeze({
      staff_id: staffId,
      org_id: LOCAL_PROFILE.orgId,
      username,
      password_hash: passwordHash,
      pin_hash: pinHash,
      display_name: displayName,
      is_active: true,
      permission_version: 1,
    });
    store.seedStaff(staff);
  };

  seedStaff(LOCAL_PROFILE.adminStaffId, "admin", "店长");
  seedStaff(DEMO_STAFF_A_ID, "staff", "店员甲");
  seedStaff(DEMO_STAFF_B_ID, "staffb", "店员乙");

  const orderStore = createMemoryOrderStore();
  const customerStore = createMemoryCustomerStore();
  const statsSource = createOrderBackedStatsQuery(orderStore);
  const shiftStore = createMemoryShiftStore();
  const photoStore = createMemoryPhotoStore();
  return Object.freeze({
    mode: "memory" as const,
    identity: buildIdentityDeps(
      store,
      passwordPort,
      accessTokenSecret,
      processPendingActionStore,
      processStepUpProofStore,
    ),
    platform: buildPlatform("memory"),
    order: Object.freeze({ store: orderStore, customer: customerStore }),
    catalog: Object.freeze({ store: createMemoryCatalogStore() }),
    print: Object.freeze({ store: createMemoryPrintJobStore() }),
    stats: Object.freeze({ source: statsSource }),
    customer: Object.freeze({ store: customerStore }),
    shift: Object.freeze({ store: shiftStore, stats: statsSource }),
    photo: Object.freeze({ store: photoStore }),
    accessTokenSecret,
    csrfProofSecret,
    staffDirectory: memoryStaffDirectory,
    pendingStore: processPendingActionStore,
    stepUpProofStore: processStepUpProofStore,
    pool: null,
    store,
  });
}

/** Postgres runtime: one verified laundry_app pool, with no owner connection or seed path. */
export async function createPgLocalRuntime(
  connectionString: string,
  expectedDemoOnly: boolean,
  config: LocalServerConfig = parseLocalServerConfig(process.env),
  dependencies: CreatePgLocalRuntimeDependencies = defaultPgRuntimeDependencies,
): Promise<LocalRuntime> {
  const appPool = dependencies.createPool({ connectionString });
  let pgStaffDirectory: readonly LocalStaffDirectoryEntry[];
  try {
    await dependencies.assertReady(appPool, expectedDemoOnly);
    pgStaffDirectory = freezeStaffDirectory(await dependencies.loadStaffDirectory(appPool));
  } catch (error) {
    return closeFailedPgPool(appPool, error);
  }

  const store = createPgIdentityStore(appPool);
  const passwordPort = createPasswordPort();
  const orderStore = createPgOrderStore(appPool);
  const customerStore = createPgCustomerStore(appPool, { orgId: LOCAL_PROFILE.orgId });
  const statsSource = createPgStatsQuery(appPool);
  const shiftStore = createPgShiftStore(appPool, {
    orgId: LOCAL_PROFILE.orgId,
    storeId: LOCAL_PROFILE.storeId,
  });
  const photoStore = createPgPhotoStore(appPool, {
    orgId: LOCAL_PROFILE.orgId,
    storeId: LOCAL_PROFILE.storeId,
  });

  return Object.freeze({
    mode: "pg" as const,
    identity: buildIdentityDeps(
      store,
      passwordPort,
      config.accessTokenSecret,
      processPendingActionStore,
      processStepUpProofStore,
    ),
    platform: buildPlatform("sql"),
    order: Object.freeze({ store: orderStore, customer: customerStore }),
    catalog: Object.freeze({
      store: createPgCatalogStore(appPool, {
        orgId: LOCAL_PROFILE.orgId,
        storeId: LOCAL_PROFILE.storeId,
      }),
    }),
    print: Object.freeze({
      store: createPgPrintJobStore(appPool, {
        orgId: LOCAL_PROFILE.orgId,
        storeId: LOCAL_PROFILE.storeId,
      }),
    }),
    stats: Object.freeze({ source: statsSource }),
    customer: Object.freeze({ store: customerStore }),
    shift: Object.freeze({ store: shiftStore, stats: statsSource }),
    photo: Object.freeze({ store: photoStore }),
    accessTokenSecret: config.accessTokenSecret,
    csrfProofSecret: config.csrfProofSecret,
    staffDirectory: pgStaffDirectory,
    pendingStore: processPendingActionStore,
    stepUpProofStore: processStepUpProofStore,
    pool: appPool,
    store: null,
  });
}

/**
 * Auto-select: DATABASE_URL / LAUNDRY_USE_LOCAL_PG → PG; else explicit local demo memory.
 * Production must provide a dedicated laundry_app DATABASE_URL and never silently
 * start a counter runtime backed by process memory.
 */
export async function createLocalRuntime(
  env: NodeJS.ProcessEnv = process.env,
): Promise<LocalRuntime> {
  const isProduction = env.NODE_ENV === "production";
  const explicitDatabaseUrl = env.DATABASE_URL?.trim() ?? "";
  if (isProduction && explicitDatabaseUrl.length === 0) {
    throw new Error("Production runtime requires DATABASE_URL for the laundry_app role");
  }
  const hostConfig = parseLocalHostConfig(env);
  const databaseUrl = resolveRuntimeDatabaseUrl(env);
  if (databaseUrl !== null) {
    return createPgLocalRuntime(
      databaseUrl,
      env.LAUNDRY_LOCAL_DEMO === "1",
      Object.freeze({
        ...hostConfig,
        ...parseLocalSigningSecrets(env),
      }),
    );
  }
  if (isProduction) {
    throw new Error("Production runtime cannot fall back to memory mode");
  }
  return createMemoryLocalRuntime();
}

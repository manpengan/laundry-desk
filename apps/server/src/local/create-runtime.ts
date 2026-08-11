import { ACCESS_TOKEN_AUDIENCE, ACCESS_TOKEN_ISSUER } from "@laundry/contracts";
import { createMemoryAccountingSource, createPgAccountingSource } from "../accounting/index.js";
import { createMemoryReportingDeps, createPgReportingDeps } from "../reporting/index.js";
import { createCsrfProofSigner, type CsrfProofSigner } from "../auth/csrf.js";
import {
  createMemoryRuntimeAuthority,
  createPgRuntimeAuthority,
} from "../edge/runtime-authority.js";
import { MemoryIdempotencyStore } from "../bus/idempotency.js";
import { createPgIdempotencyStore } from "../bus/pg-idempotency.js";
import { createAccessTokenSigner } from "../identity/crypto-util.js";
import { createMemoryIdentityStore } from "../identity/memory-store.js";
import { createPgIdentityStore } from "../identity/pg-store.js";
import { createPgStepUpProofStore } from "../identity/pg-step-up-proof-store.js";
import { createPasswordPort } from "../identity/password.js";
import type { StaffRecord, Uuid } from "../identity/types.js";
import { createMemoryCatalogStore } from "../catalog/memory-catalog.js";
import { createPgCatalogStore } from "../catalog/pg-catalog-store.js";
import { createMemoryCustomerStore, DEMO_CUSTOMERS } from "../customer/memory-store.js";
import { createPgCustomerStore } from "../customer/pg-customer-store.js";
import type { IdentityHandlerDeps } from "../handlers/identity-handlers.js";
import { createMemoryOrderStore } from "../order/memory-store.js";
import { createMemoryPrintJobStore } from "../print/memory-store.js";
import { createPgPrintJobStore } from "../print/pg-print-store.js";
import { createFileSpool } from "../print/file-spool.js";
import { createPgPrintDispatchService } from "../print/pg-print-dispatch.js";
import { snapshotFromOrder } from "../print/snapshot.js";
import { createPgOrderStore } from "../order/pg-order-store.js";
import { createMemoryPricingPolicyStore, createPgPricingPolicyStore } from "../pricing/index.js";
import { createOrderBackedStatsQuery } from "../stats/memory-source.js";
import { createPgStatsQuery } from "../stats/pg-source.js";
import { createPgStaffAccessDeps } from "../staff/runtime.js";
import { createMemoryMemberDeps, createPgMemberDeps } from "../member/runtime.js";
import { createMemoryNotificationStore, createPgNotificationStore } from "../notification/index.js";
import { createMemoryShiftStore } from "../shift/memory-store.js";
import { createPgShiftStore } from "../shift/pg-shift-store.js";
import { acquirePgBusinessDayLock } from "../workday/business-day-lock.js";
import type { PhotoHandlerDeps } from "../photo/handlers.js";
import { createMemoryPhotoStore } from "../photo/memory-store.js";
import { preparePgPhotoDeps } from "../photo/runtime-files.js";
import { processPendingActionStore } from "../pending-actions/process-store.js";
import { createPgPendingActionStore } from "../pending-actions/pg-store.js";
import type { PendingActionStore } from "../pending-actions/types.js";
import { processStepUpProofStore, type StepUpProofStore } from "../policy/step-up-proof-store.js";
import { createMemoryFulfillmentStore } from "../fulfillment/memory-store.js";
import { createPgFulfillmentStore } from "../fulfillment/pg-store.js";
import { deriveEdgeAuthorityKeyPair } from "../edge/authority-key.js";
import {
  createPgPool,
  resolveRuntimeDatabaseUrl,
  RUNTIME_DATABASE_URL_REQUIRED,
  type CreatePoolOptions,
  type PgPool,
} from "../db/pg-pool.js";
import { DEMO_PASSWORD, DEMO_PIN, DEMO_STAFF_A_ID, DEMO_STAFF_B_ID } from "./demo-ids.js";
import { assertLocalBootstrapReady } from "./bootstrap.js";
import {
  parseLocalHostConfig,
  parseLocalPhotoStoreDir,
  parseLocalPrintSpoolDir,
  parseLocalServerConfig,
  parseLocalSigningSecrets,
  type LocalServerConfig,
} from "./config.js";
import { LOCAL_PROFILE } from "./profile.js";
import { createLocalMemoryStaffAccessDeps } from "./memory-staff-access.js";
import { buildPlatform, mintRuntimeSecret } from "./runtime-support.js";
import {
  freezeStaffDirectory,
  loadPgStaffDirectory,
  LOCAL_MEMORY_STAFF_DIRECTORY,
  type LocalStaffDirectoryEntry,
} from "./staff-directory.js";
import {
  createPgStaffRoleResolver,
  resolveMemoryStaffRole,
  type StaffRoleResolver,
} from "./staff-role-resolver.js";
import {
  createMemoryReconciliationDeps,
  createPgReconciliationDeps,
} from "./runtime-reconciliation.js";
import type { LocalRuntime } from "./runtime-types.js";

export {
  DEMO_ADMIN_ID,
  DEMO_ORG_ID,
  DEMO_PASSWORD,
  DEMO_PIN,
  DEMO_STAFF_A_ID,
  DEMO_STAFF_B_ID,
  DEMO_STORE_ID,
} from "./demo-ids.js";

export type { LocalStaffDirectoryEntry } from "./staff-directory.js";
export { loadPgStaffDirectory } from "./staff-directory.js";
export type { LocalRuntime, LocalRuntimeMode } from "./runtime-types.js";

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
  csrfProofSigner: CsrfProofSigner,
  pendingStore: PendingActionStore = processPendingActionStore,
  proofStore: StepUpProofStore = processStepUpProofStore,
  resolveStaffRole: StaffRoleResolver,
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
    csrfProofMinter: csrfProofSigner,
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
    resolveStaffRole,
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
  const csrfProofSigner = createCsrfProofSigner(mintRuntimeSecret());

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
  const pricingStore = createMemoryPricingPolicyStore();
  // Memory runtime seeds the same demo customers used by the customer store.
  const memberDeps = createMemoryMemberDeps(DEMO_CUSTOMERS.map((row) => row.customer_id));
  const customerStore = createMemoryCustomerStore(DEMO_CUSTOMERS, memberDeps.customerMerge);
  // Cash top-ups share the member store so stats include expected cash (ADR-22 §1.2).
  const statsSource = createOrderBackedStatsQuery(orderStore, memberDeps.store);
  const shiftStore = createMemoryShiftStore();
  const printStore = createMemoryPrintJobStore({
    loadSnapshot: async (orderId) => {
      const order = await orderStore.getOrder(LOCAL_PROFILE.orgId, LOCAL_PROFILE.storeId, orderId);
      if (order === null) return null;
      const payments =
        orderStore.listPayments === undefined
          ? Object.freeze([])
          : await orderStore.listPayments(LOCAL_PROFILE.orgId, LOCAL_PROFILE.storeId, orderId);
      return snapshotFromOrder({
        order,
        storeName: LOCAL_PROFILE.storeName,
        storePhone: null,
        payments,
      });
    },
  });
  const photoStore = createMemoryPhotoStore();
  const accountingSource = createMemoryAccountingSource();
  const staffAccess = createLocalMemoryStaffAccessDeps(store);
  return Object.freeze({
    mode: "memory" as const,
    identity: buildIdentityDeps(
      store,
      passwordPort,
      accessTokenSecret,
      csrfProofSigner,
      processPendingActionStore,
      processStepUpProofStore,
      resolveMemoryStaffRole,
    ),
    platform: buildPlatform("memory"),
    pricing: Object.freeze({ store: pricingStore }),
    order: Object.freeze({
      store: orderStore,
      pricing: pricingStore,
      customer: customerStore,
      catalog: createMemoryCatalogStore(),
      timeZone: LOCAL_PROFILE.timezone,
      isBusinessDayClosed: async (businessDate: string) =>
        (await shiftStore.getByBusinessDate(
          LOCAL_PROFILE.orgId,
          LOCAL_PROFILE.storeId,
          businessDate,
        )) !== null,
    }),
    catalog: Object.freeze({ store: createMemoryCatalogStore() }),
    print: Object.freeze({ store: printStore }),
    printDispatch: null,
    stats: Object.freeze({ source: statsSource, timeZone: LOCAL_PROFILE.timezone }),
    customer: Object.freeze({ store: customerStore }),
    shift: Object.freeze({
      store: shiftStore,
      stats: statsSource,
      timeZone: LOCAL_PROFILE.timezone,
    }),
    reconciliation: createMemoryReconciliationDeps(orderStore, shiftStore, printStore),
    accounting: Object.freeze({
      source: accountingSource,
      timeZone: LOCAL_PROFILE.timezone,
    }),
    reporting: createMemoryReportingDeps(accountingSource, LOCAL_PROFILE.timezone),
    photo: Object.freeze({ store: photoStore }),
    fulfillment: Object.freeze({ store: createMemoryFulfillmentStore() }),
    staffAccess,
    member: memberDeps,
    notification: Object.freeze({ store: createMemoryNotificationStore({ orderStore }) }),
    edgeAuthority: createMemoryRuntimeAuthority(accessTokenSecret),
    accessTokenSecret,
    csrfProofSigner,
    staffDirectory: LOCAL_MEMORY_STAFF_DIRECTORY,
    pendingStore: processPendingActionStore,
    stepUpProofStore: processStepUpProofStore,
    idempotencyStore: new MemoryIdempotencyStore(),
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
  env: NodeJS.ProcessEnv = process.env,
): Promise<LocalRuntime> {
  const csrfProofSigner = createCsrfProofSigner(config.csrfProofSecret);
  const spoolDir = parseLocalPrintSpoolDir(env);
  const printSpool = spoolDir === null ? null : await createFileSpool({ rootPath: spoolDir });
  const appPool = dependencies.createPool({ connectionString });
  let pgStaffDirectory: readonly LocalStaffDirectoryEntry[];
  let photo: PhotoHandlerDeps;
  try {
    await dependencies.assertReady(appPool, expectedDemoOnly);
    pgStaffDirectory = freezeStaffDirectory(await dependencies.loadStaffDirectory(appPool));
    photo = await preparePgPhotoDeps(
      appPool,
      parseLocalPhotoStoreDir(env),
      LOCAL_PROFILE.orgId,
      LOCAL_PROFILE.storeId,
    );
  } catch (error) {
    return closeFailedPgPool(appPool, error);
  }

  const store = createPgIdentityStore(appPool);
  const passwordPort = createPasswordPort();
  const orderStore = createPgOrderStore(appPool);
  const pricingStore = createPgPricingPolicyStore(appPool);
  const customerStore = createPgCustomerStore(appPool, { orgId: LOCAL_PROFILE.orgId });
  const statsSource = createPgStatsQuery(appPool);
  const shiftStore = createPgShiftStore(appPool, {
    orgId: LOCAL_PROFILE.orgId,
    storeId: LOCAL_PROFILE.storeId,
  });
  const printStore = createPgPrintJobStore(appPool, {
    orgId: LOCAL_PROFILE.orgId,
    storeId: LOCAL_PROFILE.storeId,
  });
  const printDispatch = createPgPrintDispatchService(appPool, {
    privateKey: deriveEdgeAuthorityKeyPair(config.accessTokenSecret).privateKey,
  });
  const accountingSource = createPgAccountingSource();
  const pendingStore = createPgPendingActionStore(appPool);
  const stepUpProofStore = createPgStepUpProofStore(appPool);
  return Object.freeze({
    mode: "pg" as const,
    identity: buildIdentityDeps(
      store,
      passwordPort,
      config.accessTokenSecret,
      csrfProofSigner,
      pendingStore,
      stepUpProofStore,
      createPgStaffRoleResolver(appPool, dependencies.loadStaffDirectory),
    ),
    platform: buildPlatform("sql"),
    pricing: Object.freeze({ store: pricingStore }),
    order: Object.freeze({
      store: orderStore,
      pricing: pricingStore,
      customer: customerStore,
      catalog: createPgCatalogStore(appPool, {
        orgId: LOCAL_PROFILE.orgId,
        storeId: LOCAL_PROFILE.storeId,
      }),
      timeZone: LOCAL_PROFILE.timezone,
      lockBusinessDay: acquirePgBusinessDayLock,
      isBusinessDayClosed: async (businessDate: string) =>
        (await shiftStore.getByBusinessDate(
          LOCAL_PROFILE.orgId,
          LOCAL_PROFILE.storeId,
          businessDate,
        )) !== null,
    }),
    catalog: Object.freeze({
      store: createPgCatalogStore(appPool, {
        orgId: LOCAL_PROFILE.orgId,
        storeId: LOCAL_PROFILE.storeId,
      }),
    }),
    print: Object.freeze({
      store: printStore,
      // Signed jobs are excluded from legacy spool claims; no mock worker starts.
      ...(printSpool === null
        ? {}
        : {
            spool: printSpool,
            workerId: "local-server",
          }),
    }),
    printDispatch,
    stats: Object.freeze({ source: statsSource, timeZone: LOCAL_PROFILE.timezone }),
    customer: Object.freeze({ store: customerStore }),
    shift: Object.freeze({
      store: shiftStore,
      stats: statsSource,
      timeZone: LOCAL_PROFILE.timezone,
      lockBusinessDay: acquirePgBusinessDayLock,
    }),
    reconciliation: createPgReconciliationDeps(),
    accounting: Object.freeze({
      source: accountingSource,
      timeZone: LOCAL_PROFILE.timezone,
    }),
    reporting: createPgReportingDeps(accountingSource, LOCAL_PROFILE.timezone),
    photo,
    fulfillment: Object.freeze({ store: createPgFulfillmentStore(appPool) }),
    staffAccess: createPgStaffAccessDeps(),
    member: createPgMemberDeps(),
    notification: Object.freeze({ store: createPgNotificationStore() }),
    edgeAuthority: createPgRuntimeAuthority(appPool, config.accessTokenSecret),
    accessTokenSecret: config.accessTokenSecret,
    csrfProofSigner,
    staffDirectory: pgStaffDirectory,
    pendingStore,
    stepUpProofStore,
    idempotencyStore: createPgIdempotencyStore(appPool),
    pool: appPool,
    store: null,
  });
}

/**
 * Select only an explicitly configured app-role PostgreSQL runtime.
 * Tests that need process memory must call createMemoryLocalRuntime directly.
 */
export async function createLocalRuntime(
  env: NodeJS.ProcessEnv = process.env,
): Promise<LocalRuntime> {
  const hostConfig = parseLocalHostConfig(env);
  const databaseUrl = resolveRuntimeDatabaseUrl(env);
  if (databaseUrl === null) {
    throw new Error(RUNTIME_DATABASE_URL_REQUIRED);
  }
  return createPgLocalRuntime(
    databaseUrl,
    env.LAUNDRY_LOCAL_DEMO === "1",
    Object.freeze({
      ...hostConfig,
      ...parseLocalSigningSecrets(env),
    }),
    defaultPgRuntimeDependencies,
    env,
  );
}

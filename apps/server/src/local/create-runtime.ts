import { createMemoryAccountingSource, createPgAccountingSource } from "../accounting/index.js";
import { createMemoryReportingDeps, createPgReportingDeps } from "../reporting/index.js";
import { createCsrfProofSigner } from "../auth/csrf.js";
import * as edgeRuntime from "../edge/runtime-authority.js";
import { MemoryIdempotencyStore } from "../bus/idempotency.js";
import { createPgIdempotencyStore } from "../bus/pg-idempotency.js";
import { createMemoryIdentityStore } from "../identity/memory-store.js";
import { createPgIdentityStore } from "../identity/pg-store.js";
import { createPgStepUpProofStore } from "../identity/pg-step-up-proof-store.js";
import {
  createMemoryStepUpApproverAuthority,
  verifyPgStepUpApproverAuthority,
} from "../identity/step-up-approver-authority.js";
import { createPasswordPort } from "../identity/password.js";
import type { StaffRecord, Uuid } from "../identity/types.js";
import { createMemoryCatalogStore } from "../catalog/memory-catalog.js";
import { createPgCatalogStore } from "../catalog/pg-catalog-store.js";
import { createMemoryCustomerStore, DEMO_CUSTOMERS } from "../customer/memory-store.js";
import { createPgCustomerStore } from "../customer/pg-customer-store.js";
import { createMemoryCustomerProfileStore } from "../customer-profile/memory-store.js";
import { createPgCustomerProfileStore } from "../customer-profile/pg-store.js";
import { createCustomerOrderPolicyResolver } from "../customer-profile/order-policy.js";
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
import * as ownerOperations from "./runtime-owner-operations.js";
import * as notificationRuntime from "./runtime-notification.js";
import { createMemoryShiftStore } from "../shift/memory-store.js";
import { createPgShiftStore } from "../shift/pg-shift-store.js";
import { acquirePgBusinessDayLock } from "../workday/business-day-lock.js";
import type { PhotoHandlerDeps } from "../photo/handlers.js";
import { createMemoryPhotoStore } from "../photo/memory-store.js";
import { preparePgPhotoDeps } from "../photo/runtime-files.js";
import { processPendingActionStore } from "../pending-actions/process-store.js";
import { createPgPendingActionStore } from "../pending-actions/pg-store.js";
import { processStepUpProofStore } from "../policy/step-up-proof-store.js";
import {
  createMemoryFulfillmentRuntime,
  createPgFulfillmentRuntime,
} from "../fulfillment/runtime.js";
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
  parseNotificationProviderMode,
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
import { createMemoryStaffRoleResolver, createPgStaffRoleResolver } from "./staff-role-resolver.js";
import * as recon from "./runtime-reconciliation.js";
import type { LocalRuntime } from "./runtime-types.js";
import { createMemoryMemberRuntimes, createPgMemberRuntimes } from "./runtime-member-benefits.js";
import { buildIdentityDeps } from "./runtime-identity.js";
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
  loadStaffDirectory: typeof loadPgStaffDirectory;
}>;
const defaultPgRuntimeDependencies: CreatePgLocalRuntimeDependencies = Object.freeze({
  createPool: createPgPool,
  assertReady: assertLocalBootstrapReady,
  loadStaffDirectory: loadPgStaffDirectory,
});
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
  const memberRuntimes = createMemoryMemberRuntimes(DEMO_CUSTOMERS, orderStore);
  const customerStore = createMemoryCustomerStore(DEMO_CUSTOMERS, memberRuntimes.customerMerge);
  const customerProfileStore = createMemoryCustomerProfileStore(customerStore);
  const statsSource = createOrderBackedStatsQuery(orderStore, memberRuntimes.member.store);
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
  const platform = buildPlatform("memory");
  const isBusinessDayClosed = async (businessDate: string): Promise<boolean> =>
    (await shiftStore.getByBusinessDate(
      LOCAL_PROFILE.orgId,
      LOCAL_PROFILE.storeId,
      businessDate,
    )) !== null;
  return Object.freeze({
    mode: "memory" as const,
    identity: buildIdentityDeps(
      store,
      passwordPort,
      accessTokenSecret,
      csrfProofSigner,
      processPendingActionStore,
      processStepUpProofStore,
      createMemoryStaffRoleResolver(staffAccess.store, store.staff),
    ),
    platform,
    pricing: Object.freeze({ store: pricingStore }),
    order: Object.freeze({
      store: orderStore,
      pricing: pricingStore,
      customer: customerStore,
      customerPolicy: createCustomerOrderPolicyResolver(
        customerProfileStore,
        memberRuntimes.memberBenefits,
      ),
      catalog: createMemoryCatalogStore(),
      timeZone: LOCAL_PROFILE.timezone,
      isBusinessDayClosed,
    }),
    catalog: Object.freeze({ store: createMemoryCatalogStore() }),
    print: Object.freeze({ store: printStore, order: orderStore }),
    printDispatch: null,
    stats: Object.freeze({ source: statsSource, timeZone: LOCAL_PROFILE.timezone }),
    customer: Object.freeze({ store: customerStore, profile: customerProfileStore }),
    customerProfile: Object.freeze({ store: customerProfileStore }),
    shift: Object.freeze({
      store: shiftStore,
      stats: statsSource,
      timeZone: LOCAL_PROFILE.timezone,
    }),
    reconciliation: recon.createMemoryReconciliationDeps(orderStore, shiftStore, printStore),
    accounting: Object.freeze({
      source: accountingSource,
      timeZone: LOCAL_PROFILE.timezone,
    }),
    reporting: createMemoryReportingDeps(accountingSource, LOCAL_PROFILE.timezone),
    photo: Object.freeze({ store: photoStore }),
    fulfillment: createMemoryFulfillmentRuntime({
      order: orderStore,
      timeZone: LOCAL_PROFILE.timezone,
      isBusinessDayClosed,
      features: platform.features,
    }),
    staffAccess,
    storeManagement: ownerOperations.createMemoryStoreManagementDeps(),
    member: memberRuntimes.member,
    memberBenefits: memberRuntimes.memberBenefits,
    notification: notificationRuntime.createMemoryNotificationRuntime(orderStore),
    edgeAuthority: edgeRuntime.createMemoryRuntimeAuthority(accessTokenSecret),
    accessTokenSecret,
    csrfProofSigner,
    staffDirectory: LOCAL_MEMORY_STAFF_DIRECTORY,
    pendingStore: processPendingActionStore,
    stepUpProofStore: processStepUpProofStore,
    stepUpApproverAuthority: createMemoryStepUpApproverAuthority(staffAccess.store),
    idempotencyStore: new MemoryIdempotencyStore(),
    pool: null,
    store,
  });
}
export async function createPgLocalRuntime(
  connectionString: string,
  expectedDemoOnly: boolean,
  config: LocalServerConfig = parseLocalServerConfig(process.env),
  dependencies: CreatePgLocalRuntimeDependencies = defaultPgRuntimeDependencies,
  env: NodeJS.ProcessEnv = process.env,
): Promise<LocalRuntime> {
  const csrfProofSigner = createCsrfProofSigner(config.csrfProofSecret);
  const notificationMode = parseNotificationProviderMode(env);
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
  const memberRuntimes = createPgMemberRuntimes(orderStore);
  const pricingStore = createPgPricingPolicyStore(appPool);
  const customerStore = createPgCustomerStore(appPool, { orgId: LOCAL_PROFILE.orgId });
  const customerProfileStore = createPgCustomerProfileStore(appPool, {
    orgId: LOCAL_PROFILE.orgId,
  });
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
  const isBusinessDayClosed = async (businessDate: string): Promise<boolean> =>
    (await shiftStore.getByBusinessDate(
      LOCAL_PROFILE.orgId,
      LOCAL_PROFILE.storeId,
      businessDate,
    )) !== null;
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
      customerPolicy: createCustomerOrderPolicyResolver(
        customerProfileStore,
        memberRuntimes.memberBenefits,
      ),
      catalog: createPgCatalogStore(appPool, {
        orgId: LOCAL_PROFILE.orgId,
        storeId: LOCAL_PROFILE.storeId,
      }),
      timeZone: LOCAL_PROFILE.timezone,
      lockBusinessDay: acquirePgBusinessDayLock,
      isBusinessDayClosed,
    }),
    catalog: Object.freeze({
      store: createPgCatalogStore(appPool, {
        orgId: LOCAL_PROFILE.orgId,
        storeId: LOCAL_PROFILE.storeId,
      }),
    }),
    print: Object.freeze({
      store: printStore,
      order: orderStore,
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
    customer: Object.freeze({ store: customerStore, profile: customerProfileStore }),
    customerProfile: Object.freeze({ store: customerProfileStore }),
    shift: Object.freeze({
      store: shiftStore,
      stats: statsSource,
      timeZone: LOCAL_PROFILE.timezone,
      lockBusinessDay: acquirePgBusinessDayLock,
    }),
    reconciliation: recon.createPgReconciliationDeps(),
    accounting: ownerOperations.createPgAccountingDeps(accountingSource),
    reporting: createPgReportingDeps(accountingSource, LOCAL_PROFILE.timezone),
    photo,
    fulfillment: createPgFulfillmentRuntime(appPool, {
      order: orderStore,
      timeZone: LOCAL_PROFILE.timezone,
      isBusinessDayClosed,
    }),
    staffAccess: createPgStaffAccessDeps(),
    storeManagement: ownerOperations.createPgStoreManagementDeps(),
    member: memberRuntimes.member,
    memberBenefits: memberRuntimes.memberBenefits,
    notification: notificationRuntime.createPgNotificationRuntime(appPool, notificationMode),
    edgeAuthority: edgeRuntime.createPgRuntimeAuthority(appPool, config.accessTokenSecret),
    accessTokenSecret: config.accessTokenSecret,
    csrfProofSigner,
    staffDirectory: pgStaffDirectory,
    pendingStore,
    stepUpProofStore,
    stepUpApproverAuthority: verifyPgStepUpApproverAuthority,
    idempotencyStore: createPgIdempotencyStore(appPool),
    pool: appPool,
    store: null,
  });
}
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

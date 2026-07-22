/**
 * Local-dev demo seed re-exports (memory default + PG via createLocalRuntime).
 * Credentials are LOCAL ONLY — password `demo`, PIN `1234`.
 */

export {
  createLocalRuntime,
  createMemoryLocalRuntime,
  createPgLocalRuntime,
  DEMO_ADMIN_ID,
  DEMO_ORG_ID,
  DEMO_PASSWORD,
  DEMO_PIN,
  DEMO_STAFF_A_ID,
  DEMO_STAFF_B_ID,
  DEMO_STORE_ID,
  type LocalRuntime,
  type LocalRuntimeMode,
  type LocalStaffDirectoryEntry,
} from "./create-runtime.js";

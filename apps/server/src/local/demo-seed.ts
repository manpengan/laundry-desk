/** Compatibility exports for the local runtime while explicit bootstrap is introduced. */

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
export {
  parseLocalHostConfig,
  parseLocalServerConfig,
  parseLocalSigningSecrets,
  type LocalHostConfig,
  type LocalServerConfig,
  type LocalSigningSecrets,
} from "./config.js";
export { LOCAL_PROFILE, type LocalProfile } from "./profile.js";

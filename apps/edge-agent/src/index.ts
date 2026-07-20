/**
 * Library surface for unit tests and future adapters.
 * Runtime entry is `main.ts` (package.json `"main"`).
 */
export { mimeFor } from "./lib/mime.js";
export {
  isSpaManifest,
  loadManifest,
  sha256Hex,
  verifySpaIntegrity,
  type SpaManifest,
} from "./lib/integrity.js";
export { resolveSpaPath } from "./lib/spa-path.js";
export { isValidAppSender } from "./lib/sender.js";
export {
  APP_ENTRY_URL,
  APP_HOST,
  APP_SCHEME,
  IPC_CHANNELS,
  SECURITY_WEB_PREFERENCES,
} from "./lib/security-prefs.js";
export {
  manifestPathFromSpaRoot,
  packageRootFromModuleUrl,
  preloadPathFromDistDir,
  spaRootFromPackageRoot,
} from "./lib/paths.js";
export { createAppProtocolHandler } from "./protocol.js";
